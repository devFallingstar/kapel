import type { PlannedTask } from "@agent/orchestration";

/**
 * The instruction every worker backend receives for a planned task.
 *
 * Kept backend-agnostic on purpose: the in-process agent loop, the Codex CLI
 * backend and any child-process worker all get the same briefing, so a task's
 * behaviour does not silently change with the executor it is routed to.
 */
export function buildTaskBriefing(task: PlannedTask, agent: string): string {
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
