import { join } from "node:path";
import type { ExecutionPlan, TaskResult } from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent } from "@agent/protocol";
import Database from "better-sqlite3";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { RunRecord, SessionStore } from "./index.js";
import {
  BOOTSTRAP_DDL,
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

  close(): void {
    this.#sqlite.close();
  }
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
