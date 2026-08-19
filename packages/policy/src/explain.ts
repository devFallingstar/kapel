import type {
  EscalationRule,
  OrchestrationPolicy,
  ReviewRule,
  RoutingRule,
} from "./schema.js";

function joinList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  const head = values.slice(0, -1).join(", ");
  return `${head} and ${values[values.length - 1] ?? ""}`;
}

/** "tasks", or the conditions that narrow which tasks a rule matches. */
function matchClause(rule: {
  readonly taskTypes?: readonly string[];
  readonly riskCategories?: readonly string[];
  readonly complexity?: readonly string[];
}): string {
  const parts: string[] = [];
  const taskTypes = rule.taskTypes ?? [];
  const riskCategories = rule.riskCategories ?? [];
  const complexity = rule.complexity ?? [];
  if (taskTypes.length > 0) parts.push(`${joinList(taskTypes)} tasks`);
  else parts.push("tasks");
  if (riskCategories.length > 0) {
    parts.push(`touching ${joinList(riskCategories)}`);
  }
  if (complexity.length > 0) {
    parts.push(`of ${joinList(complexity)} complexity`);
  }
  return parts.join(" ");
}

function describeRouting(rule: RoutingRule): string {
  const verb = rule.strength === "hard" ? "always route" : "prefer to route";
  const weight = rule.weight === 1 ? "" : ` [weight ${rule.weight}]`;
  return `- ${rule.id}: ${verb} ${matchClause(rule)} to ${rule.agent}${weight}`;
}

function describeReview(rule: ReviewRule): string {
  const blocking = rule.blocking
    ? "must pass before the work lands"
    : "is advisory";
  const strength = rule.strength === "hard" ? "required" : "preferred";
  const floor =
    rule.minimumComplexity === undefined
      ? ""
      : ` at ${rule.minimumComplexity} complexity or above`;
  return `- ${rule.id}: ${rule.reviewer} reviews ${matchClause(
    rule,
  )}${floor}; review ${blocking} (${strength})`;
}

function describeEscalation(rule: EscalationRule): string {
  const triggers: string[] = [];
  if (rule.afterFailures !== undefined) {
    triggers.push(
      `after ${rule.afterFailures} failed attempt${
        rule.afterFailures === 1 ? "" : "s"
      }`,
    );
  }
  if (rule.confidenceBelow !== undefined) {
    triggers.push(`when confidence drops below ${rule.confidenceBelow}`);
  }
  const when = triggers.length === 0 ? "on request" : joinList(triggers);
  return `- ${rule.id}: hand off from ${rule.fromAgent} to ${rule.toAgent} ${when}`;
}

function section<T>(
  title: string,
  rules: readonly T[],
  render: (rule: T) => string,
): readonly string[] {
  if (rules.length === 0) return [`${title}: none`];
  return [`${title} (${rules.length}):`, ...rules.map(render)];
}

/**
 * Renders a policy as a plain-English, multi-line summary — the body of
 * `kapel policy explain`.
 */
export function describePolicy(policy: OrchestrationPolicy): string {
  const lines: string[] = [
    `Orchestrator: ${policy.orchestrator}`,
    `Concurrency: up to ${policy.maxConcurrency} agent${
      policy.maxConcurrency === 1 ? "" : "s"
    } at a time`,
    `Independent tasks: ${
      policy.parallelizeIndependentTasks
        ? "may run in parallel"
        : "run one at a time"
    }`,
    `Attempts per task: ${policy.defaultMaxAttempts} before giving up`,
    ...section("Routing rules", policy.routing, describeRouting),
    ...section("Review rules", policy.review, describeReview),
    ...section("Escalation rules", policy.escalation, describeEscalation),
  ];
  return lines.join("\n");
}
