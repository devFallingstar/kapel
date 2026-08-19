import type {
  ModelDefinition,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ToolDefinition,
} from "@agent/ai";
import { z } from "zod";
import {
  EscalationRuleSchema,
  type OrchestrationPolicy,
  type PolicyCompileResult,
  type PolicyCompiler,
  PolicySchema,
  ReviewRuleSchema,
  RoutingRuleSchema,
} from "./schema.js";

/** Name of the single tool the compiler forces the model to call. */
export const EMIT_POLICY_TOOL_NAME = "emit_policy";

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The model-facing mirror of {@link PolicySchema}.
 *
 * `PolicySchema` leans on `.default(...)` for most fields, which makes them
 * *optional inputs*; that is exactly what we want the model to see, so the
 * JSON Schema is emitted with `io: "input"` and only the fields that carry no
 * sensible default (`version`, `orchestrator`, and each rule's identity) are
 * required. Everything that survives this schema is handed to
 * `PolicySchema.parse`, which re-applies the real defaults.
 */
const PolicyDraftSchema = z.object({
  version: z.literal(1).describe("IR version. Always 1."),
  orchestrator: z
    .string()
    .describe(
      "Name of the agent that plans and delegates. Must be one of the known agents.",
    ),
  maxConcurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum number of agents allowed to run at the same time. Defaults to 4.",
    ),
  parallelizeIndependentTasks: z
    .boolean()
    .optional()
    .describe(
      "Whether tasks with no dependency on each other may run concurrently. Defaults to true.",
    ),
  routing: z
    .array(RoutingRuleSchema)
    .optional()
    .describe("Rules that pick which agent handles a task."),
  review: z
    .array(ReviewRuleSchema)
    .optional()
    .describe("Rules that require a second agent to review work."),
  escalation: z
    .array(EscalationRuleSchema)
    .optional()
    .describe(
      "Rules that hand a stuck or low-confidence task to another agent.",
    ),
  defaultMaxAttempts: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "How many times an agent may attempt a task before the run gives up or escalates. Defaults to 2.",
    ),
});

const CompilerOutputSchema = z.object({
  policy: PolicyDraftSchema,
  warnings: z
    .array(z.string())
    .default([])
    .describe(
      "Judgement calls and lossy simplifications made while compiling. Empty array if none.",
    ),
  ambiguities: z
    .array(z.string())
    .default([])
    .describe(
      "Source phrases that could not be mapped cleanly, each quoting the phrase and saying why. Empty array if none.",
    ),
});

/**
 * JSON Schema for the tool input: zod's `io: "input"` view, minus the
 * `$schema` key (providers reject unknown top-level keywords in tool
 * schemas), with the top-level `required` set explicitly so the model always
 * reports `warnings` and `ambiguities` even when they are empty.
 *
 * Exported for the same reason {@link buildPolicyCompilerSystemPrompt} is: a
 * delegating CLI has no tool definition to carry this schema, so it has to
 * spell it out in the prompt — and it must spell out *this* schema, not a
 * hand-written approximation of it.
 */
export function buildPolicyToolInputSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(CompilerOutputSchema, {
    io: "input",
  }) as Record<string, unknown>;
  const schema: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(generated)) {
    if (key !== "$schema") schema[key] = value;
  }
  schema.required = ["policy", "warnings", "ambiguities"];
  return schema;
}

/** The tool definition handed to the provider (stable across compilations). */
export const emitPolicyTool: ToolDefinition = {
  name: EMIT_POLICY_TOOL_NAME,
  description:
    "Emit the compiled orchestration policy IR, plus any warnings and ambiguities.",
  inputSchema: buildPolicyToolInputSchema(),
};

