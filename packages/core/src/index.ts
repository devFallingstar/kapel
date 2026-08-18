import type { ModelDefinition, ToolDefinition } from "@agent/ai";

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

export interface AgentRunInput {
  readonly instruction: string;
  readonly context?: readonly string[];
}

export interface AgentRunResult {
  readonly status: "success" | "failed" | "partial";
  readonly summary: string;
  readonly output?: string;
}
