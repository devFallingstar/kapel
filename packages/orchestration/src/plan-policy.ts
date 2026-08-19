import type { OrchestrationPolicy, ReviewRule } from "@agent/policy";
import { TaskGraph } from "./graph.js";
import {
  complexityRank,
  type ExecutionPlan,
  type PlannedTask,
} from "./types.js";

export interface PlanRewriteResult {
  /** The plan the runtime should execute: validated, sanitized, reviewed. */
  readonly plan: ExecutionPlan;
  /** Ids of the review tasks this rewrite added, in injection order. */
  readonly injectedReviews: readonly string[];
  /** Reasons the plan cannot be run at all. Non-empty means "reject". */
  readonly issues: readonly string[];
  /** Non-fatal adjustments and observations worth surfacing to a human. */
  readonly notes: readonly string[];
}

/**
 * Deterministically reconciles a plan with a policy.
 *
 * Two jobs: reject a plan the scheduler could not run (duplicate ids, dangling
 * dependencies, cycles), and add the reviews the policy mandates. Nothing here
 * throws — an unrunnable plan comes back with `issues` populated so the caller
 * can decide whether to re-plan or give up.
 */
export function applyPolicyToPlan(
  plan: ExecutionPlan,
  policy: OrchestrationPolicy,
  knownAgents: ReadonlySet<string>,
): PlanRewriteResult {
  const issues: string[] = [];
  const notes: string[] = [];

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) issues.push(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  const tasks = plan.tasks.map((task) =>
    sanitizeAgent(task, knownAgents, notes),
  );

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id)
        issues.push(`Task ${task.id} depends on itself.`);
      else if (!ids.has(dependency))
        issues.push(`Task ${task.id} depends on missing task ${dependency}`);
    }
  }

  if (issues.length === 0) {
    try {
      new TaskGraph({ objective: plan.objective, tasks });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const injected: PlannedTask[] = [];
  const injectedReviews: string[] = [];
  const taken = new Set(ids);

  for (const rule of policy.review) {
    if (
      rule.riskCategories.length === 0 &&
      rule.minimumComplexity === undefined
    )
      notes.push(
        `Review rule ${rule.id} constrains neither risk categories nor minimum complexity, so it matches no task and injected nothing.`,
      );
  }

  for (const rule of policy.review) {
    for (const task of tasks) {
      if (!ruleMatches(rule, task)) continue;
      if (task.type === "review") continue;

      const id = sanitizeId(`${task.id}-review-${rule.id}`);
      if (taken.has(id)) continue;
      if (
        [...tasks, ...injected].some(
          (candidate) =>
            candidate.type === "review" &&
            candidate.dependencies.includes(task.id) &&
            candidate.suggestedAgent === rule.reviewer,
        )
      )
        continue;

      const reviewerKnown = knownAgents.has(rule.reviewer);
      if (!reviewerKnown)
        notes.push(
          `Review rule ${rule.id} names unknown reviewer "${rule.reviewer}"; ${id} was injected without a suggested agent.`,
        );

      injected.push({
        id,
        title: `Review: ${task.title}`,
        goal: `Review the work done by ${task.id} (${task.title}) against policy rule ${rule.id}${
          rule.riskCategories.length === 0
            ? ""
            : ` covering ${rule.riskCategories.join(", ")}`
        }. Confirm the goal was met, flag defects and risks, and state whether the change is safe to keep.`,
        type: "review",
        complexity: "normal",
        dependencies: [task.id],
        ...(reviewerKnown ? { suggestedAgent: rule.reviewer } : {}),
        affectedAreas: task.affectedAreas,
        risk: task.risk,
      });
      taken.add(id);
      injectedReviews.push(id);
    }
  }

  return {
    plan: { objective: plan.objective, tasks: [...tasks, ...injected] },
    injectedReviews,
    issues,
    notes,
  };
}

function ruleMatches(rule: ReviewRule, task: PlannedTask): boolean {
  const hasCategories = rule.riskCategories.length > 0;
  const hasComplexity = rule.minimumComplexity !== undefined;
  if (!hasCategories && !hasComplexity) return false;
  if (
    hasCategories &&
    !rule.riskCategories.some((category) =>
      task.risk.categories.includes(category),
    )
  )
    return false;
  if (
    rule.minimumComplexity !== undefined &&
    complexityRank(task.complexity) < complexityRank(rule.minimumComplexity)
  )
    return false;
  return true;
}

function sanitizeAgent(
  task: PlannedTask,
  knownAgents: ReadonlySet<string>,
  notes: string[],
): PlannedTask {
  if (task.suggestedAgent === undefined || knownAgents.has(task.suggestedAgent))
    return task;
  notes.push(
    `Task ${task.id} suggested unknown agent "${task.suggestedAgent}"; the suggestion was dropped.`,
  );
  const { suggestedAgent: _dropped, ...rest } = task;
  return rest;
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-");
}
