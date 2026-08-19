import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeTask } from "@agent/coding-agent";
import { findAgentDir, MODEL_TEXT_DELTA_EVENT } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import type { RunStatus } from "@agent/session";
import { defaultSessionDbPath, SqliteSessionStore } from "@agent/session";

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
