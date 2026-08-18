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

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Override for gateways/proxies. Defaults to the Anthropic API. */
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly Record<string, unknown>[];
}

interface PendingToolBlock {
  readonly id: string;
  readonly name: string;
  json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseToolInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function toWireTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

interface MappedMessages {
  readonly system: string | undefined;
  readonly messages: readonly WireMessage[];
}

function mapMessages(messages: readonly ModelMessage[]): MappedMessages {
  const systemParts: string[] = [];
  const wire: WireMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (message.content !== "") systemParts.push(message.content);
        break;
      case "user":
        wire.push({ role: "user", content: message.content });
        break;
      case "tool": {
        const block: Record<string, unknown> = {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content,
        };
        if (message.isError === true) block.is_error = true;
        wire.push({ role: "user", content: [block] });
        break;
      }
      case "assistant": {
        const calls = message.toolCalls ?? [];
        if (calls.length === 0) {
          wire.push({ role: "assistant", content: message.content });
          break;
        }
        const blocks: Record<string, unknown>[] = [];
        if (message.content !== "") blocks.push({ type: "text", text: message.content });
        for (const call of calls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          });
        }
        wire.push({ role: "assistant", content: blocks });
        break;
      }
    }
  }

  return {
    system: systemParts.length === 0 ? undefined : systemParts.join("\n\n"),
    messages: wire,
  };
}

/** Anthropic Messages API adapter (streaming, raw HTTP). */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";

  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(options: AnthropicProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  supports(model: ModelDefinition): boolean {
    return model.provider === "anthropic";
  }

  #buildBody(request: ModelRequest): Record<string, unknown> {
    const { system, messages } = mapMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model.id,
      max_tokens:
        request.maxOutputTokens ?? request.model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages,
    };
    if (system !== undefined) body.system = system;
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    return body;
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
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
        message: `Anthropic request failed with status ${response.status}`,
        body,
      });
    }
    if (response.body === null) {
      throw new ProviderError({
        provider: this.id,
        status: response.status,
        message: "Anthropic response had no body",
      });
    }

    const blocks = new Map<number, PendingToolBlock>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let finishReason = "end_turn";

    const readUsage = (usage: unknown): void => {
      if (!isRecord(usage)) return;
      if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
      if (typeof usage.cache_read_input_tokens === "number") {
        cachedInputTokens = usage.cache_read_input_tokens;
      }
    };

    const finalEvents = (): ModelEvent[] => [
      {
        type: "usage",
        inputTokens,
        outputTokens,
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      },
      { type: "done", finishReason },
    ];

    for await (const message of parseSse(response.body, signal)) {
      if (signal?.aborted) return;

      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (!isRecord(payload)) continue;

      const type = typeof payload.type === "string" ? payload.type : (message.event ?? "");

      if (type === "error") {
        const error = isRecord(payload.error) ? payload.error : undefined;
        const detail =
          error !== undefined && typeof error.message === "string"
            ? error.message
            : "Anthropic stream error";
        throw new ProviderError({
          provider: this.id,
          status: response.status,
          message: detail,
          body: message.data,
        });
      }

      if (type === "message_start") {
        const wrapped = isRecord(payload.message) ? payload.message : undefined;
        if (wrapped !== undefined) readUsage(wrapped.usage);
        continue;
      }

      if (type === "content_block_start") {
        const index = asNumber(payload.index);
        const block = isRecord(payload.content_block) ? payload.content_block : undefined;
        if (block !== undefined && block.type === "tool_use") {
          blocks.set(index, {
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            json: "",
          });
        }
        continue;
      }

      if (type === "content_block_delta") {
        const index = asNumber(payload.index);
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (delta === undefined) continue;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (delta.text !== "") yield { type: "text.delta", text: delta.text };
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const pendingBlock = blocks.get(index);
          if (pendingBlock !== undefined) pendingBlock.json += delta.partial_json;
        }
        continue;
      }

      if (type === "content_block_stop") {
        const index = asNumber(payload.index);
        const pendingBlock = blocks.get(index);
        if (pendingBlock !== undefined) {
          blocks.delete(index);
          yield {
            type: "tool.call",
            id: pendingBlock.id,
            name: pendingBlock.name,
            input: parseToolInput(pendingBlock.json),
          };
        }
        continue;
      }

      if (type === "message_delta") {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (delta !== undefined && typeof delta.stop_reason === "string") {
          finishReason = delta.stop_reason;
        }
        readUsage(payload.usage);
        continue;
      }

      if (type === "message_stop") {
        for (const event of finalEvents()) yield event;
        return;
      }
    }

    if (signal?.aborted) return;
    for (const event of finalEvents()) yield event;
  }
}
