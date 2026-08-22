/**
 * The live worker row: one painted line that says what every task in an
 * orchestration run is doing, right now.
 *
 * ```
 *   [T01 ✔] [T02 ▶ coder 12s] [T03 ⏸ held] [T04 ·]
 * ```
 *
 * An orchestration run is kapel's whole point — an expensive model plans, and
 * cheap workers carry the plan out in parallel worktrees — and until this row
 * existed the only evidence of that parallelism was a scrolling column of
 * per-event lines, each one true and none of them answering "what is happening
 * *now*". The Ink dashboard (`--tui`) answers it by taking the screen; this
 * row answers it in one line, next to the transcript, so a run stays a run
 * whose output you can pipe, scroll back through and paste into an issue.
 *
 * Three properties are worth stating outright, because they are what keeps a
 * painted thing from ruining a printed one:
 *
 * - **It is painted, never printed.** The row goes through the same
 *   {@link StatusLine} the spinner does, so the renderer's existing discipline
 *   — erase, write the real line, repaint underneath — carries it for free and
 *   there is exactly one painting authority on screen. Off a TTY the status
 *   line is inert, which is precisely the behaviour a piped or CI run wants:
 *   no row, no escapes, the same bytes as before.
 * - **The per-event lines are unchanged.** This row is a second view of the
 *   same event stream, not a replacement for the first. `task.started` still
 *   prints its line; the row is what that line looks like a second later, when
 *   three other tasks have moved on.
 * - **The state is a fold over events, and the row is a pure function of it.**
 *   {@link applyWorkerEvent} and {@link formatWorkerRow} between them contain
 *   every decision this module makes, and neither of them can write to a
 *   terminal — which is what makes "what does the row say after this sequence"
 *   a question a test can ask.
 */

import type { AgentEvent, EventSink } from "@agent/protocol";
import type { BandDecor } from "./band.js";
import { displayWidth } from "./band.js";
import {
  StatusLine,
  type StatusLineOptions,
  type StatusLineStream,
} from "./status-line.js";
import { type StyleRole, type Styles, stylesFor } from "./styles.js";

/**
 * What one task is doing, as far as the event stream has said.
 *
 * Deliberately coarser than the scheduler's own task status: this is a glyph's
 * worth of information, and a row that tried to distinguish six kinds of
 * not-finished-yet would be a table with the columns taken out.
 */
export type WorkerState =
  | "pending"
  | "running"
  | "held"
  | "retrying"
  | "escalated"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkerSummary {
  readonly id: string;
  readonly state: WorkerState;
  /** Who is working on it, once the scheduler has routed an attempt. */
  readonly agent?: string;
  /** Which attempt this is; only shown from the second one onwards. */
  readonly attempt?: number;
  /** When the current attempt started, for the live elapsed clock. */
  readonly startedAt?: number;
}

/** The glyph and the role each state wears. */
const FACES: Record<
  WorkerState,
  { readonly glyph: string; readonly role: StyleRole }
> = {
  pending: { glyph: "·", role: "tool" },
  running: { glyph: "▶", role: "tool" },
  held: { glyph: "⏸", role: "warn" },
  retrying: { glyph: "↻", role: "warn" },
  escalated: { glyph: "↑", role: "warn" },
  succeeded: { glyph: "✔", role: "ok" },
  failed: { glyph: "✖", role: "error" },
  cancelled: { glyph: "⊘", role: "warn" },
};

/**
 * Which tasks survive a row too narrow to hold them all, lowest first.
 *
 * The ordering is "what would you want to know if you could only see four
 * cells": what is being worked on, what is stuck, what went wrong, and only
 * then the long tail of work that is either finished (and fine) or has not
 * begun. A run of forty tasks on an eighty-column terminal is the normal case
 * for this code, not the edge one.
 */
