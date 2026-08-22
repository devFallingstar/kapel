import type { AgentEvent } from "@agent/protocol";
import { CODEX_EVENT_PREFIX } from "@agent/protocol";

/**
 * The TUI's view of one orchestration task.
 *
 * Deliberately structural and local to this package: the dashboard consumes
 * {@link AgentEvent}s, never orchestration objects, so nothing here needs to
 * agree with `@agent/orchestration`'s task/plan types (which this package does
 * not reference).
 */
export interface TuiTask {
  readonly id: string;
  readonly agent?: string;
  readonly status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "held";
  readonly attempts: number;
  readonly summary?: string;
  /** Short "why this row looks like that" note: escalation, retry, held-by, validator failure. */
  readonly note?: string;
}

export interface TuiState {
  readonly runId?: string;
  readonly objective?: string;
  readonly startedAt?: number;
  readonly tasks: readonly TuiTask[];
  readonly log: readonly string[];
  readonly finished: boolean;
  readonly outcome?: string;
}

/** The plan shape the dashboard can be seeded with, structurally. */
export interface TuiTaskSeed {
  readonly id: string;
  readonly title?: string;
}

export interface TuiInit {
  readonly objective?: string;
  readonly taskIds?: readonly TuiTaskSeed[];
}

/** How many formatted log lines the state keeps. */
export const MAX_LOG_LINES = 100;

const MAX_SUMMARY = 120;
const MAX_LINE = 160;

export function initialTuiState(init?: TuiInit): TuiState {
  const tasks = (init?.taskIds ?? []).map((seed) =>
    buildTask({
      id: seed.id,
      status: "pending",
      attempts: 0,
      ...pick("summary", seed.title),
    }),
  );
  return {
    tasks,
    log: [],
    finished: false,
    ...pick("objective", init?.objective),
  };
}

/** Marks a run finished. Kept beside the reducer so the state stays in one module. */
export function finishTuiState(state: TuiState, outcome: string): TuiState {
  if (state.finished && state.outcome === outcome) return state;
  return { ...state, finished: true, outcome };
}

/**
 * Folds one event into the dashboard state.
 *
 * Envelope bookkeeping (run id, run start) is adopted from the first event of
 * any type; type-specific effects (task rows, log line) only happen for the
 * event vocabulary the runtime actually emits. An event type this build does
 * not know leaves the state referentially unchanged.
 */
export function reduceTuiEvent(state: TuiState, event: AgentEvent): TuiState {
  const base = adoptEnvelope(state, event);
  const tasks = reduceTasks(base.tasks, event);
  const line = formatEventLine(event);
  const log = line === undefined ? base.log : appendLog(base.log, line);
  if (tasks === base.tasks && log === base.log) return base;
  return { ...base, tasks, log };
}

/**
 * One-line rendering of an event, mirroring the CLI's `TextRenderer`
 * vocabulary (minus ANSI styling — the component decides on colour).
 * `undefined` means "this event is not worth a log line".
 */
