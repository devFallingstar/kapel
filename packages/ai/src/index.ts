export type ModelRole = "orchestrator" | "worker" | "reviewer";

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly structuredOutput: boolean;
}

export interface ModelDefinition {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities: ModelCapabilities;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ModelRequest {
  readonly model: ModelDefinition;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export type ModelEvent =
  | { readonly type: "text.delta"; readonly text: string }
  | { readonly type: "tool.call"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number }
  | { readonly type: "done"; readonly finishReason: string };

export interface ModelProvider {
  readonly id: string;
  supports(model: ModelDefinition): boolean;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelRegistry {
  get(alias: string): ModelDefinition;
  providerFor(model: ModelDefinition): ModelProvider;
}
