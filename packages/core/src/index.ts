import type {
  ImageMediaType,
  ModelDefinition,
  ToolDefinition,
} from "@agent/ai";

export type AgentRole = "orchestrator" | "worker" | "reviewer";
export type PermissionDecision = "allow" | "ask" | "deny";

/**
 * The answer to one live permission ask, as the prompter reports it back.
 *
 * Deliberately *not* a {@link PermissionDecision}: that union is the
 * configured verdict for a tool, the thing an agent definition or a config
 * file stores, and it stays a closed three-way vocabulary. This is one
 * human's answer to one question, and unlike a stored rule it may carry
 * words.
 *
 * `feedback` is what makes a refusal conversational: the user declined the
 * action *and said why*, or said what to do instead ("use the config file
 * instead"). The call is never executed either way — a denial with feedback
 * is still a denial — but the loop hands those words back to the model, so
 * the turn continues as a conversation rather than stopping at "no".
 */
export type AskOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly feedback?: string };

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
  /**
   * Images attached by *path* instead of by bytes: absolute filesystem paths
   * for a delegating CLI backend to open itself — Codex takes them as repeated
   * `-i <path>` flags, Claude Code is told to read them with its own tools.
   * Validated by the caller exactly as {@link images} are (the file exists, is
   * inside the workspace, and is within the per-image size cap), so a backend
   * can forward them as-is.
   */
  readonly imagePaths?: readonly string[];
}

export interface AgentRunResult {
  readonly status: "success" | "failed" | "partial";
  readonly summary: string;
  readonly output?: string;
}
