import type { AgentRunResult } from "@agent/core";
import type {
  ExecutionPlan,
  PlanIssue,
  PlannedTask,
} from "@agent/orchestration";
import {
  buildPlannerSystemPrompt,
  EMIT_PLAN_TOOL_NAME,
  ExecutionPlanSchema,
  PlanError,
  validatePlanDraft,
} from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import type { EventSink } from "@agent/protocol";
import { z } from "zod";
import type {
  DelegatedBackendFactory,
  DelegatedCliName,
  Rejection,
} from "./delegated-cli.js";
import {
  buildJsonOutputContract,
  buildRetrySection,
  extractJsonObject,
  formatIssues,
  issuesFromZodError,
  runDelegatedPrompt,
  stringifyPromptSchema,
} from "./delegated-cli.js";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface DelegatedPlannerOptions {
  readonly backend: DelegatedCliName;
  /** Directory the CLI runs in; it reads the repository to plan against it. */
  readonly workspacePath: string;
  /** Correlates the CLI's events with the run. Generated when omitted. */
  readonly runId?: string;
  /**
   * Model id passed to the CLI (`-m` / `--model`). `undefined` means "let the
   * CLI pick", the same rule `createDelegatedModelResolver` encodes for
   * workers.
   */
  readonly model?: string;
  /** Agent names `suggestedAgent` is allowed to reference. */
  readonly knownAgents: readonly string[];
  /** Total attempts, including the first. Defaults to 3, as `LlmPlanner`. */
  readonly maxAttempts?: number;
  /** Wall-clock budget for each attempt's subprocess, in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional sink for the CLI's normalized events. */
  readonly events?: EventSink;
  /**
   * Test-only injection point, mirroring `PreparePlanDeps.plannerFactory` in
   * the CLI; production callers never set this.
   */
  readonly createBackend?: DelegatedBackendFactory;
}

/**
 * The JSON Schema the reply must satisfy, built once: zod's `io: "input"`
 * view minus the `$schema` key, mirroring `buildToolInputSchema` in the
 * native planner. Same schema the `emit_plan` tool advertises, just carried
 * in prose instead of a tool definition.
 */
const PLAN_JSON_SCHEMA: string = (() => {
  const generated = z.toJSONSchema(ExecutionPlanSchema, {
    io: "input",
  }) as Record<string, unknown>;
  return stringifyPromptSchema({
    ...generated,
    required: ["objective", "tasks"],
  });
})();

type PlanDraft = z.infer<typeof ExecutionPlanSchema>;

function toPlannedTask(draft: PlanDraft["tasks"][number]): PlannedTask {
  return {
    id: draft.id,
    title: draft.title,
    goal: draft.goal,
    type: draft.type,
    complexity: draft.complexity,
    dependencies: draft.dependencies,
    ...(draft.suggestedAgent === undefined
      ? {}
      : { suggestedAgent: draft.suggestedAgent }),
    affectedAreas: draft.affectedAreas,
    risk: { level: draft.risk.level, categories: draft.risk.categories },
  };
}

/**
 * Composes the single prompt one planning attempt sends.
 *
 * The planning brief is {@link buildPlannerSystemPrompt}, byte for byte the
 * one the native planner uses — that shared text is what keeps the two paths
 * from drifting into different plans. Everything appended here exists only
 * because there is no tool call to force; see
 * {@link buildJsonOutputContract}.
 */
export function buildDelegatedPlannerPrompt(args: {
  readonly objective: string;
  readonly policy: OrchestrationPolicy;
  readonly knownAgents: readonly string[];
  readonly rejection?: Rejection;
}): string {
  const sections = [
    buildPlannerSystemPrompt(args.policy, args.knownAgents),
    buildJsonOutputContract({
      toolName: EMIT_PLAN_TOOL_NAME,
      subject: "plan",
      schema: PLAN_JSON_SCHEMA,
    }),
    `Objective to plan:\n\n${args.objective}`,
  ];

  const { rejection } = args;
  if (rejection !== undefined) {
    sections.push(buildRetrySection(rejection, "plan"));
  }

  return sections.join("\n\n");
}

/**
 * Turns an objective into an {@link ExecutionPlan} by asking a delegating
 * coding CLI (Codex or Claude Code) for it, then validating the answer and
 * asking again when it does not hold up.
 *
 * Why this exists next to `LlmPlanner` rather than instead of it: under
 * `--backend codex`/`--backend claude-code` the whole point is that the user
 * has a CLI subscription and no API key, and `LlmPlanner` cannot run without
 * one. Planning was the last step on those backends that still demanded a
 * credential.
 *
 * What changes across the CLI boundary is only the *forcing*: a provider can
 * be told `toolChoice: {type: "tool"}` and will then always emit a
 * well-shaped object, while a CLI can only be asked nicely, in prose, to
 * reply with JSON. So this is ask-and-verify where the native planner is
 * force-and-verify. Everything after the reply is identical — the same
 * schema, the same {@link validatePlanDraft} checks, the same retry-with-the-
 * issues loop, the same {@link PlanError} when the attempts run out — and
 * that shared validation is what keeps plan quality comparable rather than
 * "whatever the CLI happened to say".
 *
 * Planning is read-only by construction; see {@link runDelegatedPrompt}.
 */
export class DelegatedPlanner {
  readonly #options: DelegatedPlannerOptions;
  readonly #runId: string;

  constructor(options: DelegatedPlannerOptions) {
    this.#options = options;
    this.#runId = options.runId ?? crypto.randomUUID();
  }

  async plan(
    objective: string,
    policy: OrchestrationPolicy,
    signal?: AbortSignal,
  ): Promise<ExecutionPlan> {
    const maxAttempts = Math.max(
      1,
      this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );
    const { knownAgents } = this.#options;

    let rejection: Rejection | undefined;
    let lastIssues: readonly PlanIssue[] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const prompt = buildDelegatedPlannerPrompt({
        objective,
        policy,
        knownAgents,
        ...(rejection === undefined ? {} : { rejection }),
      });
      const run = await this.#run(prompt, signal);
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
      if ("plan" in outcome) return outcome.plan;

      lastIssues = outcome.issues;
      rejection = { reply, issues: outcome.issues };
    }

    throw new PlanError({
      message: `Failed to plan the objective after ${maxAttempts} attempt(s).${
        lastIssues === undefined ? "" : `\n${formatIssues(lastIssues)}`
      }`,
      attempts: maxAttempts,
      ...(lastIssues === undefined ? {} : { lastIssues }),
    });
  }

  /** Parses one reply into a plan, or into the issues that rejected it. */
  #interpret(
    reply: string,
  ):
    | { readonly plan: ExecutionPlan }
    | { readonly issues: readonly PlanIssue[] } {
    const json = extractJsonObject(reply);
    if (json === undefined) {
      return {
        issues: [
          {
            path: "(root)",
            message:
              "the reply contained no JSON object; reply with the plan object itself and nothing else",
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

    const validated = ExecutionPlanSchema.safeParse(parsed);
    if (!validated.success) {
      return { issues: issuesFromZodError(validated.error) };
    }

    const plan: ExecutionPlan = {
      objective: validated.data.objective,
      tasks: validated.data.tasks.map(toPlannedTask),
    };
    const issues = validatePlanDraft(plan, this.#options.knownAgents);
    return issues.length === 0 ? { plan } : { issues };
  }

  /** Runs one attempt through the delegating CLI. */
  async #run(prompt: string, signal?: AbortSignal): Promise<AgentRunResult> {
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
