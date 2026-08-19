import type {
  ImageMediaType,
  ModelDefinition,
  ToolDefinition,
} from "@agent/ai";

export type AgentRole = "orchestrator" | "worker" | "reviewer";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface AgentDefinition {
  readonly name: string;
  readonly role: AgentRole;
  readonly model: ModelDefinition;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly permissions: Readonly<Record<string, PermissionDecision>>;
}

export interface ToolContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  definition(): ToolDefinition;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolRegistry {
  get(name: string): Tool;
  listFor(agent: AgentDefinition): readonly Tool[];
}

/**
 * One image attached to a run (P1-9's `-i/--image`). `base64` is what the
 * native loop hands the model as an `ImagePart`; `path` is the absolute
 * filesystem path it was read from, which delegated CLI backends that take
 * a path rather than inline bytes (e.g. Codex's `-i`) forward as-is.
 */
export interface AgentImageAttachment {
  readonly mediaType: ImageMediaType;
  readonly base64: string;
  readonly path: string;
}

export interface AgentRunInput {
  readonly instruction: string;
  readonly context?: readonly string[];
  /** Images attached to this run, already validated and read (P1-9). */
  readonly images?: readonly AgentImageAttachment[];
}

export interface AgentRunResult {
  readonly status: "success" | "failed" | "partial";
  readonly summary: string;
  readonly output?: string;
}
