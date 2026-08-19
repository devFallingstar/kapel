import type { AgentRunInput, AgentRunResult } from "@agent/core";
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
import type { ClaudeCodeBackendOptions } from "../backends/claude-code.js";
import { ClaudeCodeBackend } from "../backends/claude-code.js";
import type { CodexBackendOptions } from "../backends/codex.js";
import { CodexBackend } from "../backends/codex.js";

const DEFAULT_MAX_ATTEMPTS = 3;

/** The delegating CLIs a plan can be asked of. */
export type DelegatedPlannerBackendName = "codex" | "claude-code";

/**
 * The slice of {@link CodexBackend}/{@link ClaudeCodeBackend} the planner
 * uses: one prompt in, one result out. Narrow on purpose, so
 * {@link DelegatedPlannerOptions.createBackend} can substitute a stand-in
 * without reimplementing a whole CLI wrapper.
 */
export interface DelegatedPlannerBackend {
  run(
    input: AgentRunInput,
    context: {
      readonly runId: string;
      readonly workspacePath: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<AgentRunResult>;
}

/**
 * The fully composed backend options for one planning attempt, handed to
 * {@link DelegatedPlannerOptions.createBackend}.
 *
 * The planner decides the options (read-only sandboxing, model, events,
 * timeout) and the factory only decides which object gets constructed from
 * them — which is what lets a test point the CLI at a fake binary while still
 * exercising the flags this planner chose.
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
) => DelegatedPlannerBackend;

const defaultBackendFactory: DelegatedBackendFactory = (spec) =>
  spec.backend === "codex"
    ? new CodexBackend(spec.options)
    : new ClaudeCodeBackend(spec.options);

export interface DelegatedPlannerOptions {
  readonly backend: DelegatedPlannerBackendName;
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
 * The JSON Schema the reply must satisfy, built once: zod's `io: "input"` view minus the
 * `$schema` key, mirroring `buildToolInputSchema` in the native planner. Same
 * schema the `emit_plan` tool advertises, just carried in prose instead of a
 * tool definition.
 */
const PLAN_JSON_SCHEMA: string = (() => {
  const generated = z.toJSONSchema(ExecutionPlanSchema, {
    io: "input",
  }) as Record<string, unknown>;
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema") schema[key] = value;
  }
  schema.required = ["objective", "tasks"];
  return JSON.stringify(schema, null, 2);
})();

function formatIssues(issues: readonly PlanIssue[]): string {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}

function toIssues(error: z.ZodError): readonly PlanIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

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

/** Feedback carried into the next attempt after a rejected reply. */
interface Rejection {
  readonly reply: string;
  readonly issues: readonly PlanIssue[];
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
 * Composes the single prompt one planning attempt sends.
 *
 * The planning brief is {@link buildPlannerSystemPrompt}, byte for byte the
 * one the native planner uses — that shared text is what keeps the two paths
 * from drifting into different plans. Everything appended here exists only
 * because there is no tool call to force: the brief's "call `emit_plan`" rule
 * has to be restated as "reply with this JSON object", and the schema the
 * tool definition would have carried has to be spelled out in the prompt.
 */
export function buildDelegatedPlannerPrompt(args: {
  readonly objective: string;
  readonly policy: OrchestrationPolicy;
  readonly knownAgents: readonly string[];
  readonly rejection?: Rejection;
}): string {
  const sections = [
    buildPlannerSystemPrompt(args.policy, args.knownAgents),
    `Output contract:
- There is no ${EMIT_PLAN_TOOL_NAME} tool here: you are answering through a CLI, so "emit the plan" means replying with the plan as JSON.
- Reply with ONLY a single JSON object matching the schema below. No prose, no explanation, no markdown fences, nothing before or after the object.
- Do not edit, create or delete any file. Read whatever you need to understand the repository, then answer.

JSON Schema for the object:
${PLAN_JSON_SCHEMA}`,
    `Objective to plan:\n\n${args.objective}`,
  ];

  const { rejection } = args;
  if (rejection !== undefined) {
    sections.push(
      `Your previous reply was not a usable plan.

Previous reply:
${rejection.reply}

Problems with it:
${formatIssues(rejection.issues)}

Reply again with a corrected plan that fixes every problem above, as a single JSON object and nothing else.`,
    );
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
 * Planning is read-only by construction: Codex runs under `--sandbox
 * read-only` and Claude Code under `--permission-mode plan`. A planner that
 * edits files is a bug — `kapel plan` and `orchestrate --dry-run` promise to
 * touch nothing, and even under a real `orchestrate` the edits belong to the
 * routed workers, in their own task worktrees, not to the step that is still
 * deciding what the tasks are.
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
    if (!validated.success) return { issues: toIssues(validated.error) };

    const plan: ExecutionPlan = {
      objective: validated.data.objective,
      tasks: validated.data.tasks.map(toPlannedTask),
    };
    const issues = validatePlanDraft(plan, this.#options.knownAgents);
    return issues.length === 0 ? { plan } : { issues };
  }

  /** Runs one attempt through the delegating CLI. */
  async #run(prompt: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const { events, timeoutMs, model, workspacePath } = this.#options;
    const shared = {
      ...(model === undefined ? {} : { model }),
      ...(events === undefined ? {} : { events }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    const spec: DelegatedBackendSpec =
      this.#options.backend === "codex"
        ? { backend: "codex", options: { ...shared, sandbox: "read-only" } }
        : {
            backend: "claude-code",
            options: { ...shared, permissionMode: "plan" },
          };

    const backend = (this.#options.createBackend ?? defaultBackendFactory)(
      spec,
    );
    try {
      return await backend.run(
        { instruction: prompt },
        {
          runId: this.#runId,
          workspacePath,
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error) {
      // A crash in the wrapper is one failed attempt, not a failed command:
      // the retry loop above is the only place that decides to give up.
      return {
        status: "failed",
        summary: `The ${this.#options.backend} CLI could not be run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}
