import type {
  ModelDefinition,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ToolDefinition,
} from "@agent/ai";
import type { OrchestrationPolicy } from "@agent/policy";
import { z } from "zod";
import { TaskGraph } from "./graph.js";
import type { ExecutionPlan, PlannedTask } from "./types.js";

/** Name of the single tool the planner forces the model to call. */
export const EMIT_PLAN_TOOL_NAME = "emit_plan";

const DEFAULT_MAX_ATTEMPTS = 3;
const MIN_TASKS = 1;
const MAX_TASKS = 12;

const TASK_ID_PATTERN = /^T\d{2,3}$/;

const TaskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, 'Task ids look like "T01" (T + two digits).');

const TaskTypeSchema = z.enum([
  "exploration",
  "architecture",
  "implementation",
  "testing",
  "review",
  "documentation",
]);

const TaskComplexitySchema = z.enum([
  "trivial",
  "normal",
  "complex",
  "architectural",
]);

const RiskLevelSchema = z.enum(["low", "medium", "high"]);

/**
 * The model-facing mirror of {@link PlannedTask}.
 *
 * Fields that the runtime can default (`dependencies`, `affectedAreas`, risk
 * `categories`) carry `.default([])` so the JSON Schema marks them optional in
 * the *input* view while the parsed value is always concrete.
 */
export const PlannedTaskSchema = z.object({
  id: TaskIdSchema.describe(
    'Stable id for this task, "T01", "T02", ... in plan order.',
  ),
  title: z.string().min(1).describe("Short imperative name for the task."),
  goal: z
    .string()
    .min(1)
    .describe(
      "What done looks like for this task, concrete enough for another agent to execute it without further context.",
    ),
  type: TaskTypeSchema.describe("The kind of work this task is."),
  complexity: TaskComplexitySchema.describe(
    "How much judgement the task needs: trivial < normal < complex < architectural.",
  ),
  dependencies: z
    .array(TaskIdSchema)
    .default([])
    .describe(
      "Ids of tasks that must finish first. Declare a dependency only when the work genuinely cannot start otherwise.",
    ),
  suggestedAgent: z
    .string()
    .optional()
    .describe(
      "Optional preferred agent, which must be one of the known agents. Omit it when no agent is clearly better.",
    ),
  affectedAreas: z
    .array(z.string())
    .default([])
    .describe(
      "Files or directories this task is expected to touch, used to detect conflicts between parallel tasks.",
    ),
  risk: z
    .object({
      level: RiskLevelSchema.describe("Blast radius if this task goes wrong."),
      categories: z
        .array(z.string())
        .default([])
        .describe(
          "Risk areas this task touches, drawn from the policy's vocabulary where they apply.",
        ),
    })
    .describe("Risk assessment used for routing and review decisions."),
});

export const ExecutionPlanSchema = z.object({
  objective: z
    .string()
    .min(1)
    .describe("Restatement of the objective this plan delivers."),
  tasks: z
    .array(PlannedTaskSchema)
    .min(MIN_TASKS)
    .max(MAX_TASKS)
    .describe("The tasks, in a sensible execution order."),
});

/**
 * JSON Schema for the tool input: zod's `io: "input"` view minus the `$schema`
 * key, which providers reject as an unknown top-level keyword.
 */
function buildToolInputSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ExecutionPlanSchema, {
    io: "input",
  }) as Record<string, unknown>;
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema") schema[key] = value;
  }
  schema.required = ["objective", "tasks"];
  return schema;
}

/** The tool definition handed to the provider (stable across plans). */
export const emitPlanTool: ToolDefinition = {
  name: EMIT_PLAN_TOOL_NAME,
  description:
    "Emit the execution plan: the decomposition of the objective into individually executable tasks.",
  inputSchema: buildToolInputSchema(),
};

function riskVocabulary(policy: OrchestrationPolicy): readonly string[] {
  const categories = new Set<string>();
  for (const rule of policy.routing)
    for (const category of rule.riskCategories) categories.add(category);
  for (const rule of policy.review)
    for (const category of rule.riskCategories) categories.add(category);
  return [...categories].sort();
}

