import path from "node:path";
import type {
  ModelDefinition,
  ModelProvider,
  UsageRecorder,
  UsageTotals,
} from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import type { AgentLoopOptions, CompactionOptions } from "@agent/coding-agent";
import { AgentLoop, builtinTools, PermissionEngine } from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import type { EventSink } from "@agent/protocol";
import type { KapelConfig } from "./config.js";
import { resolveOrchestratorModel } from "./config-runtime.js";
import { loadDotEnvFile } from "./env.js";
import { composeSystemPrompt, loadInstructions } from "./instructions.js";
import { buildRegistry, credentialHintForProvider } from "./models.js";
import { DEFAULT_PERMISSIONS } from "./permissions.js";
import { createPrompter, createPromptState } from "./prompter.js";
import { JsonRenderer, type Renderer, TextRenderer } from "./render.js";

export interface RunObjectiveOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly maxIterations: number;
  readonly timeoutSeconds?: number;
  readonly yes: boolean;
  readonly json: boolean;
  readonly system?: string;
  /** The machine's configuration, when there is one; see `config-runtime.ts`. */
  readonly config?: KapelConfig;
}

/**
 * The native loop's default deterministic compaction, applied on every
 * run — one-shot ({@link runObjective}) and interactive (`nativeSession` in
 * `interactive.ts`) alike.
 *
 * Deliberately empty: `CompactionOptions` defers entirely to `loop.ts`'s own
 * built-in defaults (compact once a conversation exceeds 60 messages, keep
 * the most recent 20 untouched, elide only tool results over 400 chars).
 * Those numbers are exactly what the roadmap's acceptance check exercises
 * ("a 60-message conversation keeps going, leaving one compaction log
 * line"), so there is no reason to duplicate or override them here.
 */
export const DEFAULT_COMPACTION: CompactionOptions = {};

/** What {@link agentLoopOptions} needs beyond the fixed tool set and compaction default. */
export interface AgentLoopOptionsArgs {
  readonly agent: AgentDefinition;
  readonly provider: ModelProvider;
  readonly permissions: PermissionEngine;
  readonly usage: UsageRecorder;
  readonly events: EventSink;
  readonly maxIterations: number;
  readonly timeoutMs?: number;
}

/**
 * The native loop's `AgentLoopOptions`, shared between the one-shot
 * (`runObjective`) and interactive (`nativeSession` in `interactive.ts`)
 * paths so both build the same tool set and pick up {@link DEFAULT_COMPACTION}
 * the same way. Factored out (rather than inlined at each call site) so the
 * compaction wiring is directly testable without exercising a whole run.
 */
export function agentLoopOptions(args: AgentLoopOptionsArgs): AgentLoopOptions {
  return {
    agent: args.agent,
    provider: args.provider,
    tools: builtinTools(),
    permissions: args.permissions,
    usage: args.usage,
    events: args.events,
    maxIterations: args.maxIterations,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    compaction: DEFAULT_COMPACTION,
  };
}

export function defaultSystemPrompt(workspaceRoot: string): string {
  return [
    `You are a coding agent operating in the repository at ${workspaceRoot}.`,
    "Use the provided tools to inspect and modify the repository; you cannot",
    "see or touch anything outside of it.",
    "",
    "Guidelines:",
    "- Refer to files by their path relative to the workspace root.",
    "- Read enough of the surrounding code to understand context before editing.",
    "- Prefer minimal, targeted changes over broad rewrites.",
    "- When useful, run relevant checks (build, lint, tests) via the bash tool",
    "  to verify your changes.",
    "- Finish by giving a short summary of what changed and why.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves the model alias to a concrete `{model, provider}` pair, or
 * returns a friendly, printable error message on failure (unknown alias,
 * or a known model whose provider has no API key configured).
 */
export type ResolvedModel =
  | { readonly model: ModelDefinition; readonly provider: ModelProvider }
  | { readonly error: string };

export async function resolveModelAndProvider(
  env: Readonly<Record<string, string | undefined>>,
  alias: string,
): Promise<ResolvedModel> {
  // Resolving the registry may shell out once to `ant auth
  // print-credentials` to pick up an OAuth profile (see
  // `resolveAnthropicCredential`); the resulting token is short-lived and
  // fetched only this once for the whole run — see the comment on
  // `buildProviders` for why that's an accepted tradeoff.
  const registry = await buildRegistry(env);

  let model: ModelDefinition;
  try {
    // `registry.get()` already lists known aliases in its error message.
    model = registry.get(alias);
  } catch (error) {
    return { error: errorMessage(error) };
  }

  try {
    const provider = registry.providerFor(model);
    return { model, provider };
  } catch {
    const hint = credentialHintForProvider(model.provider);
    return {
      error: `Model "${alias}" requires the "${model.provider}" provider, which is not configured: ${hint}.`,
    };
  }
}

/** Runs the coding-agent loop for one objective. Returns the process exit code. */
export async function runObjective(
  objective: string,
  options: RunObjectiveOptions,
): Promise<number> {
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const alias = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
  ).value;
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    console.error(resolved.error);
    return 1;
  }
  const { model, provider } = resolved;

  const renderer: Renderer = options.json
    ? new JsonRenderer()
    : new TextRenderer();

  const promptState = createPromptState();
  const prompter = createPrompter({
    yes: options.yes,
    interactive: process.stdin.isTTY === true && !options.json,
    state: promptState,
  });

  const permissions = new PermissionEngine(DEFAULT_PERMISSIONS, {
    defaultDecision: "ask",
    ...(prompter === undefined ? {} : { prompter }),
  });

  const usage = new UsageTracker();
  const instructions = loadInstructions(workspacePath, process.env);

  const agent: AgentDefinition = {
    name: "agent",
    role: "worker",
    model,
    systemPrompt:
      options.system ??
      composeSystemPrompt(defaultSystemPrompt(workspacePath), instructions),
    tools: builtinTools().map((tool) => tool.name),
    permissions: DEFAULT_PERMISSIONS,
  };

  const controller = new AbortController();
  const onSigint = (): void => {
    // Ctrl-C while a permission prompt is showing is handled by the prompter
    // itself (answers "no"); otherwise it cancels the whole run.
    if (promptState.active) return;
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    const loop = new AgentLoop(
      agentLoopOptions({
        agent,
        provider,
        permissions,
        usage,
        events: renderer,
        maxIterations: options.maxIterations,
        ...(options.timeoutSeconds === undefined
          ? {}
          : { timeoutMs: options.timeoutSeconds * 1000 }),
      }),
    );

    const result = await loop.run(
      { instruction: objective },
      {
        runId: crypto.randomUUID(),
        workspacePath,
        signal: controller.signal,
      },
    );

    const totals: UsageTotals = usage.totals();
    renderer.result(result, totals);

    if (result.status === "success") return 0;
    if (result.status === "partial") return 2;
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
