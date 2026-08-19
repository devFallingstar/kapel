import type {
  PolicyCompileIssue,
  PolicyCompileResult,
  PolicyCompiler,
} from "@agent/policy";
import {
  buildPolicyCompilerSystemPrompt,
  buildPolicyToolInputSchema,
  EMIT_POLICY_TOOL_NAME,
  PolicyCompileError,
  parsePolicyDraft,
} from "@agent/policy";
import type { EventSink } from "@agent/protocol";
import type {
  DelegatedBackendFactory,
  DelegatedCliName,
  DelegatedRunResult,
  DelegatedUsageSink,
  Rejection,
} from "./delegated-cli.js";
import {
  buildJsonOutputContract,
  buildRetrySection,
  extractJsonObject,
  formatIssues,
  recordDelegatedUsage,
  runDelegatedPrompt,
  stringifyPromptSchema,
} from "./delegated-cli.js";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface DelegatedPolicyCompilerOptions {
  readonly backend: DelegatedCliName;
  /** Directory the CLI runs in; the policy is compiled against that project. */
  readonly workspacePath: string;
  /** Correlates the CLI's events with the run. Generated when omitted. */
  readonly runId?: string;
  /**
   * Model id passed to the CLI (`-m` / `--model`). `undefined` means "let the
   * CLI pick", the same rule `createDelegatedModelResolver` encodes for
   * workers.
   */
  readonly model?: string;
  /** Agent names the policy is allowed to reference. */
  readonly knownAgents: readonly string[];
  /**
   * Total attempts, including the first. Defaults to 3, as
   * `LlmPolicyCompiler`.
   */
  readonly maxAttempts?: number;
  /** Wall-clock budget for each attempt's subprocess, in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional sink for the CLI's normalized events. */
  readonly events?: EventSink;
  /**
   * Where to report what the CLI said each attempt spent, when the caller is
   * keeping a ledger (`kapel orchestrate` opens one for the whole run). Left
   * out, nothing is recorded — which is not the same as recording zero, and
   * the reason this is optional rather than a tracker the class owns.
   */
  readonly usage?: DelegatedUsageSink;
  /**
   * Test-only injection point, mirroring `RunPolicyCompileDeps.compilerFactory`
   * in the CLI; production callers never set this.
   */
  readonly createBackend?: DelegatedBackendFactory;
}

/**
 * The JSON Schema the reply must satisfy, built once from
 * {@link buildPolicyToolInputSchema} — the very schema the `emit_policy` tool
 * advertises on the native path, just carried in prose instead of a tool
 * definition.
 */
const POLICY_JSON_SCHEMA: string = stringifyPromptSchema(
  buildPolicyToolInputSchema(),
);

/**
 * Composes the single prompt one compilation attempt sends.
 *
 * The compiler brief is {@link buildPolicyCompilerSystemPrompt}, byte for
 * byte the one the native compiler uses — that shared text is what keeps the
 * two paths from compiling the same `orchestration.md` differently.
 * Everything appended here exists only because there is no tool call to
 * force; see {@link buildJsonOutputContract}.
 *
 * The reported object is the whole `emit_policy` input, not just the policy:
 * `warnings` and `ambiguities` are the compiler's account of what it had to
 * simplify or could not map, they end up in the lockfile and in
 * `kapel policy explain`, and a delegated compile that quietly dropped them
 * would look identical to one that had nothing to report.
 */
export function buildDelegatedPolicyCompilerPrompt(args: {
  readonly markdown: string;
  readonly knownAgents: readonly string[];
  readonly rejection?: Rejection;
}): string {
  const sections = [
    buildPolicyCompilerSystemPrompt(args.knownAgents),
    buildJsonOutputContract({
      toolName: EMIT_POLICY_TOOL_NAME,
      subject: "compiled policy",
      schema: POLICY_JSON_SCHEMA,
      extraRules: [
        "- The object has three top-level keys: policy, warnings and ambiguities. Always include all three; warnings and ambiguities are empty arrays when there is nothing to report.",
      ],
    }),
    `Compile this orchestration policy:\n\n${args.markdown}`,
  ];

  const { rejection } = args;
  if (rejection !== undefined) {
    sections.push(buildRetrySection(rejection, "policy"));
  }

  return sections.join("\n\n");
}

