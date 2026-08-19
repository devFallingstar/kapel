import type {
  PlannedTask,
  TaskResult,
  WorkerExecutionContext,
} from "@agent/orchestration";

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
 * The instruction every worker backend receives for a planned task.
 *
 * Kept backend-agnostic on purpose: the in-process agent loop, the Codex CLI
 * backend and any child-process worker all get the same briefing, so a task's
 * behaviour does not silently change with the executor it is routed to.
 */
export function buildTaskBriefing(
  task: PlannedTask,
  agent: string,
  context?: WorkerExecutionContext,
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
  );

  const dependencyResults = context?.dependencyResults ?? [];
  if (dependencyResults.length > 0) {
    lines.push(...dependencySection(dependencyResults));
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