function systemPrompt(
  policy: OrchestrationPolicy,
  knownAgents: readonly string[],
): string {
  const agents =
    knownAgents.length === 0 ? "(none declared)" : knownAgents.join(", ");
  const categories = riskVocabulary(policy);
  const riskLine =
    categories.length === 0
      ? "The policy names no risk categories; use short lowercase nouns for the areas this work touches."
      : `The policy routes and reviews on these risk categories: ${categories.join(
          ", ",
        )}. Use exactly these strings when a task touches one of those areas, and only add another category when none of them fits.`;
  const parallelLine = policy.parallelizeIndependentTasks
    ? `Independent tasks run concurrently (up to ${policy.maxConcurrency} at a time), so prefer a wide, shallow shape: split work that can proceed in parallel into separate tasks instead of chaining it.`
    : "Tasks run one at a time, so a mostly linear plan is fine; still declare only the dependencies that are real.";

  return `You are the planner for a multi-agent coding runtime. The user gives you an objective. Decompose it into narrow tasks that other agents can execute independently.

Rules:
- Call the ${EMIT_PLAN_TOOL_NAME} tool exactly once. Never answer with prose.
- Emit between ${MIN_TASKS} and ${MAX_TASKS} tasks. Keep the plan small: one coherent unit of work per task, no bookkeeping tasks, no "task 0: understand the problem" filler.
- Every task must be executable on its own by an agent that sees only its goal, so write goals that carry their own context.
- Ids are "T01", "T02", ... in plan order. Dependencies reference those ids only, must already exist, and must not form a cycle.
- Declare a dependency only when the later task genuinely cannot start until the earlier one finishes. Do not use dependencies to express preferred ordering.
- ${parallelLine}
- affectedAreas lists the files and directories a task will touch (for example "packages/api/src", "docs/README.md"). It is how the runtime detects two tasks colliding, so fill it in for every task.
- ${riskLine}
- Known agent names are: ${agents}. suggestedAgent must be one of them or omitted entirely — never invent an agent, and prefer omitting it over guessing.
- Task types: exploration, architecture, implementation, testing, review, documentation. Complexity: trivial, normal, complex, architectural.
- The runtime injects policy-mandated reviews itself; only add a review task when the objective explicitly asks for one.`;
}

export interface PlanIssue {
  readonly path: string;
  readonly message: string;
}

export interface PlanErrorInit {
  readonly message: string;
  readonly attempts: number;
  readonly lastIssues?: readonly PlanIssue[];
}

/** Thrown when the model never produced a usable plan within `maxAttempts`. */
export class PlanError extends Error {
  readonly attempts: number;
  readonly lastIssues: readonly PlanIssue[] | undefined;

  constructor(init: PlanErrorInit) {
    super(init.message);
    this.name = "PlanError";
    this.attempts = init.attempts;
    this.lastIssues = init.lastIssues;
  }
}

export interface LlmPlannerOptions {
  readonly provider: ModelProvider;
  readonly model: ModelDefinition;
  /** Agent names `suggestedAgent` is allowed to reference. */
  readonly knownAgents: readonly string[];
  /** Total attempts, including the first. Defaults to 3. */
  readonly maxAttempts?: number;
  readonly maxOutputTokens?: number;
}

type PlanDraft = z.infer<typeof ExecutionPlanSchema>;

function toIssues(error: z.ZodError): readonly PlanIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

function formatIssues(issues: readonly PlanIssue[]): string {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}

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

function toPlan(draft: PlanDraft): ExecutionPlan {
  return { objective: draft.objective, tasks: draft.tasks.map(toPlannedTask) };
}

/**
 * Checks the things the schema cannot: id uniqueness, dependency references,
 * acyclicity (delegated to {@link TaskGraph}, the same construction the
 * scheduler will do) and agent names.
 */
