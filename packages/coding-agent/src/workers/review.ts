import type { Tool, ToolContext } from "@agent/core";
import type { TaskResult } from "@agent/orchestration";
import { z } from "zod";
import type { DelegatedIssue } from "../planning/delegated-cli.js";
import {
  extractJsonObject,
  issuesFromZodError,
} from "../planning/delegated-cli.js";
import { toInputSchema } from "../tools/json-schema.js";

/** The tool a review task must call to state its decision. */
export const REVIEW_VERDICT_TOOL_NAME = "submit_review_verdict";

/**
 * Confidence attached to a rejection.
 *
 * High on purpose, and higher than an approval's: a rejected review is a
 * *successful* review — the reviewer ran, looked, and decided. The low
 * confidences elsewhere describe a worker that could not finish; this one
 * describes a finding the orchestrator should trust.
 */
const REJECTED_CONFIDENCE = 0.9;

/** Confidence attached to a review that never produced a verdict. */
const NO_VERDICT_CONFIDENCE = 0.1;

/** Summary reported when a review task finished without deciding anything. */
export const NO_VERDICT_SUMMARY =
  "review completed without submitting a verdict";

const IssueSchema = z
  .object({
    severity: z
      .enum(["blocking", "advisory"])
      .describe(
        "`blocking` means the change must not ship as-is; `advisory` is a suggestion.",
      ),
    description: z
      .string()
      .min(1)
      .describe("What is wrong, specific enough to act on."),
  })
  .strict();

/**
 * The verdict's shape, in one place.
 *
 * It is the tool's input schema on the native loop and the shape a delegated
 * backend has to reply with (see `reviewSection` in `./briefing.ts`, which
 * spells the same object out in prose because a CLI cannot be handed a tool
 * definition). {@link parseReviewVerdictReply} validates the reply against
 * *this* schema, so the two paths cannot drift into accepting different things.
 */
const InputSchema = z
  .object({
    approved: z
      .boolean()
      .describe(
        "true only when the change is acceptable as it stands. Any blocking issue means false.",
      ),
    summary: z
      .string()
      .min(1)
      .describe("One short paragraph explaining the decision."),
    issues: z
      .array(IssueSchema)
      .default([])
      .describe("Every problem found, blocking ones first."),
  })
  .strict();

export type ReviewVerdictInput = z.infer<typeof InputSchema>;

export interface ReviewIssue {
  readonly severity: "blocking" | "advisory";
  readonly description: string;
}

/** A review task's structured decision. */
export interface ReviewVerdict {
  readonly approved: boolean;
  readonly summary: string;
  readonly issues: readonly ReviewIssue[];
}

export interface ReviewVerdictOutput {
  readonly recorded: true;
}

/**
 * The one tool a reviewer has that is not read-only: it records a decision.
 *
 * State lives on the instance, so a fresh tool is created per review task and
 * the executor reads the verdict back off it once the loop has finished. The
 * *last* submission wins — a model that reconsiders after reading one more file
 * should be able to, and silently keeping the first answer would be worse than
 * either behaviour.
 */
export class ReviewVerdictTool
  implements Tool<ReviewVerdictInput, ReviewVerdictOutput>
{
  readonly name = REVIEW_VERDICT_TOOL_NAME;
  readonly description =
    "Submits the review decision for this task. Call this exactly once, after inspecting the " +
    "changes: `approved` is false whenever any blocking issue exists. A review that finishes " +
    "without calling this tool is treated as a failure.";
  readonly inputSchema = toInputSchema(InputSchema);

  #verdict: ReviewVerdict | undefined;

  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  /** The last verdict submitted, or `undefined` when none ever was. */
  verdict(): ReviewVerdict | undefined {
    return this.#verdict;
  }

  async execute(
    rawInput: unknown,
    _context: ToolContext,
  ): Promise<ReviewVerdictOutput> {
    this.#verdict = toVerdict(InputSchema.parse(rawInput));
    return { recorded: true };
  }
}

/** What {@link parseReviewVerdictReply} made of a delegated reviewer's reply. */
export interface ReviewVerdictParse {
  /** The verdict, or `undefined` when the reply did not carry a usable one. */
  readonly verdict?: ReviewVerdict;
  /** Why it did not, empty when it did. */
  readonly issues: readonly DelegatedIssue[];
}

