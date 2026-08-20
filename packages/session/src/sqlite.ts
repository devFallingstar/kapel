import { join } from "node:path";
// Type-only, on the same footing as the `@agent/orchestration` import below:
// the workspace package resolves through the hoisted `node_modules/@agent/*`
// links, and the import is erased at emit, so nothing is required at runtime.
import type { ModelMessage } from "@agent/ai";
import type { ExecutionPlan, TaskResult } from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent } from "@agent/protocol";
import Database from "better-sqlite3";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { RunRecord, SessionStore } from "./index.js";
import {
  BOOTSTRAP_DDL,
  chatMessages,
  chatSessions,
  eventRowid,
  events,
  type RunStatus,
  runs,
  type TaskResultStatus,
  taskResults,
} from "./schema.js";

export type { RunStatus, TaskResultStatus } from "./schema.js";

/** Conventional location of the session database inside an agent home dir. */
export function defaultSessionDbPath(agentDir: string): string {
  return join(agentDir, "sessions.db");
}

export interface SqliteSessionStoreOptions {
  /** Filesystem path, or `":memory:"` for an ephemeral database. */
  readonly path: string;
}

/** A run as it was persisted, with its policy (and plan, if saved) revived. */
export interface PersistedRun {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: RunStatus;
  readonly policy: OrchestrationPolicy;
  readonly plan?: ExecutionPlan;
}

export interface RunTaskCounts {
  readonly completed: number;
  readonly failed: number;
  /**
   * Tasks whose work exists but did not fully land — a worker that came back
   * `partial`, or one whose branch could not be merged. Counted in its own
   * bucket rather than folded into `completed` or `failed`, because a run
   * whose partial tasks were invisible reported totals that did not add up
   * ("0/2 (1 cancelled)" for a run with a partial and a cancellation).
   */
  readonly partial: number;
  readonly cancelled: number;
  /** Total planned tasks — only known once a plan has been saved. */
  readonly total?: number;
}

/** Listing-shaped view of a run: no policy, no plan, just progress. */
export interface PersistedRunSummary {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: number;
  readonly status: RunStatus;
  readonly taskCounts: RunTaskCounts;
}

export interface PersistedTaskResult {
  readonly taskId: string;
  readonly agent?: string;
  readonly attempts: number;
  readonly status: TaskResultStatus;
  readonly result?: TaskResult;
}

export interface ListRunsOptions {
  readonly limit?: number;
}

/** A stored interactive chat session, as listed or resumed by the CLI. */
export interface ChatSessionRecord {
  readonly id: string;
  /**
   * The workspace directory this conversation belongs to, exactly as it was
   * written. The store never normalizes it — callers should `path.resolve`
   * before writing and before filtering, since matching is verbatim.
   */
  readonly workspacePath: string;
  readonly title: string;
  /**
   * User-given label (`/name`, `--name`), distinct from the auto-derived
   * `title`. Absent when the session was never named.
   */
  readonly name?: string;
  readonly modelAlias?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
}

/** One transcript message plus its position, which is also its identity. */
export interface PersistedChatMessage {
  readonly seq: number;
  readonly message: ModelMessage;
}

export interface NewChatSession {
  readonly id: string;
  readonly workspacePath: string;
  readonly title: string;
  /** Optional label to start the session with (e.g. a `--name` flag). */
  readonly name?: string;
  readonly modelAlias?: string;
  readonly createdAt: number;
}

export interface ListChatSessionsOptions {
  readonly limit?: number;
}

/** Options for {@link SqliteSessionStore.forkChatSession}. */
export interface ForkChatSessionOptions {
  /** Label for the new session. Omit to leave it unnamed. */
  readonly name?: string;
}

/** A chat session read back whole: its metadata and its ordered transcript. */
export interface ChatSessionTranscript {
  readonly record: ChatSessionRecord;
  readonly messages: readonly ModelMessage[];
}

const CHAT_TITLE_MAX = 60;

/**
 * Derives a session title from the first thing a user typed: first line,
 * trimmed, and truncated to 60 characters with an ellipsis. Used by the CLI
 * for auto-titling, so it never throws and always returns something short.
 */
export function chatTitleFrom(instruction: string): string {
  const firstLine = (instruction.split("\n")[0] ?? "").trim();
  if (firstLine.length <= CHAT_TITLE_MAX) return firstLine;
  // The ellipsis is part of the budget: the result is never over the cap.
  return `${firstLine.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}…`;
}

