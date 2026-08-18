import path from "node:path";
import type { ModelDefinition, ModelProvider, UsageTotals } from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import { AgentLoop, builtinTools, PermissionEngine } from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import { loadDotEnvFile } from "./env.js";
import {
  buildRegistry,
  envVarForProvider,
  resolveModelAlias,
} from "./models.js";
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
type ResolvedModel =
  | { readonly model: ModelDefinition; readonly provider: ModelProvider }
  | { readonly error: string };

function resolveModelAndProvider(
  env: Readonly<Record<string, string | undefined>>,
  alias: string,
): ResolvedModel {
  const registry = buildRegistry(env);

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
    const envVar = envVarForProvider(model.provider);
    const hint =
      envVar === undefined
        ? `no provider is configured for "${model.provider}"`
        : `set ${envVar} in your shell environment or in a .env file in the workspace`;
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

  const alias = resolveModelAlias(process.env, options.model);
  const resolved = resolveModelAndProvider(process.env, alias);
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

  const agent: AgentDefinition = {
    name: "agent",
    role: "worker",
    model,
    systemPrompt: options.system ?? defaultSystemPrompt(workspacePath),
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
    const loop = new AgentLoop({
      agent,
      provider,
      tools: builtinTools(),
      permissions,
      usage,
      events: renderer,
      maxIterations: options.maxIterations,
      ...(options.timeoutSeconds === undefined
        ? {}
        : { timeoutMs: options.timeoutSeconds * 1000 }),
    });

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
