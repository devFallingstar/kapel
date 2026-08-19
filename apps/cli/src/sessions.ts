import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeTask } from "@agent/coding-agent";
import { findAgentDir, MODEL_TEXT_DELTA_EVENT } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import type { ChatSessionRecord, RunStatus } from "@agent/session";
import {
  defaultSessionDbPath,
  resolveChatSessionReference,
  SqliteSessionStore,
} from "@agent/session";
import {
  consoleOutput,
  formatTable,
  type OrchestrationOutput,
} from "./plan.js";

/**
 * Fans one event stream out to several sinks.
 *
 * Every sink is called for every event, in order, and a sink that throws (or
 * rejects) is skipped rather than allowed to take the run down with it:
 * persistence and rendering are observers of a run, never participants in it.
 * Sinks that answer synchronously — the renderers, the TUI, the synchronous
 * SQLite store — have therefore all run by the time `emit` returns, which is
 * what keeps stored event order equal to emitted event order.
 */
export function fanOutSink(
  ...sinks: readonly (EventSink | undefined)[]
): EventSink {
  const active = sinks.filter((sink): sink is EventSink => sink !== undefined);
  return {
    emit(event: AgentEvent): void | Promise<void> {
      const pending: Promise<void>[] = [];
      for (const sink of active) {
        try {
          const settled = sink.emit(event);
          if (settled !== undefined) {
            pending.push(
              Promise.resolve(settled).then(
                () => undefined,
                () => undefined,
              ),
            );
          }
        } catch {
          // best-effort: an observer's failure is not the run's failure
        }
      }
      if (pending.length === 0) return undefined;
      return Promise.all(pending).then(() => undefined);
    },
  };
}

/**
 * An {@link EventSink} that tees events into `store`, swallowing store errors.
 *
 * Streamed text deltas are the one thing that does not go in: they arrive once
 * per token-ish chunk, so recording them would add thousands of rows per turn
 * to a database whose whole purpose is being replayable later — and they carry
 * nothing that is not already in the turn's own `model.turn.completed` event,
 * which is what `kapel runs`/`kapel explain` read back.
 */