const IR_REFERENCE = `IR semantics, field by field:
- version: always 1.
- orchestrator: the agent that plans work and delegates it.
- maxConcurrency: integer cap on simultaneously running agents. "at most four workers concurrently" -> maxConcurrency 4. "one thing at a time" -> maxConcurrency 1.
- parallelizeIndependentTasks: true when independent tasks may run side by side; false when the policy demands sequential execution.
- defaultMaxAttempts: total attempts an agent gets at a task before giving up. "retry once then escalate" -> defaultMaxAttempts 2 plus an escalation rule.
- routing[]: which agent handles which work.
  - id: short stable kebab-case identifier, unique within the policy.
  - taskTypes: free-form kinds of work the rule matches ("test", "refactor", "docs"). Empty means any task type.
  - riskCategories: risk areas the rule matches ("auth", "payments", "migrations"). Empty means any risk category.
  - complexity: subset of trivial | normal | complex | architectural. Empty means any complexity.
  - agent: the agent the matched work is routed to.
  - strength: "hard" for a requirement ("must", "always", "never"), "preference" for a leaning ("prefer", "usually", "ideally").
  - weight: 0..1 tie-breaker among preferences; use 1 unless the source ranks options.
- review[]: when work must be reviewed by another agent.
  - id, riskCategories, minimumComplexity (trivial | normal | complex | architectural), reviewer.
  - blocking: true when work cannot land until the review passes. "X requires blocking review" -> blocking true, strength "hard".
  - strength: "hard" for a requirement, "preference" otherwise.
- escalation[]: handing a task from one agent to another.
  - id, fromAgent, toAgent.
  - afterFailures: positive integer count of failed attempts that triggers the hand-off.
  - confidenceBelow: 0..1 threshold; the hand-off triggers when confidence drops under it.`;

/**
 * The compiler brief: everything the model needs to turn `orchestration.md`
 * into the policy IR.
 *
 * Exported because it is not specific to *how* the IR comes back. The native
 * {@link LlmPolicyCompiler} forces an `emit_policy` tool call; the delegated
 * compiler in `@agent/coding-agent` asks a coding CLI for the same object as
 * raw JSON. Both must brief the model identically or the two paths would
 * quietly compile the same policy differently, so there is one function and
 * both call it.
 */
export function buildPolicyCompilerSystemPrompt(
  knownAgents: readonly string[],
): string {
  const agents =
    knownAgents.length === 0 ? "(none declared)" : knownAgents.join(", ");
  return `You are the policy compiler for a multi-agent coding runtime. The user gives you an orchestration policy written in natural language (the contents of .agent/orchestration.md). Convert it into the structured policy IR exactly as written — you are a translator, not an author.

Rules:
- Call the ${EMIT_POLICY_TOOL_NAME} tool exactly once. Never answer with prose.
- Known agent names are: ${agents}. Never invent an agent that is not in this list; if the policy names something else, leave it out of the IR and record it under ambiguities.
- Transcribe only what the source says. Do not add rules the source does not state, and do not drop rules it does state.
- Any rule you cannot map cleanly onto the IR goes in ambiguities: quote the source phrase and say why it does not fit.
- Any judgement call or lossy simplification you did make goes in warnings.
- version is always 1.
- Omit optional fields rather than guessing; omitted fields fall back to documented defaults.

${IR_REFERENCE}`;
}

export interface PolicyCompileIssue {
  readonly path: string;
  readonly message: string;
}

export interface PolicyCompileErrorInit {
  readonly message: string;
  readonly attempts: number;
  readonly lastIssues?: readonly PolicyCompileIssue[];
}

/** Thrown when the model never produced a valid policy within `maxAttempts`. */
export class PolicyCompileError extends Error {
  readonly attempts: number;
  readonly lastIssues: readonly PolicyCompileIssue[] | undefined;

  constructor(init: PolicyCompileErrorInit) {
    super(init.message);
    this.name = "PolicyCompileError";
    this.attempts = init.attempts;
    this.lastIssues = init.lastIssues;
  }
}

export interface LlmPolicyCompilerOptions {
  readonly provider: ModelProvider;
  readonly model: ModelDefinition;
  /** Agent names the policy is allowed to reference. */
  readonly knownAgents: readonly string[];
  /** Total attempts, including the first. Defaults to 3. */
  readonly maxAttempts?: number;
  readonly maxOutputTokens?: number;
}

function toIssues(error: z.ZodError): readonly PolicyCompileIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    message: issue.message,
  }));
}

function formatIssues(issues: readonly PolicyCompileIssue[]): string {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}

/** A validated compiler output, or the issues that rejected the draft. */
export type PolicyDraftOutcome =
  | { readonly result: PolicyCompileResult }
  | { readonly issues: readonly PolicyCompileIssue[] };