export function formatEventLine(event: AgentEvent): string | undefined {
  if (event.type.startsWith(CODEX_EVENT_PREFIX)) {
    // The one payload the union leaves `unknown`: it is the Codex CLI's own
    // JSON, not kapel's, so it is still probed field by field.
    return formatCodexLine(isRecord(event.data) ? event.data : {});
  }

  switch (event.type) {
    case "model.turn.completed": {
      const text = str(event.data.text);
      return text === undefined
        ? undefined
        : truncate(collapse(text), MAX_LINE);
    }
    case "tool.execution.started": {
      const preview = previewInput(event.data.input);
      return truncate(
        `→ ${event.data.tool}${preview === "" ? "" : ` ${preview}`}`,
        MAX_LINE,
      );
    }
    case "tool.execution.completed": {
      if (event.data.ok) return "  ✓";
      return `  ✗ (${event.data.denied === true ? "denied" : "error"})`;
    }
    case "task.started":
      return `▶ ${taskIdOf(event)} → ${event.data.agent} (attempt ${event.data.attempt})`;
    case "task.completed": {
      const { result } = event.data;
      const glyph = result.status === "success" ? "✔" : "✖";
      const suffix = event.data.final ? "" : " (retrying)";
      return `${glyph} ${taskIdOf(event)} — ${firstLine(result.summary)}${suffix}`;
    }
    case "task.escalated": {
      const from = str(event.data.from) ?? "(unassigned)";
      return `↑ ${taskIdOf(event)} rerouted ${from} → ${event.data.to}`;
    }
    case "task.cancelled":
      return `⊘ ${taskIdOf(event)} (${event.data.reason})`;
    case "task.held":
      return `⏸ ${taskIdOf(event)} held (conflicts with ${event.data.conflictsWith})`;
    case "task.low_confidence": {
      const { confidence, threshold } = event.data;
      const verdict =
        event.data.accepted === true
          ? "accepted (attempts exhausted)"
          : "redoing";
      return `↻ ${taskIdOf(event)} low confidence ${confidence.toFixed(2)} < ${threshold.toFixed(2)} — ${verdict}`;
    }
    case "worktree.created":
      return `⎇ ${taskIdOf(event)} worktree created (${event.data.branch})`;
    case "worktree.integrated": {
      if (event.data.merged) {
        const commit = str(event.data.commit);
        return `⇡ ${taskIdOf(event)} merged${commit === undefined ? "" : ` → ${commit.slice(0, 8)}`}`;
      }
      const files = event.data.conflictFiles ?? [];
      return files.length === 0
        ? `⚠ ${taskIdOf(event)} not merged (${str(event.data.reason) ?? "unknown reason"})`
        : `⚠ ${taskIdOf(event)} merge conflict: ${files.join(", ")}`;
    }
    case "worktree.removed": {
      if (!event.data.keptBranch) return undefined;
      return `⎇ ${taskIdOf(event)} branch kept: ${event.data.branch}`;
    }
    case "validation.started":
      return `⚙ ${taskIdOf(event)} validator ${event.data.name}…`;
    case "validation.completed": {
      const { name, exitCode } = event.data;
      const duration = `${(event.data.durationMs / 1000).toFixed(1)}s`;
      if (event.data.passed) return `  ✓ ${name} (${duration})`;
      return `  ✗ ${name} (exit ${exitCode === null ? "unknown" : exitCode}, ${duration})`;
    }
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* task rows                                                                   */
/* -------------------------------------------------------------------------- */

/** A mutable working copy of {@link TuiTask}, so updates read as assignments. */
interface TaskDraft {
  id: string;
  agent?: string;
  status: TuiTask["status"];
  attempts: number;
  summary?: string;
  note?: string;
}

function reduceTasks(
  tasks: readonly TuiTask[],
  event: AgentEvent,
): readonly TuiTask[] {
  switch (event.type) {
    case "task.started":
    case "task.completed":
    case "task.escalated":
    case "task.cancelled":
    case "task.held":
    case "task.low_confidence":
    case "validation.completed":
      break;
    default:
      return tasks;
  }

  const id = taskIdOf(event);
  if (id === "?") return tasks;

  return updateTask(tasks, id, (draft) => {
    switch (event.type) {
      case "task.started": {
        draft.status = "running";
        draft.agent = event.data.agent;
        draft.attempts = event.data.attempt;
        break;
      }
      case "task.completed": {
        const { result } = event.data;
        const summary = str(result.summary);
        if (summary !== undefined) draft.summary = firstLine(summary);
        draft.attempts = event.data.attempt;
        if (!event.data.final) {
          // The scheduler is going to retry: the row stays live rather than
          // settling on a verdict this attempt does not get to make.
          draft.status = "running";
          draft.note = `retrying (attempt ${draft.attempts})`;
          break;
        }
        const ok = result.status === "success";
        draft.status = ok ? "completed" : "failed";
        // A settled success has nothing left to explain; a failure keeps the
        // note (failed validator, escalation target) that says why.
        if (ok) delete draft.note;
        break;
      }
      case "task.escalated":
        draft.note = `→ ${event.data.to}`;
        break;
      case "task.cancelled":
        draft.status = "cancelled";
        draft.note = event.data.reason;
        break;
      case "task.held": {
        // Only a task waiting to be dispatched can be held; a row that already
        // started (or settled) is never walked backwards.
        if (draft.status !== "pending" && draft.status !== "held") break;
        draft.status = "held";
        draft.note = `held by ${event.data.conflictsWith}`;
        break;
      }
      case "task.low_confidence": {
        const verdict = event.data.accepted === true ? " (accepted)" : "";
        draft.note = `low confidence ${event.data.confidence.toFixed(2)}${verdict}`;
        break;
      }
      case "validation.completed": {
        if (event.data.passed) break;
        const failure = `✗ ${event.data.name}`;
        draft.note =
          draft.note === undefined ? failure : `${draft.note} · ${failure}`;
        break;
      }
      default:
        break;
    }
  });
}

function updateTask(
  tasks: readonly TuiTask[],
  id: string,
  update: (draft: TaskDraft) => void,
): readonly TuiTask[] {
  const index = tasks.findIndex((task) => task.id === id);
  const existing = index === -1 ? undefined : tasks[index];
  const draft: TaskDraft =
    existing === undefined
      ? { id, status: "pending", attempts: 0 }
      : { ...existing };
  update(draft);
  const next = buildTask(draft);
  if (existing !== undefined && sameTask(existing, next)) return tasks;
  if (index === -1) return [...tasks, next];
  return tasks.map((task, i) => (i === index ? next : task));
}

function sameTask(a: TuiTask, b: TuiTask): boolean {
  return (
    a.id === b.id &&
    a.agent === b.agent &&
    a.status === b.status &&
    a.attempts === b.attempts &&
    a.summary === b.summary &&
    a.note === b.note
  );
}

/** Builds a `TuiTask` without ever writing an explicit `undefined` property. */
function buildTask(draft: TaskDraft): TuiTask {
  return {
    id: draft.id,
    status: draft.status,
    attempts: draft.attempts,
    ...pick("agent", draft.agent),
    ...pick("summary", draft.summary),
    ...pick("note", draft.note),
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** `{key: value}` when defined, `{}` otherwise — for `exactOptionalPropertyTypes`. */
function pick<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function adoptEnvelope(state: TuiState, event: AgentEvent): TuiState {
  if (state.runId !== undefined && state.startedAt !== undefined) return state;
  return {
    ...state,
    runId: state.runId ?? event.runId,
    startedAt: state.startedAt ?? event.timestamp,
  };
}

function appendLog(log: readonly string[], line: string): readonly string[] {
  const next = [...log, line];
  return next.length <= MAX_LOG_LINES
    ? next
    : next.slice(next.length - MAX_LOG_LINES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The task an event belongs to: the envelope field, then the payload copy the
 * scheduler stamps on the events it can identify without one, then "?".
 */
function taskIdOf(event: AgentEvent): string {
  if (event.taskId !== undefined) return event.taskId;
  switch (event.type) {
    case "task.held":
    case "task.low_confidence":
    case "worktree.created":
    case "worktree.integrated":
    case "worktree.removed":
      return event.data.taskId;
    default:
      return "?";
  }
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(1, limit - 1))}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "(no summary)";
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "(no summary)" : truncate(line, MAX_SUMMARY);
}

/** Compact one-line preview of a tool's input payload. */
function previewInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncate(collapse(input), 60);
  try {
    return truncate(collapse(JSON.stringify(input) ?? ""), 60);
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* codex.* events                                                              */
/* -------------------------------------------------------------------------- */

function formatCodexLine(data: Record<string, unknown>): string | undefined {
  const item = codexItem(data);
  if (item === undefined) return undefined;

  switch (str(item.type)) {
    case "agent_message": {
      const text = codexMessageText(item);
      return text === undefined
        ? undefined
        : truncate(collapse(text), MAX_LINE);
    }
    case "command_execution": {
      const command = codexCommandText(item);
      return command === undefined
        ? undefined
        : `→ codex: ${truncate(command, MAX_SUMMARY)}`;
    }
    case "file_change": {
      const summary = codexFileText(item);
      return summary === undefined
        ? undefined
        : `✎ ${truncate(summary, MAX_SUMMARY)}`;
    }
    default:
      return undefined;
  }
}

function codexItem(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isRecord(data.item)) return data.item;
  if (isRecord(data.msg) && isRecord(data.msg.item)) return data.msg.item;
  return undefined;
}

function codexMessageText(item: Record<string, unknown>): string | undefined {
  const direct = str(item.text) ?? str(item.message);
  if (direct !== undefined) return direct;
  const content = item.content;
  if (typeof content === "string") return str(content);
  if (!Array.isArray(content)) return undefined;
  const joined = content
    .map((part) =>
      typeof part === "string"
        ? part
        : isRecord(part)
          ? (str(part.text) ?? "")
          : "",
    )
    .join("");
  return str(joined);
}

function codexCommandText(item: Record<string, unknown>): string | undefined {
  const direct = str(item.command) ?? str(item.cmd);
  if (direct !== undefined) return direct;
  const argv = stringList(item.argv ?? item.command);
  return argv.length === 0 ? undefined : argv.join(" ");
}

function codexFileText(item: Record<string, unknown>): string | undefined {
  const direct = str(item.path) ?? str(item.file) ?? str(item.summary);
  if (direct !== undefined) return direct;
  const changes = item.changes;
  if (!Array.isArray(changes)) return undefined;
  const paths: string[] = [];
  for (const change of changes) {
    if (typeof change === "string") paths.push(change);
    else if (isRecord(change)) {
      const path = str(change.path) ?? str(change.file);
      if (path !== undefined) paths.push(path);
    }
  }
  return paths.length === 0 ? undefined : paths.join(", ");
}