/** Everything a resumed orchestration needs to pick a run back up. */
export interface RunReconstruction {
  readonly run: PersistedRun;
  /** Successful task results, keyed by task id. */
  readonly completed: ReadonlyMap<string, TaskResult>;
  /** Planned tasks with no successful result yet, in plan order. */
  readonly incompleteTaskIds: readonly string[];
}

/** `JSON.parse` that yields `undefined` instead of throwing on bad input. */
function parseJson<T>(raw: string | null | undefined): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** `JSON.stringify` that yields `null` for values it cannot represent. */
function stringifyJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : encoded;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asAttempts(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

const TASK_RESULT_STATUSES = new Set<string>([
  "pending",
  "running",
  "success",
  "failed",
  "partial",
  "cancelled",
]);

function toTaskResultStatus(value: unknown): TaskResultStatus | undefined {
  return typeof value === "string" && TASK_RESULT_STATUSES.has(value)
    ? (value as TaskResultStatus)
    : undefined;
}

/** The per-event patch `appendEvent` applies to `task_results`, if any. */
interface TaskResultPatch {
  readonly agent?: string;
  readonly attempts?: number;
  readonly status?: TaskResultStatus;
  /** `null` clears the stored result; `undefined` leaves it untouched. */
  readonly resultJson?: string | null;
}

/**
 * Derives the `task_results` update implied by an event. Returns `undefined`
 * for events that say nothing about task state. Every field is probed
 * defensively: malformed or partial `data` degrades to fewer updates rather
 * than an error, because the event stream is not a validated contract.
 */
function taskResultPatchFor(event: AgentEvent): TaskResultPatch | undefined {
  const data = asRecord(event.data);
  switch (event.type) {
    case "task.started": {
      const agent = asString(data?.agent);
      const attempts = asAttempts(data?.attempts) ?? asAttempts(data?.attempt);
      return {
        status: "running",
        ...(agent === undefined ? {} : { agent }),
        ...(attempts === undefined ? {} : { attempts }),
      };
    }
    case "task.completed": {
      const agent = asString(data?.agent);
      const attempts = asAttempts(data?.attempts) ?? asAttempts(data?.attempt);
      const result = asRecord(data?.result);
      const status = toTaskResultStatus(result?.status);
      return {
        ...(status === undefined ? {} : { status }),
        ...(agent === undefined ? {} : { agent }),
        ...(attempts === undefined ? {} : { attempts }),
        ...(result === undefined ? {} : { resultJson: stringifyJson(result) }),
      };
    }
    case "task.escalated": {
      const agent = asString(data?.to);
      return agent === undefined ? {} : { agent };
    }
    case "task.cancelled":
      return { status: "cancelled" };
    default:
      return undefined;
  }
}

type Db = ReturnType<typeof drizzle>;

/**
 * Adds `chat_sessions.name` to a database that predates it, so a v0.5.0
 * database (created by `BOOTSTRAP_DDL` before the column existed) keeps
 * working instead of failing every chat-session query the moment this store
 * starts selecting a column that isn't there.
 *
 * `BOOTSTRAP_DDL`'s `CREATE TABLE IF NOT EXISTS` only shapes a *new* file —
 * once `chat_sessions` exists, that statement is a no-op regardless of which
 * columns it has, so the column has to be added out-of-band. `PRAGMA
 * table_info` is the guard: it lists the table's actual columns, so the
 * `ALTER TABLE` only runs the one time it is needed and is a no-op on every
 * later open (including brand new databases, which already have the column
 * from `BOOTSTRAP_DDL` and so skip the `ALTER TABLE` too).
 */
function ensureChatSessionsNameColumn(sqlite: Database.Database): void {
  const columns = sqlite.pragma("table_info(chat_sessions)") as ReadonlyArray<{
    readonly name: string;
  }>;
  const hasName = columns.some((column) => column.name === "name");
  if (!hasName) {
    sqlite.exec("ALTER TABLE chat_sessions ADD COLUMN name TEXT");
  }
  // Safe to (re)create unconditionally: by this point the column always
  // exists, either from BOOTSTRAP_DDL on a new database or the ALTER TABLE
  // just above on an old one.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS chat_sessions_name_idx ON chat_sessions (name)",
  );
}

/**
 * SQLite-backed {@link SessionStore}. Runs, their event stream and a rolling
 * per-task summary live in one file, so a run can be inspected or resumed
 * after the process that produced it is gone.
 *
 * better-sqlite3 is synchronous, which makes every method here atomic with
 * respect to other async contexts in the same process — the promises are a
 * shape adapter, not real concurrency.
 */
export class SqliteSessionStore implements SessionStore {
  readonly #sqlite: Database.Database;
  readonly #db: Db;

