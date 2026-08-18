import type { UsageTotals } from "@agent/ai";
import type { AgentLoopResult } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { previewInput } from "./prompter.js";

/** Renders loop events (and the final result) to an output stream. */
export interface Renderer extends EventSink {
  result(result: AgentLoopResult, usage: UsageTotals): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ansi(code: string, text: string, enabled: boolean): string {
  return enabled ? `[${code}m${text}[0m` : text;
}

const EXIT_LABEL: Record<AgentLoopResult["status"], string> = {
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
      default:
        break;
    }
  }

  result(result: AgentLoopResult, usage: UsageTotals): void {
    this.#write("");
    this.#write(this.#bold(`status: ${EXIT_LABEL[result.status]}`));
    this.#write(result.summary);
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

  result(result: AgentLoopResult, usage: UsageTotals): void {
    const line = {
      type: "result",
      ...result,
      usage: usage.usage,
      costUsd: usage.costUsd,
    };
    this.#output.write(`${JSON.stringify(line)}\n`);
  }
}
