import type {
  PlannedTask,
  TaskResult,
  WorkerExecutionContext,
} from "@agent/orchestration";
import { REVIEW_VERDICT_TOOL_NAME } from "./review.js";

/** How much of a dependency's summary is quoted into the briefing. */
const MAX_DEPENDENCY_SUMMARY_CHARS = 400;

/** How many changed files a dependency contributes before the list is cut short. */
const MAX_DEPENDENCY_FILES = 20;

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/**
 * Renders what a task's dependencies produced.
 *
 * A dependent task is usually building on files another worker just wrote, and
 * in an isolated run it cannot ask: the changes exist in the base branch but
 * nothing in the briefing points at them. Summaries are quoted rather than
 * pasted whole, and file lists are capped, so a chatty dependency cannot crowd
 * the task's own instructions out of the prompt.
 */
function dependencySection(results: readonly TaskResult[]): string[] {
  const lines: string[] = ["", "## Results from dependency tasks", ""];

  for (const result of results) {
    lines.push(`### ${result.taskId} — ${result.status}`);
    lines.push(truncate(result.summary, MAX_DEPENDENCY_SUMMARY_CHARS));

    if (result.changedFiles.length > 0) {
      lines.push("Changed files:");
      for (const file of result.changedFiles.slice(0, MAX_DEPENDENCY_FILES)) {
        lines.push(`  - ${file}`);
      }
      const extra = result.changedFiles.length - MAX_DEPENDENCY_FILES;
      if (extra > 0) lines.push(`  - ... and ${extra} more`);
    }
    lines.push("");
  }

  return lines;
}

/**
 * How a review task is asked to state its decision.
 *
 * - `"tool"` — the in-process agent loop, which injects {@link
 *   ReviewVerdictTool} and reads the verdict back off it.
 * - `"json-reply"` — a delegated CLI backend (Claude Code, Codex), which runs
 *   its own loop with its own toolset and cannot be handed a tool definition,
 *   so the verdict has to come back in the reply text instead.
 *
 * Same contract either way, and both halves of it are enforced by the executor:
 * the verdict decides the review, and no verdict fails it.
 */
export type ReviewContract = "tool" | "json-reply";

/** The lines both review contracts open with. */
const REVIEW_PREAMBLE = [
  "",
  "## Review task — a verdict is required",
  "",
  "You are reviewing work that other tasks produced, not writing code yourself.",
  "Inspect the results of the tasks you depend on and the files they changed:",
  "read those files, and use a diff against the base to see exactly what moved.",
];

/**
 * The extra instructions a `review` task carries.
 *
 * A review is only worth running if it can block, and it can only block if it
 * produces something the runtime can read. Prose cannot be acted on, so the
 * briefing states the contract bluntly: inspect, then state the verdict in the
 * one form this backend can read back. The executor treats a missing verdict as
 * a failure, which is the other half of the same contract — saying so here
 * keeps that from looking arbitrary.
 *
 * The `json-reply` variant spells out the schema `parseReviewVerdictReply`
 * validates against (see `./review.ts`); it is stated as an example object
 * rather than as JSON Schema because the reader is a coding CLI writing one
 * message, not an API being handed a tool definition.
 */
function reviewSection(contract: ReviewContract): string[] {
  if (contract === "json-reply") {
    return [
      ...REVIEW_PREAMBLE,
      "Do not edit, create or delete any file: this task decides, it does not fix.",
      "",
      "There is no verdict tool here — you are answering through a CLI, so the",
      "verdict IS your reply. Your final message MUST contain exactly one JSON",
      "object, in this shape, with nothing after it:",
      "",
      "{",
      '  "approved": false,',
      '  "summary": "One short paragraph explaining the decision.",',
      '  "issues": [',
      '    { "severity": "blocking", "description": "What is wrong, specific enough to act on." }',
      "  ]",
      "}",
      "",
      "  - `approved` is true only when the change is acceptable as it stands;",
      "  - `approved` is false whenever you found anything that must be fixed first;",
      '  - `severity` is either "blocking" (must not ship as-is) or "advisory";',
      "  - `issues` may be `[]`, but list every problem you found, blocking ones first.",
      "",
      "A blocking issue means the verdict is not approved. A reply this object",
      "cannot be read out of fails this task — an undecided review does not pass.",
    ];
  }

  return [
    ...REVIEW_PREAMBLE,
    "",
    `You MUST call the \`${REVIEW_VERDICT_TOOL_NAME}\` tool exactly once before you finish:`,
    "  - `approved: true` only when the change is acceptable as it stands;",
    "  - `approved: false` whenever you found anything that must be fixed first;",
    "  - list every problem in `issues`, marking each `blocking` or `advisory`.",
    "",
    "A blocking issue means the verdict is not approved. Finishing without calling",
    `\`${REVIEW_VERDICT_TOOL_NAME}\` fails this task — an undecided review does not pass.`,
  ];
}