/**
 * Validates one raw compiler output — the `emit_policy` tool input on the
 * native path, the parsed JSON reply on the delegated one — into the
 * {@link PolicyCompileResult} the CLI writes to the lockfile.
 *
 * Exported so the delegated compiler reuses this check rather than
 * reimplementing it: the draft schema is the only thing standing between "the
 * model said something" and a policy lock, and two copies of it would drift.
 * Everything that survives {@link CompilerOutputSchema} is re-parsed by
 * `PolicySchema`, which re-applies the IR's real defaults.
 */
export function parsePolicyDraft(input: unknown): PolicyDraftOutcome {
  const parsed = CompilerOutputSchema.safeParse(input);
  if (!parsed.success) return { issues: toIssues(parsed.error) };
  const policy: OrchestrationPolicy = PolicySchema.parse(parsed.data.policy);
  return {
    result: {
      policy,
      warnings: parsed.data.warnings,
      ambiguities: parsed.data.ambiguities,
    },
  };
}

interface Attempt {
  readonly call: { readonly id: string; readonly input: unknown } | undefined;
  readonly text: string;
}

/**
 * Compiles `.agent/orchestration.md` into the typed policy IR by forcing an
 * LLM to fill in a single `emit_policy` tool call, then validating the result
 * against the IR schema and asking for corrections when it does not fit.
 */
export class LlmPolicyCompiler implements PolicyCompiler {
  readonly #options: LlmPolicyCompilerOptions;

  constructor(options: LlmPolicyCompilerOptions) {
    this.#options = options;
  }

  async compile(
    markdown: string,
    signal?: AbortSignal,
  ): Promise<PolicyCompileResult> {
    const maxAttempts = Math.max(
      1,
      this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    );
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: buildPolicyCompilerSystemPrompt(this.#options.knownAgents),
      },
      {
        role: "user",
        content: `Compile this orchestration policy:\n\n${markdown}`,
      },
    ];

    let lastIssues: readonly PolicyCompileIssue[] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const { call, text } = await this.#runAttempt(messages, signal);
      signal?.throwIfAborted();

      if (call === undefined) {
        lastIssues = [
          {
            path: "(root)",
            message: `no ${EMIT_POLICY_TOOL_NAME} tool call in the response`,
          },
        ];
        if (attempt === maxAttempts) break;
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content: `You did not call ${EMIT_POLICY_TOOL_NAME}. Reply with exactly one ${EMIT_POLICY_TOOL_NAME} tool call carrying the compiled policy, and no prose.`,
        });
        continue;
      }

      const outcome = parsePolicyDraft(call.input);
      if ("result" in outcome) return outcome.result;

      lastIssues = outcome.issues;
      if (attempt === maxAttempts) break;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: call.id, name: EMIT_POLICY_TOOL_NAME, input: call.input },
        ],
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        isError: true,
        content: `That ${EMIT_POLICY_TOOL_NAME} call did not match the policy schema:\n${formatIssues(
          lastIssues,
        )}\n\nCall ${EMIT_POLICY_TOOL_NAME} again with a corrected policy that fixes every issue above. Do not reply with prose.`,
      });
    }

    throw new PolicyCompileError({
      message: `Failed to compile the orchestration policy after ${maxAttempts} attempt(s).${
        lastIssues === undefined ? "" : `\n${formatIssues(lastIssues)}`
      }`,
      attempts: maxAttempts,
      ...(lastIssues === undefined ? {} : { lastIssues }),
    });
  }

  async #runAttempt(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<Attempt> {
    const { maxOutputTokens } = this.#options;
    const request: ModelRequest = {
      model: this.#options.model,
      messages: [...messages],
      tools: [emitPolicyTool],
      toolChoice: { type: "tool", name: EMIT_POLICY_TOOL_NAME },
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };

    let call: { id: string; input: unknown } | undefined;
    let text = "";
    for await (const event of this.#options.provider.stream(request, signal)) {
      if (event.type === "text.delta") {
        text += event.text;
        continue;
      }
      if (
        event.type === "tool.call" &&
        event.name === EMIT_POLICY_TOOL_NAME &&
        call === undefined
      ) {
        call = { id: event.id, input: event.input };
      }
    }
    return { call, text };
  }
}
