import type {
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  ToolCall,
  ToolDefinition,
  UsageRecorder,
} from "@agent/ai";
import type {
  AgentDefinition,
  AgentRunInput,
  AgentRunResult,
  Tool,
  ToolContext,
} from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import type { PermissionEngine } from "./permissions.js";

export const DEFAULT_MAX_ITERATIONS = 32;

export interface AgentLoopOptions {
  readonly agent: AgentDefinition;
  readonly provider: ModelProvider;
  readonly tools: readonly Tool[];
  readonly permissions: PermissionEngine;
  readonly usage?: UsageRecorder;
  readonly events?: EventSink;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface AgentLoopRunContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface AgentLoopResult extends AgentRunResult {
  readonly iterations: number;
  readonly toolCalls: number;
}

/** Internal sentinel used to unwind the loop when the combined signal aborts. */
class LoopAbortedError extends Error {
  constructor() {
    super("agent loop aborted");
    this.name = "LoopAbortedError";
  }
}

interface ModelTurn {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly finishReason: string | undefined;
}

/**
 * Races a pending promise against an abort signal.
 *
 * `Promise.race` attaches handlers to both inputs, so a late rejection of the
 * losing promise is never an unhandled rejection.
 */
async function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    pending.catch(() => undefined);
    throw new LoopAbortedError();
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new LoopAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function serializeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildUserContent(input: AgentRunInput): string {
  const context = input.context ?? [];
  if (context.length === 0) return input.instruction;

  const blocks = context.map(
    (entry, index) => `<context index="${index + 1}">\n${entry}\n</context>`,
  );
  return `${input.instruction}\n\n<additional-context>\n${blocks.join("\n")}\n</additional-context>`;
}

/**
 * The M1 single-agent tool-call loop: stream a model turn, run any requested
 * tools (subject to the permission engine), feed the results back, repeat.
 */
export class AgentLoop {
  readonly #options: AgentLoopOptions;

  constructor(options: AgentLoopOptions) {
    this.#options = options;
  }

  async run(input: AgentRunInput, context: AgentLoopRunContext): Promise<AgentLoopResult> {
    const { agent, permissions, tools } = this.#options;
    const maxIterations = this.#options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const timeoutMs = this.#options.timeoutMs;

    const signals: AbortSignal[] = [];
    if (context.signal !== undefined) signals.push(context.signal);
    const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    if (timeoutSignal !== undefined) signals.push(timeoutSignal);
    const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);

    const toolsByName = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
    const definitions: readonly ToolDefinition[] = tools.map((tool) => tool.definition());
    const toolContext: ToolContext = {
      runId: context.runId,
      workspacePath: context.workspacePath,
      signal,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    };

    const messages: ModelMessage[] = [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: buildUserContent(input) },
    ];

    let iterations = 0;
    let toolCalls = 0;
    let lastNonEmptyText = "";