export interface TaskBriefingOptions {
  /**
   * How a `review` task must state its verdict; defaults to `"tool"`, which is
   * what the in-process loop (and any child process serving it) provides.
   * Ignored for every other task type.
   */
  readonly reviewContract?: ReviewContract;
}

/**
 * The instruction every worker backend receives for a planned task.
 *
 * Kept backend-agnostic on purpose: the in-process agent loop, the Codex CLI
 * backend and any child-process worker all get the same briefing, so a task's
 * behaviour does not silently change with the executor it is routed to. The one
 * deliberate exception is {@link TaskBriefingOptions.reviewContract}: how a
 * verdict is *delivered* is genuinely a property of the backend, since only the
 * in-process loop can be given a tool to call. What is being asked for — a
 * decision, in that exact shape, or the review fails — does not change.
 */
export function buildTaskBriefing(
  task: PlannedTask,
  agent: string,
  context?: WorkerExecutionContext,
  options?: TaskBriefingOptions,
): string {
  const lines: string[] = [
    `You are acting as the "${agent}" worker on task ${task.id}.`,
    "",
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    `Type: ${task.type} (complexity: ${task.complexity})`,
  ];

  if (task.affectedAreas.length > 0) {
    lines.push(
      "Affected areas — touch only these areas:",
      ...task.affectedAreas.map((area) => `  - ${area}`),
    );
  } else {
    lines.push(
      "Affected areas: none were declared — keep the change as narrow as possible.",
    );
  }

  lines.push(`Risk level: ${task.risk.level}`);
  if (task.risk.categories.length > 0) {
    lines.push(`Risk categories: ${task.risk.categories.join(", ")}`);
  }
  if (task.dependencies.length > 0) {
    lines.push(`Depends on completed tasks: ${task.dependencies.join(", ")}`);
  }

  lines.push(
    "",
    "Work directly in the current workspace. Return a short summary of what you changed.",
    "If this project configures validators (.agent/config.yaml's `validation:` block), they run against your change after you finish — you are not expected to run checks yourself.",
  );

  const dependencyResults = context?.dependencyResults ?? [];
  if (dependencyResults.length > 0) {
    lines.push(...dependencySection(dependencyResults));
  }

  if (task.type === "review") {
    lines.push(...reviewSection(options?.reviewContract ?? "tool"));
  }

  return lines.join("\n");
}

/**
 * Appended to a worker agent's own system prompt.
 *
 * Workers run unattended, so the prompt has to state what the runtime cannot:
 * there is nobody to answer a clarifying question, and denied tools come back
 * as errors rather than as prompts.
 */
export const WORKER_SYSTEM_POSTAMBLE = [
  "## Execution context",
  "",
  "You are running as a headless worker inside an automated orchestration run.",
  "No human is watching this session: never ask for confirmation and never wait",
  "for input. Make the smallest reasonable change that satisfies the task and",
  "stay inside the affected areas named in the task briefing. Tool calls outside",
  "your granted permissions are rejected automatically — treat a denial as a",
  "constraint to work around, not something to retry. Finish by replying with a",
  "short prose summary of what you changed.",
].join("\n");

/** Combines an agent's configured system prompt with the worker postamble. */
export function buildWorkerSystemPrompt(systemPrompt: string): string {
  const base = systemPrompt.trim();
  return base === ""
    ? WORKER_SYSTEM_POSTAMBLE
    : `${base}\n\n${WORKER_SYSTEM_POSTAMBLE}`;
}
