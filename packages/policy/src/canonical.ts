import { joinList, splitJoinedList } from "./phrase.js";
import type {
  Complexity,
  EscalationRule,
  OrchestrationPolicy,
  ReviewRule,
  RoutingRule,
} from "./schema.js";
import { ComplexitySchema, PolicySchema } from "./schema.js";

/**
 * The canonical form of `.agent/orchestration.md`: a policy source that a
 * *model* is not needed to read.
 *
 * The IR this file renders and parses is small and closed — four scalars and
 * three rule arrays — and `describePolicy` already proved the IR can be
 * turned into English without losing a field. What was missing was the way
 * back. With both directions in place the compile stops being a model call:
 * a policy written in this form is parsed, and only prose kapel cannot
 * already express falls through to {@link LlmPolicyCompiler}.
 *
 * Three rules keep that trustworthy:
 *
 * 1. **Opt-in by marker.** Nothing is parsed unless the source carries
 *    {@link CANONICAL_POLICY_MARKER}. A hand-written policy is never guessed
 *    at, so the deterministic path can only ever apply to text kapel itself
 *    wrote (or that someone deliberately wrote in this form).
 * 2. **All or nothing.** One unrecognized line fails the whole parse, with
 *    its line number. The caller then compiles with the model exactly as
 *    before. The parser never drops a sentence it did not understand — the
 *    failure mode this design exists to avoid is a policy that silently
 *    means less than it says.
 * 3. **Round-trip tested.** `parse(render(p))` deep-equals `p` for every
 *    policy the schema admits (see `test/canonical.test.ts`), which is what
 *    lets `kapel policy edit` write this file from an edited IR and know the
 *    lock it writes beside it still describes it.
 */

/** The comment that marks a policy source as machine-readable. */
export const CANONICAL_POLICY_MARKER = "<!-- kapel:policy v1 -->";

/** Matches the marker line, allowing extra prose inside the comment. */
const MARKER_PATTERN = /^<!--\s*kapel:policy\s+v1\b.*?-->$/;

/** Values rendered inside backticks may not contain one, or a line break. */
const UNQUOTABLE = /[`\r\n]/;

export class PolicyRenderError extends Error {
  readonly field: string;
  readonly value: string;

  constructor(field: string, value: string) {
    super(
      `Cannot write ${field} to the canonical policy form: ${JSON.stringify(
        value,
      )} contains a backtick or a line break.`,
    );
    this.name = "PolicyRenderError";
    this.field = field;
    this.value = value;
  }
}

/** Whether {@link parsePolicyMarkdown} will even try to read this source. */
export function isCanonicalPolicySource(markdown: string): boolean {
  return markdown
    .split(/\r\n|\r|\n/)
    .some((line) => MARKER_PATTERN.test(line.trim()));
}

// --- Rendering --------------------------------------------------------------

function quote(field: string, value: string): string {
  if (value === "" || UNQUOTABLE.test(value)) {
    throw new PolicyRenderError(field, value);
  }
  return `\`${value}\``;
}

function quoteList(field: string, values: readonly string[]): string {
  return joinList(values.map((value) => quote(field, value)));
}

/**
 * "tasks", narrowed by whatever the rule matches on — the canonical twin of
 * `explain.ts`'s `matchClause`, with every free-form value backticked so the
 * list separators stay unambiguous no matter what a task type is called.
 */
function renderClause(
  field: string,
  rule: {
    readonly taskTypes?: readonly string[];
    readonly riskCategories?: readonly string[];
    readonly complexity?: readonly Complexity[];
  },
): string {
  const taskTypes = rule.taskTypes ?? [];
  const riskCategories = rule.riskCategories ?? [];
  const complexity = rule.complexity ?? [];

  let clause =
    taskTypes.length > 0
      ? `${quoteList(`${field} task type`, taskTypes)} tasks`
      : "tasks";
  if (riskCategories.length > 0) {
    clause += ` touching ${quoteList(`${field} risk category`, riskCategories)}`;
  }
  if (complexity.length > 0) {
    clause += ` of ${joinList([...complexity])} complexity`;
  }
  return clause;
}

