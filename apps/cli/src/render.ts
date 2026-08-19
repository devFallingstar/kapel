import type { UsageTotals } from "@agent/ai";
import type { AgentLoopResult, CodexRunResult } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { previewInput } from "./prompter.js";

/** Either shape a run can finish with: the native loop, or a Codex backend run. */
export type CliRunResult = AgentLoopResult | CodexRunResult;

/** Renders loop events (and the final result) to an output stream. */
export interface Renderer extends EventSink {
  result(result: CliRunResult, usage: UsageTotals): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `CodexRunResult` is the only `CliRunResult` shape carrying `exitCode`/`events`. */
function isCodexResult(result: CliRunResult): result is CodexRunResult {
  return "events" in result;
}

const CODEX_PREFIX = "codex.";

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

/** The first non-empty line of a task summary, for one-line task reporting. */
function firstLine(text: unknown): string {
  if (typeof text !== "string") return "(no summary)";
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "(no summary)" : truncate(line, 120);
}

function ansi(code: string, text: string, enabled: boolean): string {
  return enabled ? `[${code}m${text}[0m` : text;
}

const EXIT_LABEL: Record<CliRunResult["status"], string> = {
  success: "success",
  partial: "partial",
  failed: "failed",
};

/** Plain-text human renderer. Uses ANSI dim/bold only when `output` is a TTY. */
export class TextRenderer implements Renderer {
  readonly #output: NodeJS.WritableStream;
  readonly #color: boolean;

  constructor(output: NodeJS.WritableStream = process.stdout) {
    this.#output = output;
    this.#color =
      "isTTY" in output && (output as { isTTY?: boolean }).isTTY === true;
  }

  #write(line: string): void {
    this.#output.write(`${line}\n`);
  }

  #dim(text: string): string {
    return ansi("2", text, this.#color);
  }

  #bold(text: string): string {
    return ansi("1", text, this.#color);
  }

  emit(event: AgentEvent): void {
    const data = isRecord(event.data) ? event.data : {};

    if (event.type.startsWith(CODEX_PREFIX)) {
      this.#emitCodex(data);
      return;
    }

    switch (event.type) {
      case "model.turn.completed": {
        const text = typeof data.text === "string" ? data.text : "";
        if (text !== "") this.#write(text);
        break;
      }
      case "tool.execution.started": {
        const tool = typeof data.tool === "string" ? data.tool : "?";
        this.#write(
          `${this.#dim("→")} ${tool} ${this.#dim(previewInput(data.input))}`,
        );
        break;
      }
      case "tool.execution.completed": {
        const ok = data.ok === true;
        const denied = data.denied === true;
        this.#write(ok ? "  ✓" : `  ✗ (${denied ? "denied" : "error"})`);
        break;
      }
      case "task.started":
      case "task.completed":
      case "task.escalated":
      case "task.cancelled":
        this.#emitTaskLifecycle(event.type, taskIdOf(event, data), data);
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
        this.#write(`▶ ${taskId} → ${agent} (attempt ${attempt})`);
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
          `${ok ? "✔" : "✖"} ${taskId} — ${firstLine(result.summary)}${suffix}`,
        );
        break;
      }
      case "task.escalated": {
        const from = stringOrUndefined(data.from) ?? "(unassigned)";
        const to = stringOrUndefined(data.to) ?? "?";
        this.#write(`↑ ${taskId} rerouted ${from} → ${to}`);
        break;
      }
      case "task.cancelled": {
        const reason = stringOrUndefined(data.reason) ?? "cancelled";
        this.#write(`⊘ ${taskId} (${reason})`);
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
          this.#write(`→ codex: ${truncate(command, 120)}`);
        }
        break;
      }
      case "file_change": {
        const summary = codexFileChangeText(item);
        if (summary !== undefined) this.#write(`✎ ${summary}`);
        break;
      }
      default:
        break;
    }
  }

  result(result: CliRunResult, usage: UsageTotals): void {
    this.#write("");
    this.#write(this.#bold(`status: ${EXIT_LABEL[result.status]}`));
    this.#write(result.summary);

    if (isCodexResult(result)) {
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