    await this.#emit(context, "loop.started", {
      agent: agent.name,
      model: agent.model.id,
      maxIterations,
    });

    try {
      while (iterations < maxIterations) {
        iterations += 1;

        const request: ModelRequest = {
          model: agent.model,
          messages: [...messages],
          ...(definitions.length === 0 ? {} : { tools: definitions }),
          ...(this.#options.temperature === undefined
            ? {}
            : { temperature: this.#options.temperature }),
          ...(this.#options.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: this.#options.maxOutputTokens }),
        };

        const turn = await this.#runTurn(request, signal);
        if (turn.text.trim() !== "") lastNonEmptyText = turn.text;

        messages.push({
          role: "assistant",
          content: turn.text,
          ...(turn.calls.length === 0 ? {} : { toolCalls: turn.calls }),
        });

        await this.#emit(context, "model.turn.completed", {
          ...(turn.text === "" ? {} : { text: turn.text }),
          toolCallCount: turn.calls.length,
          ...(turn.finishReason === undefined ? {} : { finishReason: turn.finishReason }),
        });

        if (turn.calls.length === 0) {
          const output = turn.text === "" ? lastNonEmptyText : turn.text;
          return await this.#complete(context, {
            status: "success",
            summary: output,
            output,
            iterations,
            toolCalls,
          });
        }

        for (const call of turn.calls) {
          toolCalls += 1;
          messages.push(await this.#executeCall(call, toolsByName, toolContext, context, signal));
        }
      }

      return await this.#complete(context, {
        status: "partial",
        summary: `Stopped after the iteration budget of ${maxIterations} was exhausted while the model was still requesting tool calls.`,
        ...(lastNonEmptyText === "" ? {} : { output: lastNonEmptyText }),
        iterations,
        toolCalls,
      });
    } catch (error) {
      if (error instanceof LoopAbortedError || signal.aborted) {
        const timedOut =
          timeoutSignal?.aborted === true ||
          (signal.reason instanceof Error && signal.reason.name === "TimeoutError");
        const summary = timedOut
          ? `Run timed out after ${String(timeoutMs)}ms.`
          : "Run cancelled before completion.";
        return await this.#complete(context, {
          status: "failed",
          summary,
          ...(lastNonEmptyText === "" ? {} : { output: lastNonEmptyText }),
          iterations,
          toolCalls,
        });
      }

      return await this.#complete(context, {
        status: "failed",
        summary: `Model request failed: ${errorMessage(error)}`,
        ...(lastNonEmptyText === "" ? {} : { output: lastNonEmptyText }),
        iterations,
        toolCalls,
      });
    }
  }

  async #runTurn(request: ModelRequest, signal: AbortSignal): Promise<ModelTurn> {
    const stream = this.#options.provider.stream(request, signal);
    const iterator = stream[Symbol.asyncIterator]();

    let text = "";
    let finishReason: string | undefined;
    const calls: ToolCall[] = [];

    try {
      for (;;) {
        const next = await raceWithAbort(iterator.next(), signal);
        if (next.done === true) break;

        const event: ModelEvent = next.value;
        switch (event.type) {
          case "text.delta":
            text += event.text;
            break;
          case "tool.call":
            calls.push({ id: event.id, name: event.name, input: event.input });
            break;
          case "usage":
            this.#recordUsage(event);
            break;
          case "done":
            finishReason = event.finishReason;
            break;
        }
      }
    } catch (error) {
      // Never let a hung or in-flight stream outlive the loop.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      throw error;
    }

    return { text, calls, finishReason };
  }

  #recordUsage(event: Extract<ModelEvent, { type: "usage" }>): void {
    const recorder = this.#options.usage;
    if (recorder === undefined) return;

    const usage: ModelUsage = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      ...(event.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: event.cachedInputTokens }),
    };
    recorder.record(this.#options.agent.model, usage);
  }

  async #executeCall(
    call: ToolCall,
    toolsByName: ReadonlyMap<string, Tool>,
    toolContext: ToolContext,
    context: AgentLoopRunContext,
    signal: AbortSignal,
  ): Promise<ModelMessage> {
    await this.#emit(context, "tool.execution.started", { tool: call.name, input: call.input });

    const tool = toolsByName.get(call.name);
    if (tool === undefined) {
      await this.#emit(context, "tool.execution.completed", { tool: call.name, ok: false });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Unknown tool: ${call.name}`,
      };
    }

    const verdict = await this.#options.permissions.authorize({
      tool: call.name,
      input: call.input,
      agent: this.#options.agent.name,
    });

    if (!verdict.allowed) {
      const reason = verdict.reason ?? "denied by policy";
      await this.#emit(context, "tool.execution.completed", {
        tool: call.name,
        ok: false,
        denied: true,
      });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Tool "${call.name}" was not permitted: ${reason}`,
      };
    }

    try {
      const output = await raceWithAbort(
        Promise.resolve(tool.execute(call.input, toolContext)),
        signal,
      );
      await this.#emit(context, "tool.execution.completed", { tool: call.name, ok: true });
      return { role: "tool", toolCallId: call.id, content: serializeToolOutput(output) };
    } catch (error) {
      if (error instanceof LoopAbortedError) throw error;
      await this.#emit(context, "tool.execution.completed", { tool: call.name, ok: false });
      return {
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `Tool "${call.name}" failed: ${errorMessage(error)}`,
      };
    }
  }

  async #complete(context: AgentLoopRunContext, result: AgentLoopResult): Promise<AgentLoopResult> {
    await this.#emit(context, "loop.completed", {
      status: result.status,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
    });
    return result;
  }

  async #emit(context: AgentLoopRunContext, type: string, data: unknown): Promise<void> {
    const sink = this.#options.events;
    if (sink === undefined) return;

    const event: AgentEvent = {
      id: crypto.randomUUID(),
      runId: context.runId,
      timestamp: Date.now(),
      type,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      data,
    };

    try {
      await sink.emit(event);
    } catch {
      // Event emission is best-effort and must never fail a run.
    }
  }
}
