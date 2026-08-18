import type { PermissionDecision } from "@agent/core";

export interface PermissionRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly agent: string;
}

export interface PermissionPrompter {
  ask(request: PermissionRequest): Promise<boolean>;
}

export interface PermissionEngineOptions {
  readonly defaultDecision?: PermissionDecision;
  readonly prompter?: PermissionPrompter;
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

/**
 * Resolves `allow | ask | deny` decisions for tool invocations.
 *
 * Rules are matched by exact tool name; anything unmatched falls back to
 * `options.defaultDecision` (itself defaulting to `"ask"`).
 */
export class PermissionEngine {
  readonly #rules: Readonly<Record<string, PermissionDecision>>;
  readonly #defaultDecision: PermissionDecision;
  readonly #prompter: PermissionPrompter | undefined;

  constructor(
    rules: Readonly<Record<string, PermissionDecision>>,
    options: PermissionEngineOptions = {},
  ) {
    this.#rules = { ...rules };
    this.#defaultDecision = options.defaultDecision ?? "ask";
    this.#prompter = options.prompter;
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