/** Shortest round-trippable decimal for a 0..1 weight or threshold. */
function renderNumber(value: number): string {
  return String(value);
}

function renderRouting(rule: RoutingRule): string {
  const verb = rule.strength === "hard" ? "always route" : "prefer to route";
  const weight =
    rule.weight === 1 ? "" : ` (weight ${renderNumber(rule.weight)})`;
  return `- ${quote("routing id", rule.id)}: ${verb} ${renderClause(
    "routing",
    rule,
  )} to ${quote("routing agent", rule.agent)}${weight}.`;
}

function renderReview(rule: ReviewRule): string {
  const floor =
    rule.minimumComplexity === undefined
      ? ""
      : ` at ${rule.minimumComplexity} complexity or above`;
  const blocking = rule.blocking ? "blocking" : "advisory";
  const strength = rule.strength === "hard" ? "required" : "preferred";
  return `- ${quote("review id", rule.id)}: ${quote(
    "review reviewer",
    rule.reviewer,
  )} reviews ${renderClause("review", rule)}${floor}; ${blocking}, ${strength}.`;
}

function renderEscalation(rule: EscalationRule): string {
  const triggers: string[] = [];
  if (rule.afterFailures !== undefined) {
    triggers.push(
      `after ${rule.afterFailures} failed attempt${
        rule.afterFailures === 1 ? "" : "s"
      }`,
    );
  }
  if (rule.confidenceBelow !== undefined) {
    triggers.push(
      `when confidence drops below ${renderNumber(rule.confidenceBelow)}`,
    );
  }
  const when = triggers.length === 0 ? "on request" : triggers.join(" or ");
  return `- ${quote("escalation id", rule.id)}: hand off from ${quote(
    "escalation source",
    rule.fromAgent,
  )} to ${quote("escalation target", rule.toAgent)} ${when}.`;
}

const EMPTY_SECTION = "None.";

function renderSection<T>(
  title: string,
  rules: readonly T[],
  render: (rule: T) => string,
): readonly string[] {
  return [
    `## ${title}`,
    "",
    ...(rules.length === 0 ? [EMPTY_SECTION] : rules.map(render)),
    "",
  ];
}

/**
 * Writes a policy as the `.agent/orchestration.md` that {@link
 * parsePolicyMarkdown} reads back unchanged.
 *
 * Throws {@link PolicyRenderError} when a name cannot be written — a value
 * carrying a backtick or a newline would break the quoting the parser relies
 * on, and a file that cannot be read back is worse than a refusal to write
 * one. Names come from `.agent/agents/*.md` filenames and from the editor's
 * own validation, so this is a guard rather than a path anyone travels.
 */
