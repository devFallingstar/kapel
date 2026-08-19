import type {
  ModelDefinition,
  ModelUsage,
  UsageRecorder,
  UsageTags,
} from "@agent/ai";
import type { AgentRunInput, AgentRunResult } from "@agent/core";
import type { EventSink } from "@agent/protocol";
import type { z } from "zod";
import type { ClaudeCodeBackendOptions } from "../backends/claude-code.js";
import { ClaudeCodeBackend } from "../backends/claude-code.js";
import type { CodexBackendOptions } from "../backends/codex.js";
import { CodexBackend } from "../backends/codex.js";

/**
 * The plumbing shared by every "ask a delegating CLI for a JSON object"
 * step — planning (`DelegatedPlanner`) and policy compilation
 * (`DelegatedPolicyCompiler`) so far.
 *
 * Both ask the same kind of question: run one read-only CLI conversation,
 * hope for a JSON object, validate it, and ask again with the issues when it
 * does not hold up. Only the schema, the brief and the error type differ, so
 * everything *around* those lives here — one read-only run, one JSON
 * extractor, one output contract, one retry section — and the two callers
 * stay short enough to read end to end.
 */

/** The delegating CLIs a plan or a policy can be asked of. */
export type DelegatedCliName = "codex" | "claude-code";

/**
 * One CLI attempt's result: an {@link AgentRunResult} that may also say what
 * the CLI reported spending.
 *
 * `usage` is optional because the CLIs are not obliged to report it — both
 * wrappers fill `CodexRunResult.usage`/`ClaudeCodeRunResult.usage` only when
 * the stream carried token counts. Nothing here invents numbers: an attempt
 * that reported none simply records none, which is why every consumer has to
 * distinguish "no usage" from "zero tokens".
 */
export interface DelegatedRunResult extends AgentRunResult {
  readonly usage?: ModelUsage;
}

/**
 * Where a delegated step reports what its CLI said it spent.
 *
 * The delegating path has no `ModelProvider` to tee through, so
 * `usageRecordingProvider` — the trick the native planner and policy compiler
 * use — has nothing to wrap. This is the equivalent seam: the caller supplies
 * the recorder, the stand-in {@link ModelDefinition} for "whatever the CLI
 * ran" (see `delegatedModelIdentity` in the CLI), and the attribution tags,
 * and each attempt hands back whatever the subprocess reported.
 */
export interface DelegatedUsageSink {
  readonly recorder: UsageRecorder;
  readonly model: ModelDefinition;
  readonly tags?: UsageTags;
}

/** Records one attempt's reported usage, if there is a sink and there is usage. */
export function recordDelegatedUsage(
  sink: DelegatedUsageSink | undefined,
  result: DelegatedRunResult,
): void {
  if (sink === undefined || result.usage === undefined) return;
  sink.recorder.record(sink.model, result.usage, sink.tags);
}

/**
 * The slice of {@link CodexBackend}/{@link ClaudeCodeBackend} these steps
 * use: one prompt in, one result out. Narrow on purpose, so
 * {@link DelegatedBackendFactory} can substitute a stand-in without
 * reimplementing a whole CLI wrapper.
 */