const RANK: Record<WorkerState, number> = {
  running: 0,
  held: 1,
  failed: 2,
  retrying: 3,
  escalated: 3,
  cancelled: 4,
  pending: 5,
  succeeded: 6,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// --- The state, as a fold over the event stream ------------------------------

/**
 * Every planned task, pending.
 *
 * Seeded from the plan rather than discovered from events, so the row shows
 * the shape of the run from its first frame: four dots that fill in is a
 * progress report, whereas a row that grows a cell per `task.started` is a
 * list of things that have already happened.
 */
export function seedWorkerSummaries(
  taskIds: readonly string[],
): ReadonlyMap<string, WorkerSummary> {
  const summaries = new Map<string, WorkerSummary>();
  for (const id of taskIds) {
    if (!summaries.has(id)) summaries.set(id, { id, state: "pending" });
  }
  return summaries;
}

/**
 * `summaries` after one event — the same map, by identity, when the event says
 * nothing about any task.
 *
 * Identity is the signal the caller repaints on: an orchestration run's stream
 * is mostly worker chatter (text deltas, tool calls) that this row has no
 * opinion about, and returning the map unchanged is how those events cost
 * nothing at all.
 *
 * A task id nobody planned is added rather than dropped. The alternative is a
 * row that quietly omits a task the scheduler is really running, which is the
 * one failure mode a progress display must not have.
 */
export function applyWorkerEvent(
  summaries: ReadonlyMap<string, WorkerSummary>,
  event: AgentEvent,
): ReadonlyMap<string, WorkerSummary> {
  const data = isRecord(event.data) ? event.data : {};
  const taskId = event.taskId ?? stringOrUndefined(data.taskId);
  if (taskId === undefined) return summaries;

  const previous = summaries.get(taskId) ?? {
    id: taskId,
    state: "pending" as const,
  };
  const next = nextSummary(previous, event.type, data, event.timestamp);
  if (next === undefined) return summaries;

  const out = new Map(summaries);
  out.set(taskId, next);
  return out;
}

/** The task's new summary, or `undefined` when this event does not move it. */
function nextSummary(
  previous: WorkerSummary,
  type: string,
  data: Record<string, unknown>,
  timestamp: number,
): WorkerSummary | undefined {
  const attempt = typeof data.attempt === "number" ? data.attempt : undefined;
  const agent = stringOrUndefined(data.agent) ?? previous.agent;

  switch (type) {
    case "task.started":
      return {
        id: previous.id,
        state: "running",
        startedAt: timestamp,
        ...(agent === undefined ? {} : { agent }),
        ...(attempt === undefined ? {} : { attempt }),
      };
    case "task.held":
      // Held is a fact about scheduling, not about an attempt: the task has
      // not started, so it keeps whatever the last attempt left behind.
      return { ...previous, state: "held" };
    case "task.completed": {
      const result = isRecord(data.result) ? data.result : {};
      // `final: false` means the scheduler will have another go, so this is
      // not the task's verdict — showing `✖` here would report a failure the
      // run may well not end up having.
      if (data.final === false) {
        return {
          id: previous.id,
          state: "retrying",
          ...(agent === undefined ? {} : { agent }),
          ...(attempt === undefined ? {} : { attempt }),
        };
      }
      return {
        id: previous.id,
        state: result.status === "success" ? "succeeded" : "failed",
        ...(agent === undefined ? {} : { agent }),
        ...(attempt === undefined ? {} : { attempt }),
      };
    }
    case "task.escalated": {
      const to = stringOrUndefined(data.to);
      return {
        ...previous,
        state: "escalated",
        ...(to === undefined ? {} : { agent: to }),
      };
    }
    case "task.cancelled":
      return { ...previous, state: "cancelled" };
    default:
      return undefined;
  }
}

// --- The row -----------------------------------------------------------------

export interface WorkerRowOptions {
  /** The terminal's width. The row never uses the last column — see below. */
  readonly columns: number;
  /** The instant the row is being painted for, for the elapsed clocks. */
  readonly now: number;
  readonly styles: Styles;
}

/**
 * One cell's text twice over: the plain form, which is what may be *measured*,
 * and the styled form, which is what is written. Measuring the styled form
 * would work — {@link displayWidth} strips escapes — but building both here
 * keeps the arithmetic below reading in cells rather than in bytes.
 */
interface WorkerCell {
  readonly plain: string;
  readonly styled: string;
  readonly rank: number;
}

/** `[T02 ▶ coder 12s]`, and the seven quieter shapes. */
function workerCell(
  summary: WorkerSummary,
  now: number,
  styles: Styles,
): WorkerCell {
  const face = FACES[summary.state];
  const detail = detailFor(summary, now);
  return {
    plain: `[${summary.id} ${face.glyph}${detail}]`,
    styled: `${styles.tool(`[${summary.id} `)}${styles.role(face.role, face.glyph)}${styles.tool(`${detail}]`)}`,
    rank: RANK[summary.state],
  };
}

/**
 * What a cell says after its glyph: who is on it, for how long, and — only
 * when it is not the first — which attempt this is.
 *
 * Only a running task carries a clock. A finished one's duration belongs in
 * the summary table at the end of the run, where it can be read; here it would
 * be a number that stopped moving, competing for width with the tasks that are
 * still going.
 */
function detailFor(summary: WorkerSummary, now: number): string {
  const attempt =
    summary.attempt !== undefined && summary.attempt > 1
      ? ` #${summary.attempt}`
      : "";
  switch (summary.state) {
    case "running": {
      const agent = summary.agent === undefined ? "" : ` ${summary.agent}`;
      const started = summary.startedAt;
      const elapsed =
        started === undefined
          ? ""
          : ` ${Math.max(0, Math.floor((now - started) / 1000))}s`;
      return `${agent}${elapsed}${attempt}`;
    }
    case "held":
      return " held";
    case "retrying":
      return attempt;
    default:
      return "";
  }
}

/**
 * The whole row, styled, for one instant and one terminal width.
 *
 * Never wider than `columns - 1` cells and never more than one row: this text
 * is painted into a block that erases itself by row count, so a row that wraps
 * is a row the next erase leaves half of on screen. When the cells do not all
 * fit, the ones that survive are chosen by {@link RANK} but printed in plan
 * order — the eye finds `T07` faster in a row that still counts upwards — and
 * the tally of what was dropped goes on the end as `+3`, because a silently
 * shortened row would misreport the size of the run.
 */
export function formatWorkerRow(
  summaries: readonly WorkerSummary[],
  options: WorkerRowOptions,
): string {
  if (summaries.length === 0) return "";
  const { styles } = options;
  const width = Math.max(1, options.columns - 1);
  const cells = summaries.map((summary) =>
    workerCell(summary, options.now, styles),
  );

  const all = cells.map((cell) => cell.plain).join(" ");
  if (displayWidth(all) <= width) {
    return cells.map((cell) => cell.styled).join(" ");
  }

  // Widest-first would fit more cells, but which cells you can see would then
  // depend on how long an agent's name is. Priority order, first failure
  // stops the fill: the row stays a stable window on the run instead of
  // reshuffling every time a task's text grows a character.
  const order = cells
    .map((cell, index) => ({ cell, index }))
    .sort((a, b) => a.cell.rank - b.cell.rank || a.index - b.index);

  const kept = new Set<number>();
  let used = 0;
  for (const { cell, index } of order) {
    const separator = kept.size === 0 ? 0 : 1;
    const dropped = cells.length - kept.size - 1;
    const tally = dropped === 0 ? 0 : displayWidth(` +${dropped}`);
    if (used + separator + displayWidth(cell.plain) + tally > width) break;
    kept.add(index);
    used += separator + displayWidth(cell.plain);
  }

  const dropped = cells.length - kept.size;
  const tally = dropped === 0 ? "" : ` +${dropped}`;
  if (kept.size === 0) {
    // Not even one cell fits. The count of tasks is still worth the two cells
    // it costs — it says a run is going on, which is the minimum this row owes
    // the reader.
    return styles.tool(`+${cells.length}`.slice(0, width));
  }
  const shown = cells
    .filter((_, index) => kept.has(index))
    .map((cell) => cell.styled)
    .join(" ");
  return `${shown}${tally === "" ? "" : styles.tool(tally)}`;
}

// --- The painter -------------------------------------------------------------

export interface WorkerBandOptions {
  /** Every task in the plan, in plan order. */
  readonly taskIds: readonly string[];
  /** Where the row is painted. Defaults to `process.stdout`. */
  readonly output?: StatusLineStream;
  /** Overrides the TTY probe. Only tests should pass this. */
  readonly tty?: boolean;
  /** The palette. Defaults to whatever `output` and the environment allow. */
  readonly styles?: Styles;
  /**
   * The rules to bound the row with, when the caller has a band for it to be
   * part of — the REPL's `/orchestrate` does, a standalone `kapel orchestrate`
   * does not.
   */
  readonly frame?: BandDecor;
  /** While this returns `true` the row stays erased; something else owns the screen. */
  readonly suspended?: () => boolean;
  readonly now?: () => number;
  /** Injected by tests to keep the elapsed clocks deterministic. */
  readonly ticker?: (tick: () => void) => () => void;
}

export interface WorkerBand {
  /**
   * The block the row is painted in. Hand it to the renderer as its status
   * line: that is what makes the row and the run's printed lines take turns
   * with the cursor rather than fight over it.
   */
  readonly status: StatusLine;
  /** Feed this the run's events — one arm of the fan-out, alongside the renderer. */
  readonly sink: EventSink;
  /** Shows the row, all tasks pending. Called once the run's lead lines are out. */
  open(): void;
  /** Takes the row off the screen for good, before the run's summary is printed. */
  stop(): void;
}

/**
 * The row, wired: a state map folded from the events, a status block that
 * paints it, and the sink that connects the two.
 *
 * The seconds tick between events because the block's ticker repaints on its
 * own schedule and the row is re-derived from `now()` each time — a worker
 * that has been quiet for a minute still visibly *is* a minute in.
 */
export function createWorkerBand(options: WorkerBandOptions): WorkerBand {
  const output = options.output ?? process.stdout;
  const styles = options.styles ?? stylesFor(output);
  const now = options.now ?? (() => Date.now());

  let summaries = seedWorkerSummaries(options.taskIds);

  const statusOptions: StatusLineOptions = {
    output,
    styles,
    now,
    rows: (columns) => {
      const row = formatWorkerRow([...summaries.values()], {
        columns,
        now: now(),
        styles,
      });
      return row === "" ? [] : [row];
    },
    ...(options.tty === undefined ? {} : { tty: options.tty }),
    ...(options.frame === undefined ? {} : { frame: options.frame }),
    ...(options.suspended === undefined
      ? {}
      : { suspended: options.suspended }),
    ...(options.ticker === undefined ? {} : { ticker: options.ticker }),
  };
  const status = new StatusLine(statusOptions);

  return {
    status,
    sink: {
      emit(event: AgentEvent): void {
        const next = applyWorkerEvent(summaries, event);
        if (next === summaries) return;
        summaries = next;
        // Repaint now rather than on the next tick: an event the reader just
        // watched scroll past should be true of the row underneath it.
        status.refresh();
      },
    },
    open: () => status.open(),
    stop: () => status.stop(),
  };
}
