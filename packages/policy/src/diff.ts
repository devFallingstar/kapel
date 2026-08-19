import type {
  EscalationRule,
  OrchestrationPolicy,
  ReviewRule,
  RoutingRule,
} from "./schema.js";

/** One field that differs between the before/after version of a rule or the policy defaults. */
export interface PolicyFieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * One rule's before/after state, keyed by the rule's own `id` — see
 * {@link diffPolicies} for why `id` is the identity used.
 */
export type RuleDiff<T> =
  | { readonly id: string; readonly kind: "added"; readonly after: T }
  | { readonly id: string; readonly kind: "removed"; readonly before: T }
  | {
      readonly id: string;
      readonly kind: "changed";
      readonly before: T;
      readonly after: T;
      readonly changes: readonly PolicyFieldChange[];
    };

/** What would change if the policy lock were recompiled — the body of `kapel policy diff`. */
export interface PolicyDiff {
  readonly defaults: readonly PolicyFieldChange[];
  readonly routing: readonly RuleDiff<RoutingRule>[];
  readonly review: readonly RuleDiff<ReviewRule>[];
  readonly escalation: readonly RuleDiff<EscalationRule>[];
  /** `true` when every section above is empty. */
  readonly unchanged: boolean;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = a.map((value) => String(value)).sort();
    const right = b.map((value) => String(value)).sort();
    return left.every((value, index) => value === right[index]);
  }
  return a === b;
}

function fieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly PolicyFieldChange[] {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("id");
  const changes: PolicyFieldChange[] = [];
  for (const field of [...keys].sort()) {
    const beforeValue = before[field];
    const afterValue = after[field];
    if (!valuesEqual(beforeValue, afterValue)) {
      changes.push({ field, before: beforeValue, after: afterValue });
    }
  }
  return changes;
}

/**
 * Diffs two lists of rules by `id` — every rule the compiler emits already
 * carries a short, stable, kebab-case `id` that the compiler is instructed
 * to keep unique within the policy (see `IR_REFERENCE` in `compiler.ts`), so
 * it is the natural identity for "is this the same rule, changed" versus "a
 * rule was added/removed". Index position is not used: reordering a
 * `routing:` list between compiles (which the LLM has no reason to keep
 * stable) would otherwise show every rule as changed.
 */
function diffRules<T extends { readonly id: string }>(
  before: readonly T[],
  after: readonly T[],
): readonly RuleDiff<T>[] {
  const beforeById = new Map(before.map((rule) => [rule.id, rule] as const));
  const afterById = new Map(after.map((rule) => [rule.id, rule] as const));
  const diffs: RuleDiff<T>[] = [];

  for (const [id, beforeRule] of beforeById) {
    const afterRule = afterById.get(id);
    if (afterRule === undefined) {
      diffs.push({ id, kind: "removed", before: beforeRule });
      continue;
    }
    const changes = fieldChanges(
      beforeRule as unknown as Record<string, unknown>,
      afterRule as unknown as Record<string, unknown>,
    );
    if (changes.length > 0) {
      diffs.push({
        id,
        kind: "changed",
        before: beforeRule,
        after: afterRule,
        changes,
      });
    }
  }
  for (const [id, afterRule] of afterById) {
    if (!beforeById.has(id))
      diffs.push({ id, kind: "added", after: afterRule });
  }

  return diffs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const DEFAULT_FIELDS = [
  "orchestrator",
  "maxConcurrency",
  "parallelizeIndependentTasks",
  "defaultMaxAttempts",
] as const;

function diffDefaults(
  before: OrchestrationPolicy,
  after: OrchestrationPolicy,
): readonly PolicyFieldChange[] {
  const changes: PolicyFieldChange[] = [];
  for (const field of DEFAULT_FIELDS) {
    if (before[field] !== after[field]) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }
  return changes;
}

/**
 * Diffs two policies at field level: routing/review/escalation rules
 * (added/removed/changed, matched by `id`) plus the top-level defaults
 * (`orchestrator`, `maxConcurrency`, `parallelizeIndependentTasks`,
 * `defaultMaxAttempts`). Pure and offline — the body of `kapel policy diff`
 * once both policies are in hand.
 */
export function diffPolicies(
  before: OrchestrationPolicy,
  after: OrchestrationPolicy,
): PolicyDiff {
  const defaults = diffDefaults(before, after);
  const routing = diffRules(before.routing, after.routing);
  const review = diffRules(before.review, after.review);
  const escalation = diffRules(before.escalation, after.escalation);
  return {
    defaults,
    routing,
    review,
    escalation,
    unchanged:
      defaults.length === 0 &&
      routing.length === 0 &&
      review.length === 0 &&
      escalation.length === 0,
  };
}

function fmtValue(value: unknown): string {
  if (value === undefined) return "(none)";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(", ");
  return String(value);
}

function summarizeRouting(rule: RoutingRule): string {
  return `${rule.agent} (${rule.strength}, weight ${rule.weight})`;
}

function summarizeReview(rule: ReviewRule): string {
  return `${rule.reviewer} (${rule.strength}, ${rule.blocking ? "blocking" : "advisory"})`;
}

function summarizeEscalation(rule: EscalationRule): string {
  return `${rule.fromAgent} -> ${rule.toAgent}`;
}

function renderRuleSection<T>(
  title: string,
  diffs: readonly RuleDiff<T>[],
  summarize: (rule: T) => string,
): readonly string[] {
  if (diffs.length === 0) return [];
  const lines: string[] = [`${title}:`];
  for (const diff of diffs) {
    if (diff.kind === "added") {
      lines.push(`  + ${diff.id}: ${summarize(diff.after)}`);
    } else if (diff.kind === "removed") {
      lines.push(`  - ${diff.id}: ${summarize(diff.before)}`);
    } else {
      lines.push(
        `  ~ ${diff.id}: ${summarize(diff.before)} -> ${summarize(diff.after)}`,
      );
      for (const change of diff.changes) {
        lines.push(
          `      ${change.field}: ${fmtValue(change.before)} -> ${fmtValue(change.after)}`,
        );
      }
    }
  }
  return lines;
}

function renderDefaults(
  defaults: readonly PolicyFieldChange[],
): readonly string[] {
  if (defaults.length === 0) return [];
  return [
    "Defaults:",
    ...defaults.map(
      (change) =>
        `  ${change.field}: ${fmtValue(change.before)} -> ${fmtValue(change.after)}`,
    ),
  ];
}

/**
 * Renders a {@link PolicyDiff} as review-friendly text — the body of `kapel
 * policy diff`. Sections with nothing to say are omitted; a blank line
 * separates the sections that remain.
 */
export function formatPolicyDiff(diff: PolicyDiff): readonly string[] {
  if (diff.unchanged) return ["No changes."];

  const sections = [
    renderDefaults(diff.defaults),
    renderRuleSection("Routing rules", diff.routing, summarizeRouting),
    renderRuleSection("Review rules", diff.review, summarizeReview),
    renderRuleSection("Escalation rules", diff.escalation, summarizeEscalation),
  ].filter((section) => section.length > 0);

  const lines: string[] = [];
  sections.forEach((section, index) => {
    if (index > 0) lines.push("");
    lines.push(...section);
  });
  return lines;
}
