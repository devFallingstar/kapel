import type {
  ModelUsage,
  UsageBreakdown,
  UsagePricing,
  UsageTotals,
} from "@agent/ai";
import { UNATTRIBUTED } from "@agent/ai";
import type {
  AgentLoopResult,
  ClaudeCodeRunResult,
  CodexRunResult,
} from "@agent/coding-agent";
import { MODEL_TEXT_DELTA_EVENT } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import type { BandDecor } from "./band.js";
import { previewInput } from "./prompter.js";
import { StatusLine, type StatusLineStream } from "./status-line.js";
import { type Styles, stylesFor } from "./styles.js";

/** How a run can finish: the native loop, or one of the delegating backends. */
export type CliRunResult =
  | AgentLoopResult
  | CodexRunResult
  | ClaudeCodeRunResult;

/** The result shape of a delegated run — the only one carrying `exitCode`/`events`. */
export type DelegatedRunResult = CodexRunResult | ClaudeCodeRunResult;

/** Renders loop events (and the final result) to an output stream. */
export interface Renderer extends EventSink {
  result(result: CliRunResult, usage: UsageTotals): void;
}

// --- Cost attribution formatting --------------------------------------------
//
// Shared by the run summary (`orchestrate.ts`) and `/usage` (`interactive.ts`),
// which report the same numbers in two shapes and must not drift apart.

/** `945`, `12.3k`, `1.2M` — token counts short enough to sit in a table cell. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * `$0.42`, `$0.0031`, `$0.42+`, `n/a`.
 *
 * An unpriced model reports `n/a`, never `$0.00`: the tokens were not free,
 * their price is simply not known here (a delegated, subscription-billed
 * backend, or a catalog entry that ships without rates). `+` marks a bucket
 * that mixes priced and unpriced samples, so its figure is a lower bound.
 */
export function formatCostUsd(costUsd: number, pricing: UsagePricing): string {
  if (pricing === "unknown") return "n/a";
  const amount = costUsd >= 0.01 ? costUsd.toFixed(2) : costUsd.toFixed(4);
  return pricing === "partial" ? `$${amount}+` : `$${amount}`;
}

/** `12.3k in (1.0k cached) / 2.1k out` — one bucket's tokens, spelled out. */
export function formatTokenFlow(usage: ModelUsage): string {
  const cached = usage.cachedInputTokens;
  const input =
    cached === undefined || cached === 0
      ? `${formatTokenCount(usage.inputTokens)} in`
      : `${formatTokenCount(usage.inputTokens)} in (${formatTokenCount(cached)} cached)`;
  return `${input} / ${formatTokenCount(usage.outputTokens)} out`;
}

export interface UsageBreakdownLineOptions {
  /** Prefix the tokens with how many tasks fed this bucket (`1 task · …`). */
  readonly countTasks?: boolean;
}

/**
 * One line of a usage rollup:
 * `claude-opus-5: 1 task · 12.3k in / 2.1k out · $0.42`.
 *
 * `countTasks` is for the orchestrate summary, where "which model did how much
 * work" is the whole question; the interactive `/usage` has no tasks and omits
 * that segment.
 */
export function usageBreakdownLine(
  entry: UsageBreakdown,
  options: UsageBreakdownLineOptions = {},
): string {
  const parts: string[] = [];
  if (options.countTasks === true) {
    const tasks = entry.tasks.filter((id) => id !== UNATTRIBUTED).length;
    parts.push(`${tasks} task${tasks === 1 ? "" : "s"}`);
  }
  parts.push(formatTokenFlow(entry.usage));
  parts.push(formatCostUsd(entry.costUsd, entry.pricing));
  return `${entry.key}: ${parts.join(" · ")}`;
}

/**
 * The per-model rollup, most expensive first, then most tokens — the order
 * that answers "where did the money go" without the reader scanning.
 */
export function usageRollupLines(
  breakdown: ReadonlyMap<string, UsageBreakdown>,
  options: UsageBreakdownLineOptions = {},
): readonly string[] {
  return [...breakdown.values()]
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.usage.inputTokens +
          b.usage.outputTokens -
          (a.usage.inputTokens + a.usage.outputTokens) ||
        a.key.localeCompare(b.key),
    )
    .map((entry) => usageBreakdownLine(entry, options));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDelegatedResult(result: CliRunResult): result is DelegatedRunResult {
  return "events" in result;
}