  constructor(options: SqliteSessionStoreOptions) {
    this.#sqlite = new Database(options.path);
    if (options.path !== ":memory:") {
      // WAL is meaningless for an in-memory database and errors on some
      // builds; everywhere else it is what makes a second process able to
      // read a run while the first is still writing it.
      this.#sqlite.pragma("journal_mode = WAL");
    }
    this.#sqlite.exec(BOOTSTRAP_DDL);
    ensureChatSessionsNameColumn(this.#sqlite);
    this.#db = drizzle(this.#sqlite);
  }

  // --- SessionStore -------------------------------------------------------

  async createRun(run: RunRecord): Promise<void> {
    this.#db
      .insert(runs)
      .values({
        id: run.id,
        objective: run.objective,
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
        status: "running",
        policyJson: stringifyJson(run.policySnapshot) ?? "null",
        planJson: null,
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Appends an event and folds it into `task_results` in one transaction, so
   * a reader never sees an event whose task summary has not landed yet.
   */
  async appendEvent(event: AgentEvent): Promise<void> {
    const patch =
      event.taskId === undefined ? undefined : taskResultPatchFor(event);
    const taskId = event.taskId;
    this.#db.transaction((tx) => {
      tx.insert(events)
        .values({
          id: event.id,
          runId: event.runId,
          timestamp: event.timestamp,
          type: event.type,
          taskId: event.taskId ?? null,
          workerId: event.workerId ?? null,
          dataJson: stringifyJson(event.data),
        })
        .onConflictDoNothing()
        .run();

      if (patch === undefined || taskId === undefined) return;
      tx.insert(taskResults)
        .values({
          runId: event.runId,
          taskId,
          agent: patch.agent ?? null,
          attempts: patch.attempts ?? 0,
          status: patch.status ?? "pending",
          resultJson: patch.resultJson ?? null,
          updatedAt: event.timestamp,
        })
        .onConflictDoUpdate({
          target: [taskResults.runId, taskResults.taskId],
          set: {
            updatedAt: event.timestamp,
            ...(patch.agent === undefined ? {} : { agent: patch.agent }),
            ...(patch.attempts === undefined
              ? {}
              : { attempts: patch.attempts }),
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(patch.resultJson === undefined
              ? {}
              : { resultJson: patch.resultJson }),
          },
        })
        .run();
    });
  }

  async listEvents(runId: string): Promise<readonly AgentEvent[]> {
    const rows = this.#db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(asc(events.timestamp), asc(eventRowid))
      .all();
    return rows.map(toAgentEvent);
  }

  // --- Extensions ---------------------------------------------------------

  async savePlan(runId: string, plan: ExecutionPlan): Promise<void> {
    this.#db
      .update(runs)
      .set({ planJson: stringifyJson(plan), updatedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();
  }

  async setRunStatus(runId: string, status: RunStatus): Promise<void> {
    this.#db
      .update(runs)
      .set({ status, updatedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();
  }

  async getRun(runId: string): Promise<PersistedRun | undefined> {
    const row = this.#db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .get();
    if (row === undefined) return undefined;
    const policy = parseJson<OrchestrationPolicy>(row.policyJson);
    const plan = parseJson<ExecutionPlan>(row.planJson);
    return {
      id: row.id,
      objective: row.objective,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.status,
      // A corrupt policy blob must not make the run unreadable; callers get
      // an empty object rather than a throw from deep inside a read path.
      policy: policy ?? ({} as OrchestrationPolicy),
      ...(plan === undefined ? {} : { plan }),
    };
  }

  async listRuns(
    options?: ListRunsOptions,
  ): Promise<readonly PersistedRunSummary[]> {
    const limit = options?.limit;
    const base = this.#db
      .select({
        id: runs.id,
        objective: runs.objective,
        createdAt: runs.createdAt,
        status: runs.status,
        planJson: runs.planJson,
      })
      .from(runs)
      .orderBy(desc(runs.createdAt), desc(runs.id));
    const rows =
      limit === undefined ? base.all() : base.limit(Math.max(0, limit)).all();

    return rows.map((row) => {
      const counts = this.#db
        .select({ status: taskResults.status, n: sql<number>`count(*)` })
        .from(taskResults)
        .where(eq(taskResults.runId, row.id))
        .groupBy(taskResults.status)
        .all();
      const by = new Map(counts.map((c) => [c.status, Number(c.n)]));
      const total = parseJson<ExecutionPlan>(row.planJson)?.tasks?.length;
      return {
        id: row.id,
        objective: row.objective,
        createdAt: row.createdAt,
        status: row.status,
        taskCounts: {
          completed: by.get("success") ?? 0,
          failed: by.get("failed") ?? 0,
          partial: by.get("partial") ?? 0,
          cancelled: by.get("cancelled") ?? 0,
          ...(typeof total === "number" ? { total } : {}),
        },
      };
    });
  }

  async taskResults(
    runId: string,
  ): Promise<ReadonlyMap<string, PersistedTaskResult>> {
    const rows = this.#db
      .select()
      .from(taskResults)
      .where(eq(taskResults.runId, runId))
      .orderBy(asc(taskResults.taskId))
      .all();
    const out = new Map<string, PersistedTaskResult>();
    for (const row of rows) {
      const result = parseJson<TaskResult>(row.resultJson);
      out.set(row.taskId, {
        taskId: row.taskId,
        attempts: row.attempts,
        status: row.status,
        ...(row.agent === null ? {} : { agent: row.agent }),
        ...(result === undefined ? {} : { result }),
      });
    }
    return out;
  }

  async taskEvents(
    runId: string,
    taskId: string,
  ): Promise<readonly AgentEvent[]> {
    const rows = this.#db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.taskId, taskId)))
      .orderBy(asc(events.timestamp), asc(eventRowid))
      .all();
    return rows.map(toAgentEvent);
  }

  // --- Chat sessions ------------------------------------------------------

  /**
   * Registers a new conversation. Idempotent on `id`: re-creating an existing
   * session leaves the stored row (and its transcript) untouched, so a caller
   * that cannot tell whether it already started is free to call this anyway.
   */
  async createChatSession(session: NewChatSession): Promise<void> {
    this.#db
      .insert(chatSessions)
      .values({
        id: session.id,
        workspacePath: session.workspacePath,
        title: session.title,
        name: session.name ?? null,
        modelAlias: session.modelAlias ?? null,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
        messageCount: 0,
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Writes messages by `(sessionId, seq)` in one transaction, last write
   * wins. Because identity is the sequence number rather than insertion
   * order, re-saving an overlapping snapshot of the transcript is safe: it
   * rewrites those rows instead of duplicating them.
   *
   * Afterwards the session's `updatedAt` is bumped and its `messageCount`
   * recomputed as `max(seq) + 1` over everything stored for the session, so
   * incremental and whole-transcript saves agree. An empty batch is a no-op —
   * it does not touch the session.
   */
  async appendChatMessages(
    sessionId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const now = Date.now();
    const rows = messages.map((entry) => ({
      sessionId,
      seq: entry.seq,
      messageJson: stringifyJson(entry.message) ?? "null",
      createdAt: now,
    }));

    this.#db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(chatMessages)
          .values(row)
          .onConflictDoUpdate({
            target: [chatMessages.sessionId, chatMessages.seq],
            set: { messageJson: row.messageJson, createdAt: row.createdAt },
          })
          .run();
      }

      const highest = tx
        .select({ maxSeq: sql<number | null>`max(${chatMessages.seq})` })
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .get();
      tx.update(chatSessions)
        .set({ updatedAt: now, messageCount: (highest?.maxSeq ?? -1) + 1 })
        .where(eq(chatSessions.id, sessionId))
        .run();
    });
  }

  /** Rewrites the auto-derived title and marks the session as freshly touched. */
  async setChatSessionTitle(sessionId: string, title: string): Promise<void> {
    this.#db
      .update(chatSessions)
      .set({ title, updatedAt: Date.now() })
      .where(eq(chatSessions.id, sessionId))
      .run();
  }

  /**
   * Sets a session's user-given `name` (`/name`, `kapel sessions rename` —
   * whatever the caller spells it as) and marks it as freshly touched.
   * Renaming a session that is not there is a silent no-op, like
   * {@link setChatSessionTitle}.
   */
  async renameChatSession(sessionId: string, name: string): Promise<void> {
    this.#db
      .update(chatSessions)
      .set({ name, updatedAt: Date.now() })
      .where(eq(chatSessions.id, sessionId))
      .run();
  }

  /**
   * Sessions newest-touched first. `workspacePath` is compared verbatim —
   * the caller is expected to have `path.resolve`d both the value it stored
   * and the value it filters by; the store does no normalization of its own.
   */
  async listChatSessions(
    workspacePath?: string,
    options?: ListChatSessionsOptions,
  ): Promise<readonly ChatSessionRecord[]> {
    const limit = options?.limit;
    const selection = this.#db.select().from(chatSessions);
    const filtered =
      workspacePath === undefined
        ? selection
        : selection.where(eq(chatSessions.workspacePath, workspacePath));
    // `id` breaks ties so a listing is stable when two sessions share a
    // millisecond, which snapshot saves in a tight loop can produce.
    const ordered = filtered.orderBy(
      desc(chatSessions.updatedAt),
      desc(chatSessions.createdAt),
      desc(chatSessions.id),
    );
    const rows =
      limit === undefined
        ? ordered.all()
        : ordered.limit(Math.max(0, limit)).all();
    return rows.map(toChatSessionRecord);
  }

  /**
   * Reads a session and its transcript, ordered by `seq`. Messages whose JSON
   * no longer parses are skipped rather than thrown over: a single corrupt
   * row must not make a conversation unresumable.
   */
  async loadChatSession(
    sessionId: string,
  ): Promise<ChatSessionTranscript | undefined> {
    const row = this.#db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1)
      .get();
    if (row === undefined) return undefined;

    const messageRows = this.#db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.seq))
      .all();
    const messages: ModelMessage[] = [];
    for (const messageRow of messageRows) {
      const message = parseJson<ModelMessage>(messageRow.messageJson);
      if (message === undefined || message === null) continue;
      messages.push(message);
    }
    return { record: toChatSessionRecord(row), messages };
  }

  /** Drops a session and its transcript together. */
  async deleteChatSession(sessionId: string): Promise<void> {
    this.#db.transaction((tx) => {
      tx.delete(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .run();
      tx.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
    });
  }

  /**
   * Copies a session — its metadata (workspace, title, model) and its whole
   * transcript as of now — into a brand new session, and returns the new
   * session's id.
   *
   * The fork is independent from the moment it is created: it does not carry
   * the source id forward anywhere, so appending to either session afterwards
   * never touches the other. `options.name` labels the new session; leaving
   * it out leaves the fork unnamed even if the source had a name, since a
   * name is a label the user chose for one specific conversation branch, not
   * a property that should silently propagate to every copy of it.
   *
   * Throws if `sessionId` does not name an existing session — unlike the
   * read paths, a fork has nothing useful to return for a source that isn't
   * there.
   */
  async forkChatSession(
    sessionId: string,
    options: ForkChatSessionOptions = {},
  ): Promise<string> {
    const newId = crypto.randomUUID();
    const now = Date.now();

    this.#db.transaction((tx) => {
      const source = tx
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1)
        .get();
      if (source === undefined) {
        throw new Error(`Chat session ${sessionId} not found`);
      }

      tx.insert(chatSessions)
        .values({
          id: newId,
          workspacePath: source.workspacePath,
          title: source.title,
          name: options.name ?? null,
          modelAlias: source.modelAlias,
          createdAt: now,
          updatedAt: now,
          messageCount: source.messageCount,
        })
        .run();

      const sourceMessages = tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .all();
      for (const message of sourceMessages) {
        tx.insert(chatMessages)
          .values({
            sessionId: newId,
            seq: message.seq,
            messageJson: message.messageJson,
            createdAt: now,
          })
          .run();
      }
    });

    return newId;
  }

  close(): void {
    this.#sqlite.close();
  }
}

function toChatSessionRecord(
  row: typeof chatSessions.$inferSelect,
): ChatSessionRecord {
  return {
    id: row.id,
    workspacePath: row.workspacePath,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: row.messageCount,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.modelAlias === null ? {} : { modelAlias: row.modelAlias }),
  };
}

function toAgentEvent(row: typeof events.$inferSelect): AgentEvent {
  const data = parseJson<unknown>(row.dataJson);
  return {
    id: row.id,
    runId: row.runId,
    timestamp: row.timestamp,
    type: row.type,
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    ...(row.workerId === null ? {} : { workerId: row.workerId }),
    ...(data === undefined ? {} : { data }),
  };
}

/**
 * Reads back everything needed to resume `runId`: the run itself, the task
 * results that succeeded, and the planned tasks still outstanding.
 *
 * Without a saved plan there is no task list to diff against, so
 * `incompleteTaskIds` is empty — the caller has to replan.
 */
export async function reconstructRun(
  store: SqliteSessionStore,
  runId: string,
): Promise<RunReconstruction | undefined> {
  const run = await store.getRun(runId);
  if (run === undefined) return undefined;

  const persisted = await store.taskResults(runId);
  const completed = new Map<string, TaskResult>();
  for (const [taskId, entry] of persisted) {
    if (entry.status !== "success" || entry.result === undefined) continue;
    completed.set(taskId, entry.result);
  }

  const planned = run.plan?.tasks ?? [];
  const incompleteTaskIds = planned
    .map((task) => task.id)
    .filter((id) => !completed.has(id));

  return { run, completed, incompleteTaskIds };
}