export function renderPolicyMarkdown(policy: OrchestrationPolicy): string {
  const lines: string[] = [
    "# Orchestration Policy",
    "",
    CANONICAL_POLICY_MARKER,
    "",
    "This file is kapel's canonical policy form: `kapel policy compile` reads",
    "it without calling a model. Edit it here or through `kapel policy edit`.",
    "Rewriting it in your own prose is fine too — kapel then falls back to",
    "compiling it with a model, which is what the marker line above turns off.",
    "",
    "## Orchestrator",
    "",
    `Use ${quote("orchestrator", policy.orchestrator)} as the main orchestrator.`,
    "",
    "## Execution",
    "",
    `- Run at most ${policy.maxConcurrency} agent${
      policy.maxConcurrency === 1 ? "" : "s"
    } at a time.`,
    `- Independent tasks ${
      policy.parallelizeIndependentTasks
        ? "may run in parallel"
        : "run one at a time"
    }.`,
    `- Give each task ${policy.defaultMaxAttempts} attempt${
      policy.defaultMaxAttempts === 1 ? "" : "s"
    } before giving up.`,
    "",
    ...renderSection("Routing", policy.routing, renderRouting),
    ...renderSection("Review", policy.review, renderReview),
    ...renderSection("Escalation", policy.escalation, renderEscalation),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

// --- Parsing ----------------------------------------------------------------

/** Why a source could not be read deterministically. */
export interface CanonicalParseFailure {
  /**
   * `not-canonical` — the source carries no {@link CANONICAL_POLICY_MARKER},
   * so it is ordinary prose and was never a candidate. Expected, not an
   * error: the caller compiles it with a model.
   *
   * `unreadable` — it claims to be canonical but does not parse. Worth
   * reporting, since it usually means a hand edit slipped out of the form and
   * is about to cost a model call the file was written to avoid.
   */
  readonly reason: "not-canonical" | "unreadable";
  readonly message: string;
  /** 1-based line the parse gave up on, when the failure has one. */
  readonly line?: number;
}

export type CanonicalParseOutcome =
  | { readonly policy: OrchestrationPolicy }
  | { readonly failure: CanonicalParseFailure };

class ParseError extends Error {
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(message);
    this.line = line;
  }
}

/** The sentinel that stands for "this optional tail is simply absent". */
const NO_CUT = -1;

/**
 * Every index at which `needle` occurs, rightmost first — the order the
 * grammar's optional tails have to be tried in, since the structural
 * separator is always the last one on the line.
 */
function occurrences(haystack: string, needle: string): readonly number[] {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.unshift(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/**
 * Reads a backtick-quoted list — `` `a`, `b` and `c` `` — left to right.
 *
 * Quoting is what makes this separator-proof: a task type called `a, b` is
 * still one item, because the scanner only accepts `, `/` and ` when a
 * backtick follows it. `undefined` means the text is not such a list.
 */
function parseQuotedList(text: string): readonly string[] | undefined {
  const items: string[] = [];
  let rest = text;
  for (;;) {
    const item = /^`([^`]+)`/.exec(rest);
    if (item === null) return undefined;
    items.push(item[1] ?? "");
    rest = rest.slice(item[0].length);
    if (rest === "") return items;
    const separator = /^(?:, | and )(?=`)/.exec(rest);
    if (separator === null) return undefined;
    rest = rest.slice(separator[0].length);
  }
}

interface ParsedClause {
  readonly taskTypes: readonly string[];
  readonly riskCategories: readonly string[];
  readonly complexity: readonly Complexity[];
}

function parseComplexityList(text: string): readonly Complexity[] | undefined {
  const items = splitJoinedList(text);
  if (items.length === 0) return undefined;
  const parsed: Complexity[] = [];
  for (const item of items) {
    const outcome = ComplexitySchema.safeParse(item);
    if (!outcome.success) return undefined;
    parsed.push(outcome.data);
  }
  return parsed;
}

/**
 * Reads the "which tasks" half of a rule: `tasks`, narrowed by any of a task
 * type list, a `touching` risk list and an `of … complexity` list.
 *
 * Each optional tail is tried at every position it could occupy, rightmost
 * first, and a position that does not leave a readable remainder is
 * abandoned. That backtracking is what lets a task type legitimately contain
 * the words this grammar also uses as separators — `` `migrating to a new
 * queue` tasks `` parses as one task type rather than as a mangled split.
 */
function parseClause(text: string): ParsedClause | undefined {
  for (const complexityCut of [...occurrences(text, " of "), NO_CUT]) {
    let head = text;
    let complexity: readonly Complexity[] = [];
    if (complexityCut >= 0) {
      if (!text.endsWith(" complexity")) continue;
      const inner = text.slice(
        complexityCut + " of ".length,
        text.length - " complexity".length,
      );
      const parsed = parseComplexityList(inner);
      if (parsed === undefined) continue;
      complexity = parsed;
      head = text.slice(0, complexityCut);
    }

    for (const touchingCut of [...occurrences(head, " touching "), NO_CUT]) {
      let front = head;
      let riskCategories: readonly string[] = [];
      if (touchingCut >= 0) {
        const parsed = parseQuotedList(
          head.slice(touchingCut + " touching ".length),
        );
        if (parsed === undefined) continue;
        riskCategories = parsed;
        front = head.slice(0, touchingCut);
      }

      if (front === "tasks") {
        return { taskTypes: [], riskCategories, complexity };
      }
      if (front.endsWith(" tasks")) {
        const taskTypes = parseQuotedList(
          front.slice(0, front.length - " tasks".length),
        );
        if (taskTypes !== undefined) {
          return { taskTypes, riskCategories, complexity };
        }
      }
    }
  }
  return undefined;
}