const CODEX_PREFIX = "codex.";
const CLAUDE_CODE_PREFIX = "claude-code.";

function firstNonEmptyString(
  ...values: readonly unknown[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** The `item` payload of a Codex `item.*` event, unwrapped from either shape the stream has used. */
function codexItemFrom(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isRecord(data.item)) return data.item;
  if (isRecord(data.msg) && isRecord(data.msg.item)) return data.msg.item;
  return undefined;
}

function codexMessageText(item: Record<string, unknown>): string | undefined {
  const direct = firstNonEmptyString(item.text, item.message);
  if (direct !== undefined) return direct;

  const content = item.content;
  if (typeof content === "string" && content.trim() !== "") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    const joined = parts.join("");
    if (joined !== "") return joined;
  }
  return undefined;
}

function codexCommandText(item: Record<string, unknown>): string | undefined {
  const direct = firstNonEmptyString(item.command, item.cmd);
  if (direct !== undefined) return direct;

  const argv = item.argv ?? item.command;
  if (Array.isArray(argv)) {
    const parts = argv.filter(
      (part): part is string => typeof part === "string",
    );
    if (parts.length > 0) return parts.join(" ");
  }
  return undefined;
}

function codexFileChangeText(
  item: Record<string, unknown>,
): string | undefined {
  const direct = firstNonEmptyString(item.path, item.file, item.summary);
  if (direct !== undefined) return direct;

  const changes = item.changes;
  if (Array.isArray(changes)) {
    const paths: string[] = [];
    for (const change of changes) {
      if (typeof change === "string") paths.push(change);
      else if (isRecord(change)) {
        const p = firstNonEmptyString(change.path, change.file);
        if (p !== undefined) paths.push(p);
      }
    }
    if (paths.length > 0) return paths.join(", ");
  }
  return undefined;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The task an event belongs to: the envelope field, then the payload, then "?". */
function taskIdOf(event: AgentEvent, data: Record<string, unknown>): string {
  return event.taskId ?? stringOrUndefined(data.taskId) ?? "?";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The `task.started` line's routing clause — `rule: <id>`, `escalation:
 * <id>`, `suggested`, or `default` — from the scheduler's `routing` payload.
 * `undefined` when the payload carries no recognizable routing info at all,
 * which happens for events recorded before this field existed.
 */
function routingLabel(routing: unknown): string | undefined {
  if (!isRecord(routing)) return undefined;
  const rule = stringOrUndefined(routing.rule);
  switch (routing.reason) {
    case "rule":
      return rule === undefined ? "rule" : `rule: ${rule}`;
    case "escalation":
      return rule === undefined ? "escalation" : `escalation: ${rule}`;
    case "suggestedAgent":
      return "suggested";
    case "orchestrator":
      return "default";
    default:
      return undefined;
  }
}

/** The first non-empty line of a task summary, for one-line task reporting. */
function firstLine(text: unknown): string {
  if (typeof text !== "string") return "(no summary)";
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "(no summary)" : truncate(line, 120);
}

/**
 * Re-exported for the callers that took it from here before `styles.ts`
 * existed. The definition — and every SGR code in this CLI — now lives
 * there; see that module for the role vocabulary this renderer paints with.
 */
export { ansi } from "./styles.js";

const EXIT_LABEL: Record<CliRunResult["status"], string> = {
  success: "success",
  partial: "partial",
  failed: "failed",
};

/** The status line's label while the model is producing a turn. */
const THINKING_LABEL = "thinking";

export interface TextRendererOptions {
  /**
   * Cumulative tokens for the conversation so far, shown on the status line.
   * Absent means no token clause — nothing is invented.
   */
  readonly tokens?: () => number | undefined;
  /**
   * The role palette to paint with. Defaults to whatever `output` and the
   * environment allow (see `stylesFor`); tests pass an explicit one.
   */
  readonly styles?: Styles;
  /**
   * While this returns `true` the status line stays erased: something else
   * owns the screen, e.g. a permission question waiting for an answer.
   */
  readonly suspended?: () => boolean;
  /** Replaces the status line entirely. Tests inject a deterministic one. */
  readonly status?: StatusLine;
  /**
   * Turns the status line into the turn's shape of the REPL's input band —
   * the same two rules, with the spinner between them (see `band.ts`). Only
   * the interactive shell passes one: a one-shot `kapel run` has no band for
   * its progress to be part of.
   */
  readonly frame?: BandDecor;
  /**
   * The line the user is typing into the running turn, if any — see
   * {@link StatusLineOptions.pending}. The renderer reads it as well as
   * forwarding it: streamed text and a line being typed are the two things
   * that cannot be on screen at the same moment, and this is how it knows.
   */
  readonly pending?: () => string | undefined;
  /** How many typed lines are waiting for this turn to end. */
  readonly queued?: () => number;
}

/**
 * How much streamed text is held back while the user types, before it is let
 * through anyway.
 *
 * There has to be a bound: the hold ends when the line is sent, and a user who
 * types half a sentence and then goes to lunch must not take the answer with
 * them. Generous enough that an ordinary interruption — a few seconds of
 * typing — is covered whole.
 */
const MAX_HELD_CHARS = 4000;

/**
 * Plain-text human renderer. Styled only when `output` is a TTY and the
 * environment allows colour; every escape it writes comes from one role in
 * `styles.ts`, and the assistant's own text is the one thing it never styles.
 *
 * Assistant text is streamed: `model.text.delta` events are written as they
 * arrive, without a trailing newline, and the line is terminated when the turn
 * ends or anything else needs printing. `model.turn.completed` still carries
 * the whole turn — it is printed only when no delta was streamed for it, which
 * is what keeps a non-streaming provider (or an event log replayed after the
 * fact) rendering exactly as before instead of printing the text twice.
 */
export class TextRenderer implements Renderer {
  readonly #output: NodeJS.WritableStream;
  readonly #styles: Styles;
  readonly #status: StatusLine;
  /** A streamed line is open — text was written with no newline after it. */
  #streaming = false;
  /** Deltas were streamed for the model turn now in flight. */
  #streamed = false;
  /** A turn this renderer is showing progress for is in flight. */
  #inTurn = false;
  /**
   * Text of the Claude Code block currently streaming, for the one case that
   * cannot be streamed to the screen: a delegated *task* inside an
   * orchestration run, whose output shares the terminal with other tasks.
   */
  #claudeText = "";
  /** What the user is typing into this turn, when anything. */
  readonly #pending: (() => string | undefined) | undefined;
  /** Streamed text kept back while they type it — see {@link #hold}. */
  #held = "";

  constructor(
    output: NodeJS.WritableStream = process.stdout,
    options: TextRendererOptions = {},
  ) {
    this.#output = output;
    this.#styles = options.styles ?? stylesFor(output as { isTTY?: boolean });
    this.#pending = options.pending;
    this.#status =
      options.status ??
      new StatusLine({
        output: output as StatusLineStream,
        ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
        ...(options.suspended === undefined
          ? {}
          : { suspended: options.suspended }),
        ...(options.frame === undefined ? {} : { frame: options.frame }),
        ...(options.pending === undefined ? {} : { pending: options.pending }),
        ...(options.queued === undefined ? {} : { queued: options.queued }),
      });
  }

  /**
   * Writes one line of output, taking the screen back from the status line and
   * from any partially streamed text first.
   */
  #write(line: string): void {
    this.#endStream();
    this.#status.erase();
    this.#output.write(`${line}\n`);
    this.#status.refresh();
  }

  /**
   * Writes one line *without* ending the turn it lands in the middle of.
   *
   * {@link line}'s mid-turn counterpart, and the difference is the whole
   * point: the REPL's own notices normally arrive between turns, so `line`
   * takes the status block down before writing. A notice about the turn that
   * is still running ("queued — runs after this turn") must leave the block
   * exactly where it is, spinner and all, and this writes through the same
   * erase/print/repaint discipline to put it back.
   */
  interject(text: string): void {
    this.#write(text);
  }

  /**
   * The line the user is typing into this turn changed: repaint the block
   * that is carrying it.
   *
   * Called on every mid-turn keystroke. Three cases, all of them here rather
   * than at the call site because they are about what is on screen: the block
   * is up and simply needs redrawing; the block was stopped by streamed text
   * and has to be started again so the typed line has a row to live on; or the
   * line has just been sent, and whatever was held back while they typed can
   * finally be printed.
   */
  pendingChanged(): void {
    if (!this.#inTurn) return;
    if (this.#pending?.() === undefined) {
      this.#release();
      return;
    }
    if (this.#status.running) {
      this.#status.refresh();
      return;
    }
    // A streamed line is open: end its row first, or the block would be
    // painted straight over the text the model just produced.
    this.#endStream();
    this.#status.start(THINKING_LABEL);
  }

  /**
   * Whether streamed text should wait rather than be printed.
   *
   * It waits while the user is mid-sentence, because the two want the same
   * row: text arriving without a newline leaves the cursor inside a line the
   * status block would otherwise erase from underneath it. Holding it is the
   * one arrangement in which the answer and the line being typed both stay
   * legible — the answer simply arrives in a burst when the line is sent.
   */
  #hold(): boolean {
    if (this.#pending === undefined) return false;
    if (this.#held.length >= MAX_HELD_CHARS) return false;
    return this.#pending() !== undefined;
  }

  /** Prints whatever {@link #hold} kept back, if anything. */
  #release(): void {
    if (this.#held === "") return;
    const text = this.#held;
    this.#held = "";
    this.#emitStream(text);
  }

  /**
   * Writes one line of caller-owned output (the REPL's own notices) through
   * the same discipline, and ends any status the turn left running.
   *
   * The interactive shell prints its per-turn lines itself rather than through
   * an event; routing them here is what keeps them from landing on top of a
   * spinner.
   */
  line(text: string): void {
    this.#endTurn();
    this.#write(text);
  }

  /** Appends streamed assistant text, with no line terminator of its own. */
  #stream(text: string): void {
    if (text === "") return;
    if (this.#hold()) {
      this.#held += text;
      // Still counts as streamed: the turn's whole text must not be printed a
      // second time when it completes just because this chunk is waiting.
      this.#streamed = true;
      return;
    }
    this.#emitStream(`${this.#held}${text}`);
    this.#held = "";
  }

  /** The write half of {@link #stream}, shared with {@link #release}. */
  #emitStream(text: string): void {
    if (text === "") return;
    // Text on screen *is* the progress report; a spinner next to it is noise.
    this.#status.stop();
    this.#output.write(text);
    this.#streaming = true;
    this.#streamed = true;
  }

  /** Terminates an open streamed line, if there is one. */
  #endStream(): void {
    // Anything held back for a line being typed goes out first: it belongs
    // *inside* the row about to be closed, not after it.
    this.#release();
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#output.write("\n");
  }

  /** A turn started: from here on there is something to show progress for. */
  #beginTurn(): void {
    this.#inTurn = true;
    this.#streamed = false;
    this.#status.start(THINKING_LABEL);
  }

  /**
   * Relabels the status, but only while a turn is actually in flight — which
   * is never the case for an orchestration run, whose turns all carry a task
   * id and so never call {@link #beginTurn}.
   */
  #waiting(label: string): void {
    if (!this.#inTurn) return;
    this.#status.start(label);
  }

  /** A turn ended (or output took over): nothing is pending on screen. */
  #endTurn(): void {
    this.#inTurn = false;
    this.#endStream();
    this.#status.stop();
  }

  /** The machine's trace: tool calls, task lifecycle, metering. */
  #dim(text: string): string {
    return this.#styles.tool(text);
  }

  /** A verdict or a section title. */
  #bold(text: string): string {
    return this.#styles.heading(text);
  }

  /** `✓`-shaped good news. */
  #ok(text: string): string {
    return this.#styles.ok(text);
  }

  /** Something the run survived but the reader has to know about. */
  #warn(text: string): string {
    return this.#styles.warn(text);
  }

  /** Something failed. */
  #bad(text: string): string {
    return this.#styles.error(text);
  }

  emit(event: AgentEvent): void {
    const data = isRecord(event.data) ? event.data : {};
    // A run with tasks is many conversations at once: their deltas would
    // interleave into one unreadable line, and one status line cannot speak
    // for several tasks. Those runs keep the turn-level rendering they had.
    const single = event.taskId === undefined;

    if (event.type.startsWith(CODEX_PREFIX)) {
      this.#emitCodex(data);
      return;
    }

    if (event.type.startsWith(CLAUDE_CODE_PREFIX)) {
      this.#emitClaudeCode(
        event.type.slice(CLAUDE_CODE_PREFIX.length),
        data,
        single,
      );
      return;
    }

    switch (event.type) {
      case "chat.turn.started":
      case "loop.started": {
        if (single) this.#beginTurn();
        break;
      }
      case "chat.turn.completed":
      case "loop.completed": {
        if (single) this.#endTurn();
        break;
      }
      case MODEL_TEXT_DELTA_EVENT: {
        if (!single) break;
        if (typeof data.text === "string") this.#stream(data.text);
        break;
      }
      case "model.turn.completed": {
        const text = typeof data.text === "string" ? data.text : "";
        if (this.#streamed) {
          // Already on screen, a delta at a time: printing it again would
          // double every word of the turn.
          this.#endStream();
          this.#streamed = false;
        } else if (text !== "") {
          this.#write(text);
        }
        this.#waiting(THINKING_LABEL);
        break;
      }
      case "tool.execution.started": {
        const tool = typeof data.tool === "string" ? data.tool : "?";
        this.#write(
          `${this.#dim("→")} ${tool} ${this.#dim(previewInput(data.input))}`,
        );
        this.#waiting(tool);
        break;
      }
      case "tool.execution.completed": {
        const ok = data.ok === true;
        const denied = data.denied === true;
        this.#write(
          ok
            ? `  ${this.#ok("✓")}`
            : `  ${this.#bad("✗")} ${this.#dim(`(${denied ? "denied" : "error"})`)}`,
        );
        this.#waiting(THINKING_LABEL);
        break;
      }
      case "context.compacted": {
        const elided = typeof data.elided === "number" ? data.elided : 0;
        const savedChars =
          typeof data.savedChars === "number" ? data.savedChars : 0;
        this.#write(
          this.#dim(
            `≈ context compacted: ${elided} tool result${elided === 1 ? "" : "s"} elided, ${savedChars} chars saved`,
          ),
        );
        break;
      }
      case "task.started":
      case "task.completed":
      case "task.escalated":
      case "task.cancelled":
      case "task.low_confidence":
        this.#emitTaskLifecycle(event.type, taskIdOf(event, data), data);
        break;
      case "worktree.created":
      case "worktree.integrated":
      case "worktree.removed":
        this.#emitWorktree(event.type, taskIdOf(event, data), data);
        break;
      case "validation.started":
      case "validation.completed":
        this.#emitValidation(event.type, taskIdOf(event, data), data);
        break;
      default:
        break;
    }
  }

  /**
   * Renders the scheduler's `task.*` events — the orchestration run's spine.
   *
   * These share the sink with the worker loop's own events, so a task line has
   * to be identifiable on its own: every one of them leads with the task id.
   */
  #emitTaskLifecycle(
    type: string,
    taskId: string,
    data: Record<string, unknown>,
  ): void {
    switch (type) {
      case "task.started": {
        const agent = stringOrUndefined(data.agent) ?? "?";
        const attempt = typeof data.attempt === "number" ? data.attempt : 1;
        const model = stringOrUndefined(data.model);
        const modelSuffix = model === undefined ? "" : ` [${model}]`;
        const routing = routingLabel(data.routing);
        const parens =
          routing === undefined
            ? `attempt ${attempt}`
            : `${routing}, attempt ${attempt}`;
        this.#write(
          `${this.#dim("▶")} ${taskId} → ${agent}${modelSuffix} ${this.#dim(`(${parens})`)}`,
        );
        break;
      }
      case "task.completed": {
        const result = isRecord(data.result) ? data.result : {};
        const ok = result.status === "success";
        // `final: false` means the scheduler is going to retry this task, so
        // the failure being reported is not the task's verdict yet.
        const retrying = data.final === false;
        const suffix = retrying ? this.#dim(" (retrying)") : "";
        this.#write(
          `${ok ? this.#ok("✔") : this.#bad("✖")} ${taskId} — ${firstLine(result.summary)}${suffix}`,
        );
        break;
      }
      case "task.escalated": {
        const from = stringOrUndefined(data.from) ?? "(unassigned)";
        const to = stringOrUndefined(data.to) ?? "?";
        this.#write(`${this.#warn("↑")} ${taskId} rerouted ${from} → ${to}`);
        break;
      }
      case "task.cancelled": {
        const reason = stringOrUndefined(data.reason) ?? "cancelled";
        this.#write(`${this.#warn("⊘")} ${taskId} ${this.#dim(`(${reason})`)}`);
        break;
      }
      case "task.low_confidence": {
        const confidence =
          typeof data.confidence === "number" ? data.confidence : 0;
        const threshold =
          typeof data.threshold === "number" ? data.threshold : 0;
        const verdict =
          data.accepted === true ? "accepted (attempts exhausted)" : "redoing";
        this.#write(
          `${this.#warn("↻")} ${taskId} low confidence ${confidence.toFixed(2)} < ${threshold.toFixed(2)} — ${verdict}`,
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Renders the worktree isolation layer's `worktree.*` events.
   *
   * Only the moments that change what is in the repository get a line: a task
   * got its own checkout, its work landed (or did not), and a branch outlived
   * the run and is waiting for a human. A clean removal is the expected case
   * and stays silent.
   */
  #emitWorktree(
    type: string,
    taskId: string,
    data: Record<string, unknown>,
  ): void {
    switch (type) {
      case "worktree.created": {
        const branch = stringOrUndefined(data.branch) ?? "?";
        this.#write(this.#dim(`⎇ ${taskId} worktree created (${branch})`));
        break;
      }
      case "worktree.integrated": {
        if (data.merged === true) {
          const commit = stringOrUndefined(data.commit);
          const suffix = commit === undefined ? "" : ` → ${commit.slice(0, 8)}`;
          this.#write(`${this.#ok("⇡")} ${taskId} merged${suffix}`);
          break;
        }
        const files = Array.isArray(data.conflictFiles)
          ? data.conflictFiles.filter(
              (file): file is string => typeof file === "string",
            )
          : [];
        if (files.length > 0) {
          this.#write(
            this.#warn(`⚠ ${taskId} merge conflict: ${files.join(", ")}`),
          );
          break;
        }
        // The reason alone ("dirty-base") does not say what is in the way;
        // the detail names the offending paths, which is the only form of
        // this message a reader can act on.
        const reason = stringOrUndefined(data.reason) ?? "unknown reason";
        const detail = stringOrUndefined(data.detail);
        this.#write(
          this.#warn(
            detail === undefined
              ? `⚠ ${taskId} not merged (${reason})`
              : `⚠ ${taskId} not merged (${reason}): ${detail}`,
          ),
        );
        break;
      }
      case "worktree.removed": {
        if (data.keptBranch !== true) break;
        const branch = stringOrUndefined(data.branch) ?? "?";
        this.#write(this.#dim(`⎇ ${taskId} branch kept: ${branch}`));
        break;
      }
      default:
        break;
    }
  }

  /**
   * Renders the `validation.*` events {@link ValidatingExecutor} emits around
   * each configured validator command.
   *
   * Kept quiet and dim on the way in — a validator starting is background
   * noise most of the time — but its result always lands, pass or fail, since
   * that is what decides whether the task's work is going to be kept.
   */
  #emitValidation(
    type: string,
    taskId: string,
    data: Record<string, unknown>,
  ): void {
    switch (type) {
      case "validation.started": {
        const name = stringOrUndefined(data.name) ?? "?";
        this.#write(this.#dim(`⚙ ${taskId} validator ${name}…`));
        break;
      }
      case "validation.completed": {
        const name = stringOrUndefined(data.name) ?? "?";
        const passed = data.passed === true;
        const seconds =
          typeof data.durationMs === "number" ? data.durationMs / 1000 : 0;
        const duration = `${seconds.toFixed(1)}s`;
        if (passed) {
          this.#write(
            `  ${this.#ok("✓")} ${name} ${this.#dim(`(${duration})`)}`,
          );
          break;
        }
        const exitCode =
          typeof data.exitCode === "number" ? String(data.exitCode) : "unknown";
        this.#write(
          `  ${this.#bad("✗")} ${name} ${this.#bad(`(exit ${exitCode}, ${duration})`)}`,
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Renders a normalized `codex.*` event. Only `item.*` events whose nested
   * item is `agent_message` / `command_execution` / `file_change` produce
   * output — everything else (`turn.completed` usage rollups, the synthetic
   * `codex.completed` marker, and any event type this wrapper doesn't
   * recognize yet) stays quiet, matching the native renderer's silence on
   * unknown event types.
   */
  #emitCodex(data: Record<string, unknown>): void {
    const item = codexItemFrom(data);
    if (item === undefined) return;

    const itemType = typeof item.type === "string" ? item.type : undefined;
    switch (itemType) {
      case "agent_message": {
        const text = codexMessageText(item);
        if (text !== undefined && text.trim() !== "") this.#write(text);
        break;
      }
      case "command_execution": {
        const command = codexCommandText(item);
        if (command !== undefined) {
          this.#write(
            `${this.#dim("→")} codex: ${this.#dim(truncate(command, 120))}`,
          );
        }
        break;
      }
      case "file_change": {
        const summary = codexFileChangeText(item);
        if (summary !== undefined) {
          this.#write(`${this.#dim("✎")} ${summary}`);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Renders a normalized `claude-code.*` event.
   *
   * The payload is a raw Claude API streaming line, so the two things worth
   * showing are pulled out of it by hand: the assistant's own text, streamed a
   * delta at a time exactly like the native loop's (buffered to the end of the
   * block only when the events belong to one task among several, where partial
   * lines from different tasks would interleave), and the name of each tool
   * as it starts, which is what makes a long turn legible. Everything else —
   * `message_start`, usage rollups, the synthetic `completed` marker, and any
   * event type this wrapper does not model yet — stays quiet, exactly as the
   * native renderer does for unknown types.
   */
  #emitClaudeCode(
    kind: string,
    data: Record<string, unknown>,
    single: boolean,
  ): void {
    const event = isRecord(data.event) ? data.event : data;

    switch (kind) {
      case "tool_use": {
        const name =
          typeof data.name === "string" && data.name !== ""
            ? data.name
            : "tool";
        this.#write(`${this.#dim("→")} claude: ${name}`);
        this.#waiting(name);
        break;
      }
      case "content_block_delta": {
        const delta = isRecord(event.delta) ? event.delta : undefined;
        if (delta?.type !== "text_delta") break;
        if (typeof delta.text !== "string") break;
        if (single) this.#stream(delta.text);
        else this.#claudeText += delta.text;
        break;
      }
      case "content_block_stop":
      case "message_stop": {
        this.#endStream();
        const buffered = this.#claudeText.trim();
        this.#claudeText = "";
        if (buffered !== "") this.#write(buffered);
        this.#waiting(THINKING_LABEL);
        break;
      }
      default:
        break;
    }
  }

  result(result: CliRunResult, usage: UsageTotals): void {
    this.#endTurn();
    this.#write("");
    // The verdict is the one line of a finished run that has to be findable
    // from across the room: bold always, and coloured by what it says.
    const verdict = this.#bold(`status: ${EXIT_LABEL[result.status]}`);
    this.#write(
      result.status === "success"
        ? this.#ok(verdict)
        : result.status === "partial"
          ? this.#warn(verdict)
          : this.#bad(verdict),
    );
    this.#write(result.summary);

    if (isDelegatedResult(result)) {
      if (result.exitCode !== null && result.exitCode !== 0) {
        this.#write(this.#dim(`exit code: ${result.exitCode}`));
      }
      // The native UsageTracker never sees any calls on the Codex path (its
      // totals are always zero there), so prefer the result's own usage.
      if (result.usage !== undefined) {
        this.#write(
          this.#dim(
            `tokens — input: ${result.usage.inputTokens}, output: ${result.usage.outputTokens}`,
          ),
        );
      }
      return;
    }

    this.#write(
      this.#dim(
        `iterations: ${result.iterations}  tool calls: ${result.toolCalls}`,
      ),
    );
    const { usage: totals, costUsd } = usage;
    const tokenParts = [
      `input: ${totals.inputTokens}`,
      `output: ${totals.outputTokens}`,
    ];
    if (totals.cachedInputTokens !== undefined) {
      tokenParts.push(`cached: ${totals.cachedInputTokens}`);
    }
    let usageLine = `tokens — ${tokenParts.join(", ")}`;
    if (costUsd > 0) usageLine += `  (~$${costUsd.toFixed(4)})`;
    this.#write(this.#dim(usageLine));
  }
}

/** JSONL renderer: every event and the final result are one JSON line each on stdout. */
export class JsonRenderer implements Renderer {
  readonly #output: NodeJS.WritableStream;

  constructor(output: NodeJS.WritableStream = process.stdout) {
    this.#output = output;
  }

  emit(event: AgentEvent): void {
    this.#output.write(`${JSON.stringify(event)}\n`);
  }

  result(result: CliRunResult, usage: UsageTotals): void {
    // Codex runs bypass the UsageTracker (its totals stay zero), so prefer
    // the usage the backend itself reported in that case.
    const trackerIsEmpty =
      usage.usage.inputTokens === 0 && usage.usage.outputTokens === 0;
    const reported =
      trackerIsEmpty && "usage" in result && result.usage !== undefined
        ? result.usage
        : usage.usage;
    const line = {
      type: "result",
      ...result,
      usage: reported,
      costUsd: usage.costUsd,
    };
    this.#output.write(`${JSON.stringify(line)}\n`);
  }
}