export function storeSink(store: SqliteSessionStore): EventSink {
  return {
    emit(event: AgentEvent): void | Promise<void> {
      if (event.type === MODEL_TEXT_DELTA_EVENT) return undefined;
      return store.appendEvent(event).then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

/** Path of the session database for a workspace, whether or not it exists. */
export function sessionDbPathFor(workspacePath: string): string {
  return defaultSessionDbPath(path.join(path.resolve(workspacePath), ".agent"));
}

/**
 * Opens the session store for a workspace, or `undefined` when there is none
 * to open.
 *
 * A run persists itself only in a project that has been `kapel init`-ed: the
 * database lives beside the rest of `.agent`, and creating that directory
 * behind the user's back to hold a database is not this command's business.
 * A store that cannot be opened at all (a locked or corrupt file, a read-only
 * checkout) also yields `undefined` — losing the history of a run is better
 * than refusing to do the run.
 */
export async function openRunStore(
  workspacePath: string,
): Promise<SqliteSessionStore | undefined> {
  const agentDir = await findAgentDir(path.resolve(workspacePath));
  if (agentDir === undefined) return undefined;
  try {
    return new SqliteSessionStore({ path: defaultSessionDbPath(agentDir) });
  } catch {
    return undefined;
  }
}

/**
 * Opens the session store of a workspace that is expected to already have one,
 * for the read-only commands (`runs`, `explain`, `resume`).
 *
 * Unlike {@link openRunStore} this never creates the file: a missing database
 * means "no runs recorded here", which those commands report as such instead
 * of showing an empty listing of a database they just created.
 */
export function openExistingRunStore(
  workspacePath: string,
): SqliteSessionStore | undefined {
  const dbPath = sessionDbPathFor(workspacePath);
  if (!existsSync(dbPath)) return undefined;
  try {
    return new SqliteSessionStore({ path: dbPath });
  } catch {
    return undefined;
  }
}

/**
 * The status a finished run is recorded with: `cancelled` when the run was
 * aborted (Ctrl-C), otherwise `completed` only if every task completed —
 * anything less means the objective was not delivered.
 */
export function runStatusFor(
  tasks: readonly RuntimeTask[],
  aborted: boolean,
): RunStatus {
  if (aborted) return "cancelled";
  return tasks.every((task) => task.status === "completed")
    ? "completed"
    : "failed";
}

/**
 * Runs a store write for its side effect only, swallowing any failure.
 *
 * Every write a run makes to its session database is like this: the run is
 * the product, the recording of it is not, so a store that has gone away
 * mid-run degrades to a run with a truncated history.
 */
export async function bestEffort(
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch {
    // best-effort
  }
}

/** Best-effort `setRunStatus`: a store that refuses the write is ignored. */
export async function recordRunStatus(
  store: SqliteSessionStore | undefined,
  runId: string,
  status: RunStatus,
): Promise<void> {
  if (store === undefined) return;
  await bestEffort(() => store.setRunStatus(runId, status));
}

/** Best-effort `close`, for the `finally` blocks that own a store's lifetime. */
export function closeRunStore(store: SqliteSessionStore | undefined): void {
  if (store === undefined) return;
  try {
    store.close();
  } catch {
    // best-effort
  }
}

/** ISO-8601 rendering of an epoch-millisecond timestamp, for stored records. */
export function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// --- `kapel sessions` / `kapel sessions fork` -------------------------------

/** How many characters of a session id identify it in `kapel sessions` output. */
const SHORT_ID = 8;

function shortSessionId(id: string): string {
  return id.slice(0, SHORT_ID);
}

/** How many sessions `kapel sessions` lists when `--limit` is not given. */
export const DEFAULT_SESSIONS_LIST_LIMIT = 20;

export interface SessionsListCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  /** Defaults to {@link DEFAULT_SESSIONS_LIST_LIMIT}. */
  readonly limit?: number;
}

export interface SessionsCommandDeps {
  readonly output?: OrchestrationOutput;
}

function sessionRow(
  record: ChatSessionRecord,
  showName: boolean,
): readonly string[] {
  const base = [shortSessionId(record.id)];
  if (showName) base.push(record.name ?? "");
  base.push(
    isoTime(record.updatedAt),
    String(record.messageCount),
    record.title === "" ? "(untitled)" : record.title,
  );
  return base;
}

/**
 * Implements `kapel sessions`: this workspace's interactive chat sessions,
 * newest-touched first — the `kapel runs` of the chat half of `sessions.db`.
 *
 * A workspace with no session database is not an error — it just has not
 * recorded a chat session yet (or every `kapel chat` here used `--no-save`) —
 * so the empty listing says that instead of failing.
 */
export async function runSessionsListCommand(
  options: SessionsListCommandOptions,
  deps: SessionsCommandDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const store = openExistingRunStore(options.cwd);

  if (store === undefined) {
    if (options.json) output.log(JSON.stringify([]));
    else {
      output.log(
        `No chat sessions recorded yet — nothing at ${sessionDbPathFor(options.cwd)}.`,
      );
    }
    return 0;
  }

  try {
    const records = await store.listChatSessions(path.resolve(options.cwd), {
      limit: options.limit ?? DEFAULT_SESSIONS_LIST_LIMIT,
    });

    if (options.json) {
      output.log(
        JSON.stringify(
          records.map((record) => ({
            id: record.id,
            ...(record.name === undefined ? {} : { name: record.name }),
            title: record.title,
            ...(record.modelAlias === undefined
              ? {}
              : { modelAlias: record.modelAlias }),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            messageCount: record.messageCount,
          })),
        ),
      );
      return 0;
    }

    if (records.length === 0) {
      output.log("No chat sessions recorded yet.");
      return 0;
    }

    const showName = records.some((record) => record.name !== undefined);
    const headers = showName
      ? ["ID", "NAME", "UPDATED", "MSGS", "TITLE"]
      : ["ID", "UPDATED", "MSGS", "TITLE"];
    for (const line of formatTable(
      headers,
      records.map((record) => sessionRow(record, showName)),
    )) {
      output.log(line);
    }
    return 0;
  } finally {
    closeRunStore(store);
  }
}

export interface SessionsForkCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  /** The session to fork, as typed by the user: an id, an id prefix, or a name. */
  readonly session: string;
  /** Label for the new session; omit to leave it unnamed. */
  readonly name?: string;
}

/**
 * Implements `kapel sessions fork <id|name> [--name <name>]`: resolves
 * `options.session` the same way `--session` does (id, then id prefix, then
 * exact name — see `resolveChatSessionReference`) and copies it into a new,
 * independent session via `SqliteSessionStore#forkChatSession`.
 */
export async function runSessionsForkCommand(
  options: SessionsForkCommandOptions,
  deps: SessionsCommandDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const store = openExistingRunStore(options.cwd);

  if (store === undefined) {
    output.error(
      `No chat sessions recorded yet — nothing at ${sessionDbPathFor(options.cwd)}.`,
    );
    return 1;
  }

  try {
    const records = await store.listChatSessions(path.resolve(options.cwd));
    const resolved = resolveChatSessionReference(records, options.session, {
      onNote: (note) => output.error(note),
    });
    if ("error" in resolved) {
      output.error(resolved.error);
      return 1;
    }

    const newId = await store.forkChatSession(
      resolved.record.id,
      options.name === undefined ? {} : { name: options.name },
    );

    if (options.json) {
      output.log(
        JSON.stringify({
          id: newId,
          forkedFrom: resolved.record.id,
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      );
    } else {
      const label = options.name === undefined ? "" : ` "${options.name}"`;
      output.log(
        `Forked ${shortSessionId(resolved.record.id)} → ${shortSessionId(newId)}${label}`,
      );
    }
    return 0;
  } finally {
    closeRunStore(store);
  }
}
