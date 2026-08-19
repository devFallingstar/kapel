import type { ModelDefinition, ModelProvider, UsageRecorder } from "@agent/ai";
import type { AgentLoopOptions, CompactionOptions } from "@agent/coding-agent";
import { builtinTools, type PermissionEngine } from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import type { EventSink } from "@agent/protocol";
import { buildRegistry, credentialHintForProvider } from "./models.js";

/**
 * How many tool-call iterations one native turn may take before the loop
 * gives up.
 *
 * A constant rather than a flag: `--max-iterations` existed for one-shot runs,
 * where nobody was watching and a runaway loop had to be bounded from the
 * command line. At a prompt the human *is* the bound — Ctrl-C ends the turn —
 * so the number only has to be high enough that ordinary work never hits it.
 */
export const DEFAULT_MAX_ITERATIONS = 32;

/**
 * The native loop's default deterministic compaction, applied to every turn
 * `nativeSession` (in `interactive.ts`) runs.
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
 * The native loop's `AgentLoopOptions`, built in one place so the tool set and
 * {@link DEFAULT_COMPACTION} arrive the same way wherever a loop is
 * constructed. Factored out (rather than inlined at the call site) so the
 * compaction wiring is directly testable without exercising a whole turn.
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
