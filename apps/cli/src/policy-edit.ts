import type {
  Complexity,
  EscalationRule,
  OrchestrationPolicy,
  ReviewRule,
  RoutingRule,
} from "@agent/coding-agent";
import { PolicySchema, validatePolicy } from "@agent/coding-agent";
import type { Suspend } from "./config-runtime.js";
import type { SelectChoice, SelectPromptIo } from "./select-prompt.js";
import { runSelectPrompt, runTextPrompt } from "./select-prompt.js";

/**
 * The policy editor: `kapel policy edit`, and `/policy` inside the REPL.
 *
 * Editing the IR directly is what makes a policy change free. The compile
 * only stopped calling a model for sources in kapel's canonical form (see
 * `canonical.ts`), and asking people to hand-write that form would be a poor
 * trade — so this screen edits the four scalars and three rule lists the IR
 * actually has, and the caller renders the file back out of the result. A
 * change made here never reaches a model, whatever it changes.
 *
 * Written against a {@link PolicyEditPrompt} rather than a terminal, exactly
 * as `config-wizard.ts` is, so the whole flow can be driven by scripted
 * answers in a test.
 */

export interface PolicyEditPrompt {
  select(options: {
    readonly title: string;
    readonly choices: readonly SelectChoice[];
    readonly initial?: string | readonly string[];
    readonly multi?: boolean;
    readonly required?: boolean;
    readonly footer?: string;
  }): Promise<readonly string[] | undefined>;
  text(options: {
    readonly title: string;
    readonly initial?: string;
    readonly footer?: string;
  }): Promise<string | undefined>;
}

export interface PolicyEditorDeps {
  readonly prompt: PolicyEditPrompt;
  readonly write: (line: string) => void;
  /** The policy the editor opens on. */
  readonly policy: OrchestrationPolicy;
  /** The agents this project defines — every agent field picks from these. */
  readonly knownAgents: readonly string[];
  /**
   * Whether saving will replace a prose policy with the canonical form.
   *
   * Only changes what the save choice says, but it has to say it: someone
   * whose `orchestration.md` is three paragraphs of English deserves to know
   * that "save" rewrites them, not that it edits around them.
   */
  readonly converting?: boolean;
}

const BACK = "back";
const CANCEL = "cancel";
const SAVE = "save";
const ADD = "add";
const REMOVE = "remove";

const COMPLEXITIES: readonly Complexity[] = [
  "trivial",
  "normal",
  "complex",
  "architectural",
];

const LIST_FOOTER = "comma-separated · clear the line to leave it unchanged";

/** The one answer of a single-select, or `undefined` when it was cancelled. */
async function ask(
  deps: PolicyEditorDeps,
  title: string,
  choices: readonly SelectChoice[],
  initial?: string,
): Promise<string | undefined> {
  const values = await deps.prompt.select({
    title,
    choices,
    ...(initial === undefined ? {} : { initial }),
  });
  return values?.[0];
}

function asChoices(values: readonly string[]): readonly SelectChoice[] {
  return values.map((value) => ({ value, label: value }));
}

function describeList(values: readonly string[]): string {
  return values.length === 0 ? "(any)" : values.join(", ");
}

