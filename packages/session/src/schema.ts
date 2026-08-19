import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/** Lifecycle of a persisted run. */
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Lifecycle of a task inside a run, as reconstructed from the event stream.
 *
 * `pending` is the placeholder a row gets when the first event that mentions
 * a task carries no outcome yet (an escalation arrives before its
 * `task.started`); `success`/`failed`/`partial` mirror `TaskResult.status`.
 */
export type TaskResultStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "partial"
  | "cancelled";

const RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

const TASK_RESULT_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "partial",
  "cancelled",
] as const satisfies readonly TaskResultStatus[];

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  objective: text("objective").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  status: text("status", { enum: RUN_STATUSES }).notNull(),
  policyJson: text("policy_json").notNull(),
  planJson: text("plan_json"),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    timestamp: integer("timestamp").notNull(),
    type: text("type").notNull(),
    taskId: text("task_id"),
    workerId: text("worker_id"),
    dataJson: text("data_json"),
  },
  (table) => [
    index("events_run_id_idx").on(table.runId),
    index("events_run_id_type_idx").on(table.runId, table.type),
  ],
);

export const taskResults = sqliteTable(
  "task_results",
  {
    runId: text("run_id").notNull(),
    taskId: text("task_id").notNull(),
    agent: text("agent"),
    attempts: integer("attempts").notNull(),
    status: text("status", { enum: TASK_RESULT_STATUSES }).notNull(),
    resultJson: text("result_json"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.taskId] }),
    index("task_results_run_id_idx").on(table.runId),
  ],
);

/**
 * One interactive chat conversation, scoped to the workspace directory it was
 * started in. `workspace_path` is stored verbatim — normalization (e.g.
 * `path.resolve`) is the caller's job, so listings match on the exact string.
 */
export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    workspacePath: text("workspace_path").notNull(),
    title: text("title").notNull(),
    /**
     * User-given label, set via `/name` or `--name`, distinct from `title`
     * (which is auto-derived from the first message). Nullable, and added
     * after the table's original release: `BOOTSTRAP_DDL` below only creates
     * it for a brand new database, so a v0.5.0 database (created before this
     * column existed) needs the `ALTER TABLE` migration `SqliteSessionStore`
     * runs on open — see `ensureChatSessionsNameColumn` in `sqlite.ts`.
     */
    name: text("name"),
    modelAlias: text("model_alias"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    messageCount: integer("message_count").notNull().default(0),
  },
  (table) => [
    index("chat_sessions_workspace_path_idx").on(table.workspacePath),
    index("chat_sessions_updated_at_idx").on(table.updatedAt),
    index("chat_sessions_name_idx").on(table.name),
  ],
);

/**
 * A single message of a chat session, stored as an opaque JSON blob keyed by
 * its position in the transcript so re-saving a snapshot is idempotent.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    messageJson: text("message_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.seq] }),
    index("chat_messages_session_id_idx").on(table.sessionId),
  ],
);

/**
 * Idempotent DDL for the whole store. Applied on every open instead of
 * shipping migration files: the schema is append-only and small enough that
 * `CREATE ... IF NOT EXISTS` is the entire story.
 */
export const BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  plan_json TEXT
);
CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs (created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  task_id TEXT,
  worker_id TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_run_id_idx ON events (run_id);
CREATE INDEX IF NOT EXISTS events_run_id_type_idx ON events (run_id, type);
CREATE INDEX IF NOT EXISTS events_run_id_task_id_idx ON events (run_id, task_id);

CREATE TABLE IF NOT EXISTS task_results (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent TEXT,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id)
);
CREATE INDEX IF NOT EXISTS task_results_run_id_idx ON task_results (run_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  title TEXT NOT NULL,
  name TEXT,
  model_alias TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_sessions_workspace_path_idx
  ON chat_sessions (workspace_path);
CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx
  ON chat_sessions (updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx
  ON chat_messages (session_id);
`;

/** Insertion order within one timestamp, used to keep `listEvents` stable. */
export const eventRowid = sql`rowid`;