function parseInteger(text: string): number | undefined {
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

function parseFraction(text: string): number | undefined {
  return /^\d+(?:\.\d+)?$/.test(text) ? Number.parseFloat(text) : undefined;
}

function parseRouting(body: string, line: number): RoutingRule {
  const head = /^`([^`]+)`: (always route|prefer to route) (.*)$/.exec(body);
  if (head === null) throw new ParseError("not a routing rule", line);
  const id = head[1] ?? "";
  const strength = head[2] === "always route" ? "hard" : "preference";

  let rest = head[3] ?? "";
  let weight = 1;
  const weighted = / \(weight ([0-9.]+)\)$/.exec(rest);
  if (weighted !== null) {
    const parsed = parseFraction(weighted[1] ?? "");
    if (parsed === undefined) throw new ParseError("unreadable weight", line);
    weight = parsed;
    rest = rest.slice(0, rest.length - weighted[0].length);
  }

  // Rightmost first: the structural " to `agent`" is the last one, but an
  // earlier candidate inside a quoted name must not steal the match.
  for (const cut of occurrences(rest, " to `")) {
    const tail = rest.slice(cut + " to ".length);
    const agent = /^`([^`]+)`$/.exec(tail);
    if (agent === null) continue;
    const clause = parseClause(rest.slice(0, cut));
    if (clause === undefined) continue;
    return {
      id,
      taskTypes: [...clause.taskTypes],
      riskCategories: [...clause.riskCategories],
      complexity: [...clause.complexity],
      agent: agent[1] ?? "",
      strength,
      weight,
    };
  }
  throw new ParseError("unreadable routing rule", line);
}

const REVIEW_FLAGS: Readonly<
  Record<
    string,
    { readonly blocking: boolean; readonly strength: "hard" | "preference" }
  >
> = {
  "blocking, required": { blocking: true, strength: "hard" },
  "blocking, preferred": { blocking: true, strength: "preference" },
  "advisory, required": { blocking: false, strength: "hard" },
  "advisory, preferred": { blocking: false, strength: "preference" },
};

function parseReview(body: string, line: number): ReviewRule {
  const head = /^`([^`]+)`: `([^`]+)` reviews (.*)$/.exec(body);
  if (head === null) throw new ParseError("not a review rule", line);
  const id = head[1] ?? "";
  const reviewer = head[2] ?? "";
  const rest = head[3] ?? "";

  for (const cut of occurrences(rest, "; ")) {
    const flags = REVIEW_FLAGS[rest.slice(cut + "; ".length)];
    if (flags === undefined) continue;

    let clauseText = rest.slice(0, cut);
    let minimumComplexity: Complexity | undefined;
    const floor = / at (\S+) complexity or above$/.exec(clauseText);
    if (floor !== null) {
      const parsed = ComplexitySchema.safeParse(floor[1]);
      if (parsed.success) {
        minimumComplexity = parsed.data;
        clauseText = clauseText.slice(0, clauseText.length - floor[0].length);
      }
    }

    const clause = parseClause(clauseText);
    // A review rule has no task-type or complexity fields to hold, so a
    // clause carrying either is a rule this form cannot represent — not one
    // to silently narrow.
    if (
      clause === undefined ||
      clause.taskTypes.length > 0 ||
      clause.complexity.length > 0
    ) {
      continue;
    }
    return {
      id,
      riskCategories: [...clause.riskCategories],
      reviewer,
      blocking: flags.blocking,
      strength: flags.strength,
      ...(minimumComplexity === undefined ? {} : { minimumComplexity }),
    };
  }
  throw new ParseError("unreadable review rule", line);
}

function parseEscalation(body: string, line: number): EscalationRule {
  const head = /^`([^`]+)`: hand off from `([^`]+)` to `([^`]+)` (.*)$/.exec(
    body,
  );
  if (head === null) throw new ParseError("not an escalation rule", line);
  const trigger = head[4] ?? "";

  let afterFailures: number | undefined;
  let confidenceBelow: number | undefined;
  if (trigger !== "on request") {
    for (const part of trigger.split(" or ")) {
      const failures = /^after (\d+) failed attempts?$/.exec(part);
      if (failures !== null && afterFailures === undefined) {
        afterFailures = parseInteger(failures[1] ?? "");
        if (afterFailures !== undefined) continue;
      }
      const confidence = /^when confidence drops below ([0-9.]+)$/.exec(part);
      if (confidence !== null && confidenceBelow === undefined) {
        confidenceBelow = parseFraction(confidence[1] ?? "");
        if (confidenceBelow !== undefined) continue;
      }
      throw new ParseError("unreadable escalation trigger", line);
    }
  }

  return {
    id: head[1] ?? "",
    fromAgent: head[2] ?? "",
    toAgent: head[3] ?? "",
    ...(afterFailures === undefined ? {} : { afterFailures }),
    ...(confidenceBelow === undefined ? {} : { confidenceBelow }),
  };
}

/** One non-blank body line of a section, with the line number it came from. */
interface BodyLine {
  readonly text: string;
  readonly line: number;
}

const SECTION_TITLES = [
  "Orchestrator",
  "Execution",
  "Routing",
  "Review",
  "Escalation",
] as const;

type SectionTitle = (typeof SECTION_TITLES)[number];

function splitSections(
  markdown: string,
): ReadonlyMap<SectionTitle, BodyLine[]> {
  const lines = markdown.split(/\r\n|\r|\n/);
  const sections = new Map<SectionTitle, BodyLine[]>();
  let current: BodyLine[] | undefined;

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const text = raw.trimEnd();
    const heading = /^##\s+(.+)$/.exec(text);
    if (heading !== null) {
      const title = (heading[1] ?? "").trim();
      if (!SECTION_TITLES.includes(title as SectionTitle)) {
        throw new ParseError(`unknown section "${title}"`, line);
      }
      if (sections.has(title as SectionTitle)) {
        throw new ParseError(`duplicate section "${title}"`, line);
      }
      current = [];
      sections.set(title as SectionTitle, current);
      continue;
    }
    // Everything above the first `## ` heading is the file's own preamble —
    // the title, the marker, whatever the author wants to say about it. Once
    // a section has started, an unrecognized line is a parse failure, which
    // is what keeps a sentence someone added from being quietly ignored.
    if (current === undefined || text.trim() === "") continue;
    current.push({ text: text.trim(), line });
  }

  for (const title of SECTION_TITLES) {
    if (!sections.has(title)) {
      throw new ParseError(`missing "## ${title}" section`);
    }
  }
  return sections;
}

