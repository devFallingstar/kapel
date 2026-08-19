import type { OrchestrationPolicy, RoutingRule } from "@agent/policy";
import type { PlannedTask } from "./types.js";

export interface AgentRouter {
  route(task: PlannedTask, policy: OrchestrationPolicy): string;
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
    const candidates = policy.routing.filter((rule) => ruleMatches(rule, task));
    const hard = candidates.filter((rule) => rule.strength === "hard");
    const pool = hard.length > 0 ? hard : candidates;
    const best = [...pool].sort(byWeightThenId)[0];
    return best?.agent ?? task.suggestedAgent ?? policy.orchestrator;
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
