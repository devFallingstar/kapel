import type { UsageTags } from "./usage.js";

export type ModelRole = "orchestrator" | "worker" | "reviewer";

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly structuredOutput: boolean;
}

/**
 * Per-million-token prices in USD.
 *
 * `cachedInputPerMTok` is the rate applied to `ModelUsage.cachedInputTokens`.
 * When omitted, cached input is billed at `inputPerMTok`.
 */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cachedInputPerMTok?: number;
}

export interface ModelDefinition {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities: ModelCapabilities;
  readonly pricing?: ModelPricing;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Image formats a provider's vision input accepts (P1-9's `-i/--image`). Both
 * Anthropic's Messages API and OpenAI's Chat Completions accept exactly this
 * set as base64-encoded content.
 */
export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/**
 * One image attached to a user turn, ready to serialize as a provider
 * content block. `base64` carries the raw encoded bytes with no `data:` URL
 * prefix — each provider's request builder adds whatever wrapper its own
 * wire format wants.
 */
export interface ImagePart {
  readonly mediaType: ImageMediaType;
  readonly base64: string;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /**
   * Set on `role: "user"` messages that attach images (P1-9). A provider
   * that cannot express `ModelMessage.images` at all should not claim
   * {@link ModelCapabilities.vision}; providers in this package that do
   * claim it serialize this into their own image content block shape.
   */
  readonly images?: readonly ImagePart[];
  /** Set on `role: "tool"` messages: the id of the call this result answers. */
  readonly toolCallId?: string;
  /** Set on `role: "assistant"` messages that requested tool calls. */
  readonly toolCalls?: readonly ToolCall[];
  /** Set on `role: "tool"` messages when the tool execution failed. */
  readonly isError?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * How the model is allowed (or forced) to use the supplied tools.
 *
 * - `auto`: the model decides between text and tool calls.
 * - `any`: the model must call some tool, but picks which one.
 * - `tool`: the model must call the named tool — the way to get structured
 *   output out of a provider that has no dedicated response-format knob.
 */
export type ToolChoice =
  | { readonly type: "auto" }
  | { readonly type: "any" }
  | { readonly type: "tool"; readonly name: string };

export interface ModelRequest {
  readonly model: ModelDefinition;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolDefinition[];
  /** Omitted means "let the provider apply its own default". */
  readonly toolChoice?: ToolChoice;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/**
 * Normalized token usage for a single model turn.
 *
 * `inputTokens` and `cachedInputTokens` are treated as disjoint buckets by
 * {@link UsageRecorder} implementations in this package.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export type ModelEvent =
  | { readonly type: "text.delta"; readonly text: string }
  | {
      readonly type: "tool.call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens?: number;
    }
  | { readonly type: "done"; readonly finishReason: string };

export interface ModelProvider {
  readonly id: string;
  supports(model: ModelDefinition): boolean;
  stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}

export interface ModelRegistry {
  get(alias: string): ModelDefinition;
  providerFor(model: ModelDefinition): ModelProvider;
}

/**
 * Sink for accumulating token usage (and therefore cost) across turns.
 *
 * `tags` is optional on both sides of the contract: a caller that knows which
 * agent or task is spending says so, an older two-argument call still records,
 * and an implementation is free to ignore the attribution entirely.
 */
export interface UsageRecorder {
  record(model: ModelDefinition, usage: ModelUsage, tags?: UsageTags): void;
}

export { defaultModelCatalog } from "./catalog.js";
export {
  mediaTypeFromExtension,
  resolveImageMediaType,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  sniffImageMediaType,
} from "./image.js";
export type { AnthropicProviderOptions } from "./providers/anthropic.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export type { ProviderErrorInit } from "./providers/errors.js";
export { ProviderError } from "./providers/errors.js";
export type { OpenAIProviderOptions } from "./providers/openai.js";
export { OpenAIProvider } from "./providers/openai.js";
export { StaticModelRegistry } from "./registry.js";
export type { SseMessage } from "./sse.js";
export { parseSse } from "./sse.js";
export type {
  UsageBreakdown,
  UsageDimension,
  UsagePricing,
  UsageTags,
  UsageTotals,
} from "./usage.js";
export {
  UNATTRIBUTED,
  UsageTracker,
  usageCostUsd,
  usageRecordingProvider,
} from "./usage.js";