function bodyOf(
  sections: ReadonlyMap<SectionTitle, BodyLine[]>,
  title: SectionTitle,
): readonly BodyLine[] {
  return sections.get(title) ?? [];
}

function readOrchestrator(body: readonly BodyLine[]): string {
  const only = body[0];
  if (body.length !== 1 || only === undefined) {
    throw new ParseError(
      "the Orchestrator section takes exactly one sentence",
      body[1]?.line,
    );
  }
  const match = /^Use `([^`]+)` as the main orchestrator\.$/.exec(only.text);
  if (match === null) {
    throw new ParseError("unreadable orchestrator sentence", only.line);
  }
  return match[1] ?? "";
}

interface ExecutionSettings {
  readonly maxConcurrency: number;
  readonly parallelizeIndependentTasks: boolean;
  readonly defaultMaxAttempts: number;
}

function readExecution(body: readonly BodyLine[]): ExecutionSettings {
  let maxConcurrency: number | undefined;
  let parallelize: boolean | undefined;
  let attempts: number | undefined;

  for (const { text, line } of body) {
    const concurrency = /^- Run at most (\d+) agents? at a time\.$/.exec(text);
    if (concurrency !== null && maxConcurrency === undefined) {
      maxConcurrency = parseInteger(concurrency[1] ?? "");
      if (maxConcurrency !== undefined) continue;
    }
    const parallel =
      /^- Independent tasks (may run in parallel|run one at a time)\.$/.exec(
        text,
      );
    if (parallel !== null && parallelize === undefined) {
      parallelize = parallel[1] === "may run in parallel";
      continue;
    }
    const attemptLine =
      /^- Give each task (\d+) attempts? before giving up\.$/.exec(text);
    if (attemptLine !== null && attempts === undefined) {
      attempts = parseInteger(attemptLine[1] ?? "");
      if (attempts !== undefined) continue;
    }
    throw new ParseError("unreadable execution setting", line);
  }

  if (
    maxConcurrency === undefined ||
    parallelize === undefined ||
    attempts === undefined
  ) {
    throw new ParseError(
      "the Execution section must state concurrency, parallelism and attempts",
      body[0]?.line,
    );
  }
  return {
    maxConcurrency,
    parallelizeIndependentTasks: parallelize,
    defaultMaxAttempts: attempts,
  };
}

/** Reads a rule section: `None.` on its own, or one `- ` bullet per rule. */
function readRules<T>(
  body: readonly BodyLine[],
  read: (bullet: string, line: number) => T,
): readonly T[] {
  const only = body[0];
  if (body.length === 1 && only?.text === EMPTY_SECTION) return [];

  return body.map(({ text, line }) => {
    if (text === EMPTY_SECTION) {
      throw new ParseError(`"${EMPTY_SECTION}" cannot sit beside rules`, line);
    }
    if (!text.startsWith("- ") || !text.endsWith(".")) {
      throw new ParseError("not a rule bullet", line);
    }
    return read(text.slice("- ".length, text.length - 1), line);
  });
}

/**
 * Reads a canonical policy source into the IR, with no model involved.
 *
 * A source with no {@link CANONICAL_POLICY_MARKER} is declined rather than
 * guessed at (`reason: "not-canonical"`); one that carries the marker but
 * does not parse fails with the line that stopped it. Both outcomes mean the
 * same thing to the caller — compile it with a model — but only the second is
 * worth telling the user about.
 */
export function parsePolicyMarkdown(markdown: string): CanonicalParseOutcome {
  if (!isCanonicalPolicySource(markdown)) {
    return {
      failure: {
        reason: "not-canonical",
        message: `no ${CANONICAL_POLICY_MARKER} marker — this policy is prose`,
      },
    };
  }

  try {
    const sections = splitSections(markdown);
    const draft = {
      version: 1 as const,
      orchestrator: readOrchestrator(bodyOf(sections, "Orchestrator")),
      ...readExecution(bodyOf(sections, "Execution")),
      routing: readRules(bodyOf(sections, "Routing"), parseRouting),
      review: readRules(bodyOf(sections, "Review"), parseReview),
      escalation: readRules(bodyOf(sections, "Escalation"), parseEscalation),
    };
    // The schema is the last word on ranges (a positive concurrency, a weight
    // inside 0..1): the grammar above proves the shape, not the values.
    const parsed = PolicySchema.safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ParseError(
        `${issue?.path.join(".") ?? "(root)"}: ${issue?.message ?? "invalid"}`,
      );
    }
    return { policy: parsed.data };
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        failure: {
          reason: "unreadable",
          message: error.message,
          ...(error.line === undefined ? {} : { line: error.line }),
        },
      };
    }
    throw error;
  }
}
