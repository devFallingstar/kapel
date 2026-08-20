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
 * Hard rules win over preferences, and within a strength band the ranking is:
 *
 * 1. **specificity** — how much of the task the rule actually pinned down;
 * 2. **weight** — the dial a human sets between comparable rules;
 * 3. **rule id**, ascending, so routing never depends on the order the compiler
 *    happened to emit rules in.
 *
 * With no matching rule the task's own suggestion is used, and failing that the
 * orchestrator.
 *
 * Specificity comes first because a catch-all and a targeted rule are not
 * really competing for the same job. A compiled policy routinely carries a tier
 * rule (`route-coder`: "normal-complexity work goes to the coder", matching on
 * complexity alone) next to a targeted one (`route-reviewer`: "review tasks go
 * to the reviewer", matching on task type alone), both hard, both at the
 * default weight. On an injected review both match, and ranking by weight alone
 * left the winner to `"route-coder" < "route-reviewer"` — so the coder reviewed
 * its own tier's code, holding its own write tools. Expressing "the rule that
 * named this task type means this task" should not require reaching for the
 * weight dial. See {@link specificity} for how the two are compared.
 */
export class PolicyRouter implements AgentRouter {
  route(task: PlannedTask, policy: OrchestrationPolicy): string {
    return this.decide(task, policy).agent;
  }

  decide(task: PlannedTask, policy: OrchestrationPolicy): RoutingDecision {
    const candidates = policy.routing.filter((rule) => ruleMatches(rule, task));
    const hard = candidates.filter((rule) => rule.strength === "hard");
    const pool = hard.length > 0 ? hard : candidates;
    const best = [...pool].sort(bySpecificityThenWeightThenId)[0];
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

/**
 * What a populated facet is worth when two rules pinned down the same *number*
 * of facets.
 *
 * Count alone does not separate the pair that caused the bug — a tier rule
 * carrying only `complexity` and a reviewer rule carrying only `taskTypes` both
 * constrain exactly one facet — so the facets are ranked among themselves by
 * how much they say about *who should do this task*. `taskTypes` says what the
 * work is ("this is a review"), which is the strongest claim on an agent;
 * `riskCategories` says what it touches; `complexity` only says how big it is,
 * which is how tier rules spread themselves across all work of a size.
 */
const FACET_RANK = { taskTypes: 4, riskCategories: 2, complexity: 1 } as const;

/**
 * How much of the task a rule pinned down: `count` facets, plus `rank` to
 * separate rules that pinned down equally many.
 *
 * Only rules that already matched are ranked, so "populated" and "matched" are
 * the same thing here — an empty facet is "any" and constrains nothing, which
 * is exactly why it earns no specificity.
 */
function specificity(rule: RoutingRule): {
  readonly count: number;
  readonly rank: number;
} {
  const facets = [
    rule.taskTypes.length > 0 ? FACET_RANK.taskTypes : 0,
    rule.riskCategories.length > 0 ? FACET_RANK.riskCategories : 0,
    rule.complexity.length > 0 ? FACET_RANK.complexity : 0,
  ];
  return {
    count: facets.filter((value) => value > 0).length,
    rank: facets.reduce((total, value) => total + value, 0),
  };
}

function bySpecificityThenWeightThenId(a: RoutingRule, b: RoutingRule): number {
  const left = specificity(a);
  const right = specificity(b);
  // Count dominates rank: two named facets beat one, whichever facets they are.
  if (left.count !== right.count) return right.count - left.count;
  if (left.rank !== right.rank) return right.rank - left.rank;
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
