import type {
  ModelDefinition,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ToolDefinition,
} from "../index.js";
import { parseSse } from "../sse.js";
import { ProviderError } from "./errors.js";

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  /** Override for OpenAI-compatible servers. Defaults to the OpenAI API. */
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface WireToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface WireMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toWireMessage(message: ModelMessage): WireMessage {
  switch (message.role) {
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
      };
    case "assistant": {
      const calls = message.toolCalls ?? [];
      if (calls.length === 0)
        return { role: "assistant", content: message.content };
      return {
        role: "assistant",
        content: message.content === "" ? null : message.content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      };
    }
    default:
      return { role: message.role, content: message.content };
  }
}

function toWireTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/** Chat Completions adapter, usable against OpenAI and compatible servers. */
export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";

  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(options: OpenAIProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  supports(model: ModelDefinition): boolean {
    return (
      model.provider === "openai" || model.provider === "openai-compatible"
    );
  }

  #buildBody(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model.id,
      stream: true,
      stream_options: { include_usage: true },
      messages: request.messages.map(toWireMessage),
    };
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
    }
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) {
      body.max_completion_tokens = request.maxOutputTokens;
    }
    return body;
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify(this.#buildBody(request)),
      signal: signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: `OpenAI request failed with status ${response.status}`,
        body,
      });
    }
    if (response.body === null) {
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: "OpenAI response had no body",
      });
    }

    const pending = new Map<number, PendingToolCall>();
    let finishReason = "stop";
    let emittedToolCalls = false;

    const flushToolCalls = (): ModelEvent[] => {
      if (emittedToolCalls) return [];
      emittedToolCalls = true;
      const indexes = [...pending.keys()].sort((a, b) => a - b);
      const events: ModelEvent[] = [];
      for (const index of indexes) {
        const call = pending.get(index);
        if (call === undefined) continue;
        events.push({
          type: "tool.call",
          id: call.id,
          name: call.name,
          input: parseArguments(call.args),
        });
      }
      return events;
    };

    for await (const message of parseSse(response.body, signal)) {
      if (signal?.aborted) return;
      if (message.data === "[DONE]") break;

      let chunk: unknown;
      try {
        chunk = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = choices[0];
      if (isRecord(choice)) {
        const delta = isRecord(choice.delta) ? choice.delta : undefined;
        if (
          delta !== undefined &&
          typeof delta.content === "string" &&
          delta.content !== ""
        ) {
          yield { type: "text.delta", text: delta.content };
        }
        if (delta !== undefined && Array.isArray(delta.tool_calls)) {
          for (const entry of delta.tool_calls) {
            if (!isRecord(entry)) continue;
            const index = typeof entry.index === "number" ? entry.index : 0;
            let call = pending.get(index);
            if (call === undefined) {
              call = { id: "", name: "", args: "" };
              pending.set(index, call);
            }
            if (typeof entry.id === "string") call.id = entry.id;
            const fn = isRecord(entry.function) ? entry.function : undefined;
            if (fn !== undefined) {
              if (typeof fn.name === "string") call.name = fn.name;
              if (typeof fn.arguments === "string") call.args += fn.arguments;
            }
          }
        }
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
          for (const event of flushToolCalls()) yield event;
        }
      }

      if (isRecord(chunk.usage)) {
        const usage = chunk.usage;
        const details = isRecord(usage.prompt_tokens_details)
          ? usage.prompt_tokens_details
          : undefined;
        const cached =
          details === undefined ? 0 : asNumber(details.cached_tokens);
        yield {
          type: "usage",
          inputTokens: asNumber(usage.prompt_tokens),
          outputTokens: asNumber(usage.completion_tokens),
          ...(cached > 0 ? { cachedInputTokens: cached } : {}),
        };
      }
    }

    if (signal?.aborted) return;
    for (const event of flushToolCalls()) yield event;
    yield { type: "done", finishReason };
  }
}