export function validatePlanDraft(
  plan: ExecutionPlan,
  knownAgents: readonly string[],
): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  const known = new Set(knownAgents);

  plan.tasks.forEach((task, index) => {
    if (seen.has(task.id))
      issues.push({
        path: `tasks.${index}.id`,
        message: `Duplicate task id "${task.id}".`,
      });
    seen.add(task.id);
  });

  plan.tasks.forEach((task, index) => {
    task.dependencies.forEach((dependency, position) => {
      if (dependency === task.id)
        issues.push({
          path: `tasks.${index}.dependencies.${position}`,
          message: `Task "${task.id}" depends on itself.`,
        });
      else if (!seen.has(dependency))
        issues.push({
          path: `tasks.${index}.dependencies.${position}`,
          message: `Task "${task.id}" depends on unknown task "${dependency}".`,
        });
    });
    if (task.suggestedAgent !== undefined && !known.has(task.suggestedAgent))
      issues.push({
        path: `tasks.${index}.suggestedAgent`,
        message: `Unknown agent "${task.suggestedAgent}". Use one of: ${
          knownAgents.length === 0 ? "(none declared)" : knownAgents.join(", ")
        }, or omit the field.`,
      });
  });

  if (issues.length === 0) {
    try {
      new TaskGraph(plan);
    } catch (error) {
      issues.push({
        path: "tasks",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return issues;
}

interface Attempt {
  readonly call: { readonly id: string; readonly input: unknown } | undefined;
  readonly text: string;
}

/**
 * Turns an objective into an {@link ExecutionPlan} by forcing an LLM to fill in
 * a single `emit_plan` tool call, then validating the result and asking for
 * corrections when it does not hold up.
 */
export class LlmPlanner {
  readonly #options: LlmPlannerOptions;

  constructor(options: LlmPlannerOptions) {
    this.#options = options;
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
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: systemPrompt(policy, this.#options.knownAgents),
      },
      { role: "user", content: `Plan this objective:\n\n${objective}` },
    ];

    let lastIssues: readonly PlanIssue[] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const { call, text } = await this.#runAttempt(messages, signal);
      signal?.throwIfAborted();

      if (call === undefined) {
        lastIssues = [
          {
            path: "(root)",
            message: `no ${EMIT_PLAN_TOOL_NAME} tool call in the response`,
          },
        ];
        if (attempt === maxAttempts) break;
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content: `You did not call ${EMIT_PLAN_TOOL_NAME}. Reply with exactly one ${EMIT_PLAN_TOOL_NAME} tool call carrying the plan, and no prose.`,
        });
        continue;
      }

      const parsed = ExecutionPlanSchema.safeParse(call.input);
      if (parsed.success) {
        const plan = toPlan(parsed.data);
        const issues = validatePlanDraft(plan, this.#options.knownAgents);
        if (issues.length === 0) return plan;
        lastIssues = issues;
      } else {
        lastIssues = toIssues(parsed.error);
      }

      if (attempt === maxAttempts) break;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: call.id, name: EMIT_PLAN_TOOL_NAME, input: call.input },
        ],
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `That ${EMIT_PLAN_TOOL_NAME} call is not a usable plan:\n${formatIssues(
          lastIssues,
        )}\n\nCall ${EMIT_PLAN_TOOL_NAME} again with a corrected plan that fixes every issue above. Do not reply with prose.`,
      });
    }

    throw new PlanError({
      message: `Failed to plan the objective after ${maxAttempts} attempt(s).${
        lastIssues === undefined ? "" : `\n${formatIssues(lastIssues)}`
      }`,
      attempts: maxAttempts,
      ...(lastIssues === undefined ? {} : { lastIssues }),
    });
  }

  async #runAttempt(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<Attempt> {
    const { maxOutputTokens } = this.#options;
    const request: ModelRequest = {
      model: this.#options.model,
      messages: [...messages],
      tools: [emitPlanTool],
      toolChoice: { type: "tool", name: EMIT_PLAN_TOOL_NAME },
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };

    let call: { id: string; input: unknown } | undefined;
    let text = "";
    for await (const event of this.#options.provider.stream(request, signal)) {
      if (event.type === "text.delta") {
        text += event.text;
        continue;
      }
      if (
        event.type === "tool.call" &&
        event.name === EMIT_PLAN_TOOL_NAME &&
        call === undefined
      ) {
        call = { id: event.id, input: event.input };
      }
    }
    return { call, text };
  }
}
