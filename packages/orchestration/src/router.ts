import type { OrchestrationPolicy, RoutingRule } from "@agent/policy";
import type { PlannedTask } from "./types.js";

/** Why {@link PolicyRouter} picked the agent it did. */
export type RoutingReason = "rule" | "suggestedAgent" | "orchestrator";

/** A routing decision: who got the task, and what decided it. */
export interface RoutingDecision {
  readonly agent: string;
  /** The routing rule that decided it, set only when `reason` is `"rule"`. */
  readonly rule?: string;
  readonly reason: RoutingReason;
}

export interface AgentRouter {
  route(task: PlannedTask, policy: OrchestrationPolicy): string;
  /**
   * The same decision as {@link route}, with the rationale attached.
   * Optional so a minimal router need only implement `route`; callers that
   * want the rationale (the scheduler's `task.started` event, `kapel
   * explain`) fall back to reporting it as unknown when this is absent.
   */
  decide?(task: PlannedTask, policy: OrchestrationPolicy): RoutingDecision;
}

/**
 * Picks the agent for a task from the policy's routing rules.
 *
 * A rule matches when every populated facet of it matches the task
 * (`taskTypes`, `riskCategories`, `complexity`); an empty facet means "any".
 * Hard rules win over preferences; within a strength band the highest weight
 * wins, and ties are broken by rule id so routing never depends on the order
 * the compiler happened to emit rules in. With no matching rule the task's own
 * suggestion is used, and failing that the orchestrator.
 */
export class PolicyRouter implements AgentRouter {
  route(task: PlannedTask, policy: OrchestrationPolicy): string {
    return this.decide(task, policy).agent;
  }

  decide(task: PlannedTask, policy: OrchestrationPolicy): RoutingDecision {
    const candidates = policy.routing.filter((rule) => ruleMatches(rule, task));
    const hard = candidates.filter((rule) => rule.strength === "hard");
    const pool = hard.length > 0 ? hard : candidates;
    const best = [...pool].sort(byWeightThenId)[0];
    if (best !== undefined) {
      return { agent: best.agent, rule: best.id, reason: "rule" };
    }
    if (task.suggestedAgent !== undefined) {
      return { agent: task.suggestedAgent, reason: "suggestedAgent" };
    }
    return { agent: policy.orchestrator, reason: "orchestrator" };
  }
}

function ruleMatches(rule: RoutingRule, task: PlannedTask): boolean {
  return (
    matches(rule.taskTypes, task.type) &&
    matches(rule.riskCategories, task.risk.categories) &&
    matches(rule.complexity, task.complexity)
  );
}

function byWeightThenId(a: RoutingRule, b: RoutingRule): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function matches(
  expected: readonly string[],
  actual: string | readonly string[],
): boolean {
  if (expected.length === 0) return true;
  const values: readonly string[] =
    typeof actual === "string" ? [actual] : actual;
  return expected.some((value) => values.includes(value));
}
