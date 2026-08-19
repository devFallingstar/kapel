import path from "node:path";
import type {
  ModelDefinition,
  ModelProvider,
  UsageRecorder,
  UsageTotals,
} from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import type { AgentLoopOptions, CompactionOptions } from "@agent/coding-agent";
import {
  AgentLoop,
  builtinTools,
  PermissionEngine,
  SessionAllowlist,
} from "@agent/coding-agent";
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

/**
 * Piped stdin merged into an objective (P1-6) is capped at 1 MiB, measured in
 * UTF-8 bytes since that's what actually crosses to the model — the same
 * reasoning `instructions.ts` applies to `AGENTS.md` files, just a larger
 * budget because a log or diff piped in is often the whole point of the run.
 */
export const MAX_PIPED_STDIN_BYTES = 1024 * 1024;

const PIPED_STDIN_TRUNCATION_MARKER = "\n[stdin truncated]";

/**
 * Delimiter placed between the objective and piped stdin appended as
 * context, e.g. `kapel "explain this failure" < error.log`. Chosen to read
 * as a section break in a plain-text prompt, matching the header-style
 * separators `instructions.ts` uses for `AGENTS.md` content.
 */
export const PIPED_STDIN_DELIMITER = "\n\n--- piped input ---\n";

/**
 * Reads `input` to end and returns it as UTF-8 text, capped at `maxBytes`.
 * The stream is always drained fully — even past the cap — so a piped
 * producer (e.g. `cat big.log | kapel ...`) never blocks on a full pipe
 * buffer waiting for a reader that stopped early.
 *
 * Bytes beyond the cap are dropped and replaced with a trailing
 * `[stdin truncated]` marker line, mirroring how `instructions.ts` caps
 * `AGENTS.md` content.
 */
export async function readPipedStdin(
  input: NodeJS.ReadableStream,
  maxBytes: number = MAX_PIPED_STDIN_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of input) {
    const buf: Buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    if (total >= maxBytes) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - total;
    if (buf.length > remaining) {
      chunks.push(buf.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      continue;
    }
    chunks.push(buf);
    total += buf.length;
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${text}${PIPED_STDIN_TRUNCATION_MARKER}` : text;
}

/**
 * Appends piped stdin to an objective as delimited context. Empty stdin (a
 * pipe that produced 0 bytes, e.g. `cat /dev/null | kapel "..."`) leaves the
 * objective unchanged rather than appending an empty section.
 */
export function composeObjectiveWithStdin(
  objective: string,
  pipedStdin: string,
): string {
  if (pipedStdin === "") return objective;
  return `${objective}${PIPED_STDIN_DELIMITER}${pipedStdin}`;
}

/**
 * The objective for a one-shot run (`kapel "<objective>"`, `kapel exec
 * "<objective>"`): the argument as given, plus — when `input` is piped
 * rather than a terminal — whatever was piped in, merged via
 * {@link composeObjectiveWithStdin} (P1-6, `cat log.txt | kapel "explain
 * this"`).
 *
 * On a TTY, `input` is left completely alone: it's the user's terminal, not
 * data, and reading it would hang waiting for input nobody is going to send.
 * Off a TTY with nothing actually piped (0 bytes — e.g. stdio redirected
 * from `/dev/null`), {@link composeObjectiveWithStdin} returns the objective
 * unchanged, so a script that redirects stdin without piping data sees no
 * behavior change.
 */
export async function objectiveWithPipedStdin(
  objective: string,
  input: NodeJS.ReadableStream & { readonly isTTY?: boolean },
): Promise<string> {
  if (input.isTTY === true) return objective;
  const piped = await readPipedStdin(input);
  return composeObjectiveWithStdin(objective, piped);
}

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

  const promptState = createPromptState();
  // Approvals answered with "a" live here for the rest of the process, and
  // are consulted by the engine before it prompts again.
  const sessionAllowlist = new SessionAllowlist();
  const usage = new UsageTracker();

  const renderer: Renderer = options.json
    ? new JsonRenderer()
    : new TextRenderer(process.stdout, {
        tokens: () => {
          const totals = usage.totals().usage;
          return totals.inputTokens + totals.outputTokens;
        },
        // A permission question owns the screen while it waits for an answer.
        suspended: () => promptState.active,
      });

  const prompter = createPrompter({
    yes: options.yes,
    interactive: process.stdin.isTTY === true && !options.json,
    state: promptState,
    allowlist: sessionAllowlist,
  });

  const permissions = new PermissionEngine(DEFAULT_PERMISSIONS, {
    defaultDecision: "ask",
    overlay: sessionAllowlist,
    ...(prompter === undefined ? {} : { prompter }),
  });
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