/** Splits a typed `a, b, c` into items, dropping the blanks. */
function parseList(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

async function askList(
  deps: PolicyEditorDeps,
  title: string,
  current: readonly string[],
): Promise<readonly string[] | undefined> {
  const raw = await deps.prompt.text({
    title: `${title} — type "-" for none`,
    initial: current.join(", "),
    footer: LIST_FOOTER,
  });
  if (raw === undefined) return undefined;
  return raw.trim() === "-" ? [] : parseList(raw);
}

/**
 * A small positive integer: the handful anyone actually picks, plus a way to
 * type one that isn't offered.
 */
async function askCount(
  deps: PolicyEditorDeps,
  title: string,
  current: number,
  offered: number,
): Promise<number | undefined> {
  const choices: SelectChoice[] = Array.from(
    { length: offered },
    (_, index) => ({ value: String(index + 1), label: String(index + 1) }),
  );
  choices.push({ value: "other", label: "another number…" });

  const answer = await ask(
    deps,
    title,
    choices,
    current <= offered ? String(current) : "other",
  );
  if (answer === undefined) return undefined;
  if (answer !== "other") return Number.parseInt(answer, 10);

  const typed = await deps.prompt.text({
    title: `${title} — a whole number above zero`,
    initial: String(current),
  });
  if (typed === undefined) return undefined;
  const parsed = Number.parseInt(typed.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    deps.write(
      `"${typed.trim()}" is not a whole number above zero — unchanged.`,
    );
    return undefined;
  }
  return parsed;
}

/** A 0..1 threshold, or `null` for "no threshold at all". */
async function askFraction(
  deps: PolicyEditorDeps,
  title: string,
  current: number | undefined,
): Promise<number | null | undefined> {
  const typed = await deps.prompt.text({
    title: `${title} — between 0 and 1, or "-" for none`,
    initial: current === undefined ? "" : String(current),
  });
  if (typed === undefined) return undefined;
  if (typed.trim() === "-") return null;
  const parsed = Number.parseFloat(typed.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    deps.write(
      `"${typed.trim()}" is not a number between 0 and 1 — unchanged.`,
    );
    return undefined;
  }
  return parsed;
}

async function askAgent(
  deps: PolicyEditorDeps,
  title: string,
  current: string,
): Promise<string | undefined> {
  if (deps.knownAgents.length === 0) {
    return await deps.prompt.text({ title, initial: current });
  }
  return await ask(deps, title, asChoices(deps.knownAgents), current);
}

async function askComplexity(
  deps: PolicyEditorDeps,
  title: string,
  current: readonly Complexity[],
): Promise<readonly Complexity[] | undefined> {
  const values = await deps.prompt.select({
    title: `${title} (space to toggle; none means any)`,
    choices: asChoices(COMPLEXITIES),
    multi: true,
    initial: [...current],
    footer: "↑↓ move · space toggle · enter confirm · esc cancel",
  });
  if (values === undefined) return undefined;
  return COMPLEXITIES.filter((item) => values.includes(item));
}

async function askId(
  deps: PolicyEditorDeps,
  current: string,
): Promise<string | undefined> {
  const typed = await deps.prompt.text({
    title: "Rule id — a short name for this rule",
    initial: current,
  });
  return typed?.trim() === "" ? undefined : typed?.trim();
}

// --- Rule editors -----------------------------------------------------------

function summarizeRouting(rule: RoutingRule): string {
  const narrows = [
    ...(rule.taskTypes.length > 0 ? [rule.taskTypes.join("/")] : []),
    ...(rule.riskCategories.length > 0
      ? [`touching ${rule.riskCategories.join("/")}`]
      : []),
    ...(rule.complexity.length > 0 ? [rule.complexity.join("/")] : []),
  ];
  const verb = rule.strength === "hard" ? "always" : "prefer";
  const where = narrows.length === 0 ? "anything" : narrows.join(" ");
  return `${rule.id}: ${verb} ${where} → ${rule.agent}`;
}

function summarizeReview(rule: ReviewRule): string {
  const where =
    rule.riskCategories.length === 0
      ? "anything"
      : rule.riskCategories.join("/");
  const floor =
    rule.minimumComplexity === undefined ? "" : ` ≥${rule.minimumComplexity}`;
  return `${rule.id}: ${rule.reviewer} reviews ${where}${floor} (${
    rule.blocking ? "blocking" : "advisory"
  })`;
}

function summarizeEscalation(rule: EscalationRule): string {
  const triggers = [
    ...(rule.afterFailures === undefined
      ? []
      : [`after ${rule.afterFailures}`]),
    ...(rule.confidenceBelow === undefined
      ? []
      : [`below ${rule.confidenceBelow}`]),
  ];
  return `${rule.id}: ${rule.fromAgent} → ${rule.toAgent}${
    triggers.length === 0 ? "" : ` (${triggers.join(", ")})`
  }`;
}

/**
 * What one rule's screen came back with.
 *
 * Three answers, not two: `keep` carries the rule as it now stands, `remove`
 * takes it out, and `cancel` — escape, or a closed prompt — leaves everything
 * as it was. Cancelling has to be its own answer rather than "keep with no
 * changes", because on the *add* screen those mean opposite things: backing
 * out of a new rule you did not want must not add it, while accepting one
 * whose defaults were already right must.
 */
export type RuleEdit<T> =
  | { readonly kind: "keep"; readonly rule: T }
  | { readonly kind: "remove" }
  | { readonly kind: "cancel" };

/** One rule's own screen: every field, plus a way to delete it. */
async function editRoutingRule(
  deps: PolicyEditorDeps,
  rule: RoutingRule,
): Promise<RuleEdit<RoutingRule>> {
  let draft = rule;
  for (;;) {
    const field = await ask(deps, summarizeRouting(draft), [
      { value: "id", label: `Id: ${draft.id}` },
      { value: "agent", label: `Route to: ${draft.agent}` },
      {
        value: "strength",
        label: `Strength: ${draft.strength === "hard" ? "always" : "prefer"}`,
      },
      {
        value: "taskTypes",
        label: `Task types: ${describeList(draft.taskTypes)}`,
      },
      {
        value: "riskCategories",
        label: `Risk categories: ${describeList(draft.riskCategories)}`,
      },
      {
        value: "complexity",
        label: `Complexity: ${describeList(draft.complexity)}`,
      },
      { value: "weight", label: `Weight: ${draft.weight}` },
      { value: REMOVE, label: "Remove this rule" },
      { value: BACK, label: "Back" },
    ]);

    if (field === undefined) return { kind: "cancel" };
    if (field === BACK) return { kind: "keep", rule: draft };
    if (field === REMOVE) return { kind: "remove" };

    if (field === "id") {
      const id = await askId(deps, draft.id);
      if (id !== undefined) draft = { ...draft, id };
    } else if (field === "agent") {
      const agent = await askAgent(deps, "Route to", draft.agent);
      if (agent !== undefined) draft = { ...draft, agent };
    } else if (field === "strength") {
      const strength = await ask(
        deps,
        "How firm is this rule?",
        [
          { value: "hard", label: "always — a requirement" },
          { value: "preference", label: "prefer — a leaning" },
        ],
        draft.strength,
      );
      if (strength === "hard" || strength === "preference") {
        draft = { ...draft, strength };
      }
    } else if (field === "taskTypes") {
      const taskTypes = await askList(deps, "Task types", draft.taskTypes);
      if (taskTypes !== undefined)
        draft = { ...draft, taskTypes: [...taskTypes] };
    } else if (field === "riskCategories") {
      const riskCategories = await askList(
        deps,
        "Risk categories",
        draft.riskCategories,
      );
      if (riskCategories !== undefined) {
        draft = { ...draft, riskCategories: [...riskCategories] };
      }
    } else if (field === "complexity") {
      const complexity = await askComplexity(
        deps,
        "Complexity",
        draft.complexity,
      );
      if (complexity !== undefined) {
        draft = { ...draft, complexity: [...complexity] };
      }
    } else if (field === "weight") {
      const weight = await askFraction(
        deps,
        "Weight — a tie-breaker among preferences",
        draft.weight,
      );
      // "None" is not an answer a weight has; the schema's own default is.
      if (typeof weight === "number") draft = { ...draft, weight };
      else if (weight === null) draft = { ...draft, weight: 1 };
    }
  }
}

async function editReviewRule(
  deps: PolicyEditorDeps,
  rule: ReviewRule,
): Promise<RuleEdit<ReviewRule>> {
  let draft = rule;
  for (;;) {
    const field = await ask(deps, summarizeReview(draft), [
      { value: "id", label: `Id: ${draft.id}` },
      { value: "reviewer", label: `Reviewer: ${draft.reviewer}` },
      {
        value: "riskCategories",
        label: `Risk categories: ${describeList(draft.riskCategories)}`,
      },
      {
        value: "minimumComplexity",
        label: `Minimum complexity: ${draft.minimumComplexity ?? "(any)"}`,
      },
      {
        value: "blocking",
        label: `Verdict: ${draft.blocking ? "blocking" : "advisory"}`,
      },
      {
        value: "strength",
        label: `Strength: ${draft.strength === "hard" ? "required" : "preferred"}`,
      },
      { value: REMOVE, label: "Remove this rule" },
      { value: BACK, label: "Back" },
    ]);

    if (field === undefined) return { kind: "cancel" };
    if (field === BACK) return { kind: "keep", rule: draft };
    if (field === REMOVE) return { kind: "remove" };

    if (field === "id") {
      const id = await askId(deps, draft.id);
      if (id !== undefined) draft = { ...draft, id };
    } else if (field === "reviewer") {
      const reviewer = await askAgent(deps, "Reviewer", draft.reviewer);
      if (reviewer !== undefined) draft = { ...draft, reviewer };
    } else if (field === "riskCategories") {
      const riskCategories = await askList(
        deps,
        "Risk categories",
        draft.riskCategories,
      );
      if (riskCategories !== undefined) {
        draft = { ...draft, riskCategories: [...riskCategories] };
      }
    } else if (field === "minimumComplexity") {
      const answer = await ask(
        deps,
        "Review work at this complexity or above",
        [
          { value: "any", label: "(any complexity)" },
          ...asChoices(COMPLEXITIES),
        ],
        draft.minimumComplexity ?? "any",
      );
      if (answer === "any") {
        const { minimumComplexity: _dropped, ...rest } = draft;
        draft = rest;
      } else if (answer !== undefined) {
        draft = { ...draft, minimumComplexity: answer as Complexity };
      }
    } else if (field === "blocking") {
      const answer = await ask(
        deps,
        "What does this review decide?",
        [
          {
            value: "blocking",
            label: "blocking — must pass before work lands",
          },
          { value: "advisory", label: "advisory — reported, never gating" },
        ],
        draft.blocking ? "blocking" : "advisory",
      );
      if (answer !== undefined)
        draft = { ...draft, blocking: answer === "blocking" };
    } else if (field === "strength") {
      const answer = await ask(
        deps,
        "How firm is this rule?",
        [
          { value: "hard", label: "required" },
          { value: "preference", label: "preferred" },
        ],
        draft.strength,
      );
      if (answer === "hard" || answer === "preference") {
        draft = { ...draft, strength: answer };
      }
    }
  }
}

async function editEscalationRule(
  deps: PolicyEditorDeps,
  rule: EscalationRule,
): Promise<RuleEdit<EscalationRule>> {
  let draft = rule;
  for (;;) {
    const field = await ask(deps, summarizeEscalation(draft), [
      { value: "id", label: `Id: ${draft.id}` },
      { value: "fromAgent", label: `From: ${draft.fromAgent}` },
      { value: "toAgent", label: `To: ${draft.toAgent}` },
      {
        value: "afterFailures",
        label: `After failed attempts: ${draft.afterFailures ?? "(never)"}`,
      },
      {
        value: "confidenceBelow",
        label: `When confidence below: ${draft.confidenceBelow ?? "(never)"}`,
      },
      { value: REMOVE, label: "Remove this rule" },
      { value: BACK, label: "Back" },
    ]);

    if (field === undefined) return { kind: "cancel" };
    if (field === BACK) return { kind: "keep", rule: draft };
    if (field === REMOVE) return { kind: "remove" };

    if (field === "id") {
      const id = await askId(deps, draft.id);
      if (id !== undefined) draft = { ...draft, id };
    } else if (field === "fromAgent") {
      const fromAgent = await askAgent(deps, "Escalate from", draft.fromAgent);
      if (fromAgent !== undefined) draft = { ...draft, fromAgent };
    } else if (field === "toAgent") {
      const toAgent = await askAgent(deps, "Escalate to", draft.toAgent);
      if (toAgent !== undefined) draft = { ...draft, toAgent };
    } else if (field === "afterFailures") {
      const answer = await ask(
        deps,
        "Escalate after how many failed attempts?",
        [
          { value: "never", label: "(never on failures)" },
          ...asChoices(["1", "2", "3", "4", "5"]),
        ],
        draft.afterFailures === undefined
          ? "never"
          : String(draft.afterFailures),
      );
      if (answer === "never") {
        const { afterFailures: _dropped, ...rest } = draft;
        draft = rest;
      } else if (answer !== undefined) {
        draft = { ...draft, afterFailures: Number.parseInt(answer, 10) };
      }
    } else if (field === "confidenceBelow") {
      const answer = await askFraction(
        deps,
        "Escalate when confidence drops below",
        draft.confidenceBelow,
      );
      if (answer === null) {
        const { confidenceBelow: _dropped, ...rest } = draft;
        draft = rest;
      } else if (answer !== undefined) {
        draft = { ...draft, confidenceBelow: answer };
      }
    }
  }
}

// --- Rule lists -------------------------------------------------------------

/**
 * One rule list's screen. Returns `undefined` when nothing changed, so the
 * caller can leave the draft alone rather than replacing it with an equal
 * copy.
 */
async function editRuleList<T>(
  deps: PolicyEditorDeps,
  title: string,
  rules: readonly T[],
  summarize: (rule: T) => string,
  blank: () => T,
  edit: (deps: PolicyEditorDeps, rule: T) => Promise<RuleEdit<T>>,
): Promise<readonly T[] | undefined> {
  let draft = [...rules];
  let changed = false;

  for (;;) {
    const answer = await ask(deps, title, [
      ...draft.map((rule, index) => ({
        value: String(index),
        label: summarize(rule),
      })),
      { value: ADD, label: "Add a rule…" },
      { value: BACK, label: "Back" },
    ]);

    if (answer === undefined || answer === BACK) {
      return changed ? draft : undefined;
    }
    if (answer === ADD) {
      const created = await edit(deps, blank());
      if (created.kind === "keep") {
        draft.push(created.rule);
        changed = true;
      }
      continue;
    }

    const index = Number.parseInt(answer, 10);
    const existing = draft[index];
    if (existing === undefined) continue;
    const updated = await edit(deps, existing);
    if (updated.kind === "remove") {
      draft = draft.filter((_, at) => at !== index);
      changed = true;
    } else if (updated.kind === "keep") {
      draft = draft.map((rule, at) => (at === index ? updated.rule : rule));
      changed = true;
    }
  }
}

// --- The editor -------------------------------------------------------------

const EDITOR_TITLE = "Orchestration policy";

function mainChoices(
  policy: OrchestrationPolicy,
  deps: PolicyEditorDeps,
): readonly SelectChoice[] {
  return [
    { value: "orchestrator", label: `Orchestrator: ${policy.orchestrator}` },
    {
      value: "concurrency",
      label: `Concurrency: up to ${policy.maxConcurrency} agent${
        policy.maxConcurrency === 1 ? "" : "s"
      } at a time`,
    },
    {
      value: "parallel",
      label: `Independent tasks: ${
        policy.parallelizeIndependentTasks
          ? "may run in parallel"
          : "run one at a time"
      }`,
    },
    {
      value: "attempts",
      label: `Attempts per task: ${policy.defaultMaxAttempts}`,
    },
    { value: "routing", label: `Routing rules (${policy.routing.length})…` },
    { value: "review", label: `Review rules (${policy.review.length})…` },
    {
      value: "escalation",
      label: `Escalation rules (${policy.escalation.length})…`,
    },
    {
      value: SAVE,
      label:
        deps.converting === true
          ? "Save — rewrite .agent/orchestration.md in canonical form (replaces the prose there)"
          : "Save — write .agent/orchestration.md and its lock",
    },
    { value: CANCEL, label: "Discard changes" },
  ];
}

/**
 * Runs the editor and returns the policy to write, or `undefined` when the
 * user discarded (or cancelled out of) it.
 *
 * Saving is gated on {@link validatePolicy}: a policy naming an agent this
 * project does not define is refused here rather than written and discovered
 * by the next `/plan`. Warnings are printed and saved through — they are
 * remarks about a policy that works, not reasons to refuse one.
 */
export async function runPolicyEditor(
  deps: PolicyEditorDeps,
): Promise<OrchestrationPolicy | undefined> {
  const fallbackAgent = deps.knownAgents[0] ?? deps.policy.orchestrator;
  let draft = deps.policy;

  const update = (patch: Partial<OrchestrationPolicy>): void => {
    const parsed = PolicySchema.safeParse({ ...draft, ...patch });
    if (parsed.success) draft = parsed.data;
  };

  for (;;) {
    const section = await ask(deps, EDITOR_TITLE, mainChoices(draft, deps));
    if (section === undefined || section === CANCEL) return undefined;

    if (section === SAVE) {
      const issues = validatePolicy(draft, new Set(deps.knownAgents));
      const errors = issues.filter((issue) => issue.severity === "error");
      for (const issue of issues.filter((i) => i.severity === "warning")) {
        deps.write(`warning: ${issue.message}`);
      }
      if (errors.length > 0) {
        deps.write("This policy cannot be saved yet:");
        for (const issue of errors) deps.write(`  - ${issue.message}`);
        continue;
      }
      return draft;
    }

    if (section === "orchestrator") {
      const orchestrator = await askAgent(
        deps,
        "Which agent plans and delegates?",
        draft.orchestrator,
      );
      if (orchestrator !== undefined) update({ orchestrator });
    } else if (section === "concurrency") {
      const maxConcurrency = await askCount(
        deps,
        "How many agents may run at once?",
        draft.maxConcurrency,
        8,
      );
      if (maxConcurrency !== undefined) update({ maxConcurrency });
    } else if (section === "parallel") {
      const answer = await ask(
        deps,
        "May independent tasks run side by side?",
        [
          { value: "yes", label: "yes — run them in parallel" },
          { value: "no", label: "no — one task at a time" },
        ],
        draft.parallelizeIndependentTasks ? "yes" : "no",
      );
      if (answer !== undefined) {
        update({ parallelizeIndependentTasks: answer === "yes" });
      }
    } else if (section === "attempts") {
      const defaultMaxAttempts = await askCount(
        deps,
        "How many attempts does a task get?",
        draft.defaultMaxAttempts,
        5,
      );
      if (defaultMaxAttempts !== undefined) update({ defaultMaxAttempts });
    } else if (section === "routing") {
      const routing = await editRuleList<RoutingRule>(
        deps,
        "Routing rules — which agent handles which work",
        draft.routing,
        summarizeRouting,
        () => ({
          id: `route-${draft.routing.length + 1}`,
          taskTypes: [],
          riskCategories: [],
          complexity: [],
          agent: fallbackAgent,
          strength: "hard",
          weight: 1,
        }),
        editRoutingRule,
      );
      if (routing !== undefined) update({ routing: [...routing] });
    } else if (section === "review") {
      const review = await editRuleList<ReviewRule>(
        deps,
        "Review rules — when a second agent has to look",
        draft.review,
        summarizeReview,
        () => ({
          id: `review-${draft.review.length + 1}`,
          riskCategories: [],
          reviewer: fallbackAgent,
          blocking: true,
          strength: "hard",
        }),
        editReviewRule,
      );
      if (review !== undefined) update({ review: [...review] });
    } else if (section === "escalation") {
      const escalation = await editRuleList<EscalationRule>(
        deps,
        "Escalation rules — where stuck work goes next",
        draft.escalation,
        summarizeEscalation,
        () => ({
          id: `escalate-${draft.escalation.length + 1}`,
          fromAgent: fallbackAgent,
          toAgent: fallbackAgent,
          afterFailures: 2,
        }),
        editEscalationRule,
      );
      if (escalation !== undefined) update({ escalation: [...escalation] });
    }
  }
}

// --- The terminal it actually runs on ----------------------------------------

/**
 * A {@link PolicyEditPrompt} backed by the real pickers.
 *
 * `suspend` is for callers that already own a longer-lived readline — the
 * REPL's `/policy` — and hands the terminal to each question and takes it
 * back afterwards, the same arrangement `ttyWizardPrompt` has with `/config`.
 */
export function ttyPolicyEditPrompt(
  io?: SelectPromptIo,
  suspend?: Suspend,
): PolicyEditPrompt {
  const target: SelectPromptIo = io ?? {
    input: process.stdin,
    output: process.stdout,
  };
  const run: Suspend = suspend ?? ((fn) => fn());
  return {
    select: (options) => run(() => runSelectPrompt(target, options)),
    text: (options) => run(() => runTextPrompt(target, options)),
  };
}