export interface DelegatedCliBackend {
  run(
    input: AgentRunInput,
    context: {
      readonly runId: string;
      readonly workspacePath: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<DelegatedRunResult>;
}

/**
 * The fully composed backend options for one attempt, handed to
 * {@link DelegatedBackendFactory}.
 *
 * The caller decides the options (read-only sandboxing, model, events,
 * timeout) and the factory only decides which object gets constructed from
 * them — which is what lets a test point the CLI at a fake binary while still
 * exercising the flags the caller chose.
 */
export type DelegatedBackendSpec =
  | {
      readonly backend: "codex";
      readonly options: CodexBackendOptions;
    }
  | {
      readonly backend: "claude-code";
      readonly options: ClaudeCodeBackendOptions;
    };

export type DelegatedBackendFactory = (
  spec: DelegatedBackendSpec,
) => DelegatedCliBackend;

const defaultBackendFactory: DelegatedBackendFactory = (spec) =>
  spec.backend === "codex"
    ? new CodexBackend(spec.options)
    : new ClaudeCodeBackend(spec.options);

/** Everything one read-only CLI attempt needs to know about its subprocess. */
export interface DelegatedRunOptions {
  readonly backend: DelegatedCliName;
  /** Directory the CLI runs in; it reads the repository to answer. */
  readonly workspacePath: string;
  /** Correlates the CLI's events with the run. */
  readonly runId: string;
  /**
   * Model id passed to the CLI (`-m` / `--model`). `undefined` means "let the
   * CLI pick", the same rule `createDelegatedModelResolver` encodes for
   * workers.
   */
  readonly model?: string;
  /** Wall-clock budget for the attempt's subprocess, in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional sink for the CLI's normalized events. */
  readonly events?: EventSink;
  /** Test-only injection point; production callers never set this. */
  readonly createBackend?: DelegatedBackendFactory;
}

/**
 * Runs one prompt through the delegating CLI, read-only, and never throws.
 *
 * Read-only is by construction: Codex runs under `--sandbox read-only` and
 * Claude Code under `--permission-mode plan`. A step that only decides *what*
 * should happen has no business editing files — `kapel plan`,
 * `orchestrate --dry-run` and `kapel policy compile` all promise to touch
 * nothing but the artifact they write themselves, and under a real
 * `orchestrate` the edits belong to the routed workers in their own task
 * worktrees.
 *
 * A crash in the wrapper comes back as a failed {@link AgentRunResult} rather
 * than an exception, because the caller's retry loop is the only place
 * allowed to decide the whole command has failed.
 */
export async function runDelegatedPrompt(
  options: DelegatedRunOptions,
  prompt: string,
  signal?: AbortSignal,
): Promise<DelegatedRunResult> {
  const { events, timeoutMs, model, workspacePath, runId } = options;
  const shared = {
    ...(model === undefined ? {} : { model }),
    ...(events === undefined ? {} : { events }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const spec: DelegatedBackendSpec =
    options.backend === "codex"
      ? { backend: "codex", options: { ...shared, sandbox: "read-only" } }
      : {
          backend: "claude-code",
          options: { ...shared, permissionMode: "plan" },
        };

  const backend = (options.createBackend ?? defaultBackendFactory)(spec);
  try {
    return await backend.run(
      { instruction: prompt },
      {
        runId,
        workspacePath,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    return {
      status: "failed",
      summary: `The ${options.backend} CLI could not be run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * One rejected field, in the shape both `PlanIssue` and `PolicyCompileIssue`
 * already have — the helpers below work on either without converting.
 */
export interface DelegatedIssue {
  readonly path: string;
  readonly message: string;
}

export function formatIssues(issues: readonly DelegatedIssue[]): string {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}

export function issuesFromZodError(
  error: z.ZodError,
): readonly DelegatedIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

/** Feedback carried into the next attempt after a rejected reply. */
export interface Rejection {
  readonly reply: string;
  readonly issues: readonly DelegatedIssue[];
}

/**
 * Recovers the JSON object from a CLI's reply.
 *
 * A CLI answers with whatever its model felt like saying, so the reply is
 * treated as prose that happens to contain JSON rather than as JSON:
 *
 * 1. a fenced block (```json … ```) wins, since a model that fences means the
 *    fence to delimit the answer;
 * 2. otherwise the span from the first `{` to the last `}` — which strips
 *    "Here is the plan:" preambles and trailing commentary alike.
 *
 * Returns `undefined` when there is no brace pair at all; the caller turns
 * that into a validation issue like any other, so a chatty reply costs an
 * attempt instead of crashing the command.
 */
export function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;

  const fenced = /```(?:[a-zA-Z]+)?[ \t]*\r?\n([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  return body.slice(start, end + 1);
}

/**
 * The prompt section that replaces the tool call.
 *
 * A provider can be told `toolChoice: {type: "tool"}` and will then always
 * emit a well-shaped object; a CLI can only be asked nicely, in prose, to
 * reply with JSON. So the native brief's "call `<tool>`" rule is restated
 * here as "reply with this JSON object", and the schema the tool definition
 * would have carried is spelled out in the prompt instead.
 */
export function buildJsonOutputContract(args: {
  /** The tool the native path forces, named so the brief's rule makes sense. */
  readonly toolName: string;
  /** What the object is, in the brief's own words ("plan", "compiled policy"). */
  readonly subject: string;
  /** The JSON Schema the reply must satisfy, already stringified. */
  readonly schema: string;
  /** Extra bullets appended to the contract, before the schema. */
  readonly extraRules?: readonly string[];
}): string {
  const rules = [
    `- There is no ${args.toolName} tool here: you are answering through a CLI, so "emit the ${args.subject}" means replying with the ${args.subject} as JSON.`,
    "- Reply with ONLY a single JSON object matching the schema below. No prose, no explanation, no markdown fences, nothing before or after the object.",
    "- Do not edit, create or delete any file. Read whatever you need to understand the repository, then answer.",
    ...(args.extraRules ?? []),
  ];
  return `Output contract:
${rules.join("\n")}

JSON Schema for the object:
${args.schema}`;
}

/** The prompt section that hands a rejected reply back with its problems. */
export function buildRetrySection(
  rejection: Rejection,
  subject: string,
): string {
  return `Your previous reply was not a usable ${subject}.

Previous reply:
${rejection.reply}

Problems with it:
${formatIssues(rejection.issues)}

Reply again with a corrected ${subject} that fixes every problem above, as a single JSON object and nothing else.`;
}

/**
 * Strips the `$schema` key from a generated JSON Schema and stringifies it
 * for embedding in a prompt. Providers reject the key as an unknown top-level
 * keyword, and a schema meant for a prompt should read the same either way.
 */
export function stringifyPromptSchema(
  generated: Record<string, unknown>,
): string {
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema") schema[key] = value;
  }
  return JSON.stringify(schema, null, 2);
}