function toVerdict(input: ReviewVerdictInput): ReviewVerdict {
  return {
    approved: input.approved,
    summary: input.summary,
    issues: input.issues.map((issue) => ({
      severity: issue.severity,
      description: issue.description,
    })),
  };
}

/**
 * Recovers a review verdict from a delegated backend's final reply.
 *
 * A CLI backend has no verdict tool to call — Claude Code and Codex run their
 * own loops with their own toolsets — so the contract the briefing states there
 * is "end your reply with this JSON object" instead. Parsing is deliberately
 * forgiving about *packaging* and strict about *content*: {@link
 * extractJsonObject} digs the object out of fences and surrounding prose (the
 * same treatment a delegated plan gets), and the result is then validated
 * against the very schema the native tool enforces. Anything that does not hold
 * up comes back as `issues` with no verdict, which the executor turns into the
 * same failure a native review that never called the tool produces.
 */
export function parseReviewVerdictReply(
  reply: string | undefined,
): ReviewVerdictParse {
  const json = reply === undefined ? undefined : extractJsonObject(reply);
  if (json === undefined) {
    return {
      issues: [
        { path: "(root)", message: "no JSON object found in the reply" },
      ],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    return {
      issues: [
        {
          path: "(root)",
          message: `reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const parsed = InputSchema.safeParse(data);
  if (!parsed.success) return { issues: issuesFromZodError(parsed.error) };
  return { verdict: toVerdict(parsed.data), issues: [] };
}

/**
 * The verdict a delegated run stated, if any.
 *
 * The agent's own last message is what the contract binds, so `output` is read
 * first; `summary` is the fallback because a successful CLI run repeats the
 * final message there, and a failed one at least carries the diagnostic (which
 * will not parse, which is the right answer for a run that died).
 */
export function reviewVerdictFromRun(run: {
  readonly summary: string;
  readonly output?: string;
}): ReviewVerdict | undefined {
  return parseReviewVerdictReply(run.output ?? run.summary).verdict;
}

function describeIssue(issue: ReviewIssue): string {
  return `${issue.severity}: ${issue.description}`;
}

/**
 * Folds a review's verdict into the task result the scheduler will act on.
 *
 * This is where a review becomes *blocking*. The scheduler already fails a
 * task's dependents when the task fails and exits the run non-zero, so a
 * rejection only has to be expressed as a `failed` result for a risky task to
 * be unable to complete without its injected review approving it. Nothing else
 * in the runtime needs to learn about reviews.
 *
 * Three cases:
 *
 * - **approved** — the reviewer's own summary replaces the loop's prose, and
 *   its issues are carried as `unresolvedIssues`. Blocking issues are kept too,
 *   even though an approval that names one is self-contradictory: honouring the
 *   decision while dropping the finding on the floor would be the worst of both.
 * - **rejected** — `failed`, with the reason up front. Confidence is high: the
 *   review itself worked fine.
 * - **no verdict** — `failed`. A review that does not decide must not pass;
 *   otherwise an agent that runs out of iterations, or ignores the instruction,
 *   silently waves the change through.
 *
 * A loop that itself failed (crash, timeout, cancellation) stays failed
 * regardless: an approval collected from a run that never finished says nothing
 * about the change, and the loop's own summary explains more.
 */
export function applyReviewVerdict(
  base: TaskResult,
  verdict: ReviewVerdict | undefined,
): TaskResult {
  if (verdict === undefined) {
    return {
      ...base,
      status: "failed",
      summary:
        base.status === "failed"
          ? `${NO_VERDICT_SUMMARY}: ${base.summary}`
          : NO_VERDICT_SUMMARY,
      confidence: NO_VERDICT_CONFIDENCE,
    };
  }

  if (!verdict.approved) {
    return {
      ...base,
      status: "failed",
      summary: `Review rejected: ${verdict.summary}`,
      unresolvedIssues: [
        ...base.unresolvedIssues,
        ...verdict.issues.map(describeIssue),
      ],
      confidence: REJECTED_CONFIDENCE,
    };
  }

  const failedAnyway = base.status === "failed";
  return {
    ...base,
    status: failedAnyway ? "failed" : "success",
    // A failed loop keeps its own summary: "the run timed out" explains the
    // result, "looks good to me" does not.
    summary: failedAnyway ? base.summary : verdict.summary,
    unresolvedIssues: [
      ...base.unresolvedIssues,
      ...verdict.issues.map(describeIssue),
    ],
  };
}