/**
 * Compiles `.agent/orchestration.md` into the typed policy IR by asking a
 * delegating coding CLI (Codex or Claude Code) for it, then validating the
 * answer and asking again when it does not hold up.
 *
 * Why this exists next to `LlmPolicyCompiler` rather than instead of it:
 * under `--backend codex`/`--backend claude-code` the whole point is that the
 * user has a CLI subscription and no API key, and `LlmPolicyCompiler` cannot
 * run without one. `kapel policy compile` was the last command on those
 * backends that still demanded a credential.
 *
 * What changes across the CLI boundary is only the *forcing*: a provider can
 * be told `toolChoice: {type: "tool"}` and will then always emit a
 * well-shaped object, while a CLI can only be asked nicely, in prose, to
 * reply with JSON. So this is ask-and-verify where the native compiler is
 * force-and-verify. Everything after the reply is identical — the same draft
 * schema through {@link parsePolicyDraft}, the same retry-with-the-issues
 * loop, the same {@link PolicyCompileError} when the attempts run out, and
 * the same {@link PolicyCompileResult} with its warnings and ambiguities
 * intact — and that shared validation is what keeps a delegated lockfile
 * worth as much as a native one.
 *
 * Compiling is read-only by construction; see {@link runDelegatedPrompt}. The
 * lockfile is written by the CLI command afterwards, never by the delegate.
 */
export class DelegatedPolicyCompiler implements PolicyCompiler {
  readonly #options: DelegatedPolicyCompilerOptions;
  readonly #runId: string;

  constructor(options: DelegatedPolicyCompilerOptions) {
    this.#options = options;
    this.#runId = options.runId ?? crypto.randomUUID();
  }

  async compile(
    markdown: string,
    signal?: AbortSignal,
  ): Promise<PolicyCompileResult> {
    const maxAttempts = Math.max(
      1,
      this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );
    const { knownAgents } = this.#options;

    let rejection: Rejection | undefined;
    let lastIssues: readonly PolicyCompileIssue[] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const prompt = buildDelegatedPolicyCompilerPrompt({
        markdown,
        knownAgents,
        ...(rejection === undefined ? {} : { rejection }),
      });
      const run = await this.#run(prompt, signal);
      // Recorded per attempt, not per compile: a rejected reply still cost
      // the tokens it cost.
      recordDelegatedUsage(this.#options.usage, run);
      signal?.throwIfAborted();

      const reply = run.output ?? run.summary;
      if (run.status === "failed") {
        // The CLI itself failed (not installed, model refused, timed out).
        // Its summary is the most informative thing anyone has, so it becomes
        // the issue text and the attempt is spent like any other.
        lastIssues = [{ path: "(root)", message: run.summary }];
        rejection = { reply, issues: lastIssues };
        continue;
      }

      const outcome = this.#interpret(reply);
      if ("result" in outcome) return outcome.result;

      lastIssues = outcome.issues;
      rejection = { reply, issues: outcome.issues };
    }

    throw new PolicyCompileError({
      message: `Failed to compile the orchestration policy after ${maxAttempts} attempt(s).${
        lastIssues === undefined ? "" : `\n${formatIssues(lastIssues)}`
      }`,
      attempts: maxAttempts,
      ...(lastIssues === undefined ? {} : { lastIssues }),
    });
  }

  /** Parses one reply into a compile result, or into the issues that rejected it. */
  #interpret(
    reply: string,
  ):
    | { readonly result: PolicyCompileResult }
    | { readonly issues: readonly PolicyCompileIssue[] } {
    const json = extractJsonObject(reply);
    if (json === undefined) {
      return {
        issues: [
          {
            path: "(root)",
            message:
              "the reply contained no JSON object; reply with the policy object itself and nothing else",
          },
        ],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      return {
        issues: [
          {
            path: "(root)",
            message: `the reply is not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }

    return parsePolicyDraft(parsed);
  }

  /** Runs one attempt through the delegating CLI. */
  async #run(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<DelegatedRunResult> {
    const { events, timeoutMs, model, workspacePath, createBackend } =
      this.#options;
    return await runDelegatedPrompt(
      {
        backend: this.#options.backend,
        workspacePath,
        runId: this.#runId,
        ...(model === undefined ? {} : { model }),
        ...(events === undefined ? {} : { events }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(createBackend === undefined ? {} : { createBackend }),
      },
      prompt,
      signal,
    );
  }
}
