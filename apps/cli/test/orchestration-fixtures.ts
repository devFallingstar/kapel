import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionPlan,
  OrchestrationPolicy,
  PlannedTask,
  TaskResult,
} from "@agent/coding-agent";
import { createLockfile, serializeLockfile } from "@agent/coding-agent";
import type { OrchestrationOutput, PlannerFactory } from "../src/plan.js";

export const SCRATCHPAD =
  "/tmp/claude-0/-home-user-multi-model-orchestration-agent/475a4108-ea0d-56a1-9770-14d838a0e5f8/scratchpad";

const TEMPLATE_AGENT_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "templates",
  "default",
  ".agent",
);

export const LOCK_FILE_NAME = "orchestration.lock.json";

export async function makeWorkspace(prefix: string): Promise<string> {
  return mkdtemp(path.join(SCRATCHPAD, prefix));
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

/** Copies the repo's `templates/default/.agent` fixture into `<workspacePath>/.agent`. */
export async function copyTemplateAgentDir(
  workspacePath: string,
): Promise<void> {
  await cp(TEMPLATE_AGENT_DIR, path.join(workspacePath, ".agent"), {
    recursive: true,
  });
}

/**
 * Writes a lock that is fresh against the workspace's current
 * `orchestration.md`, without going through the LLM-backed compiler.
 */
export async function writeLock(
  workspacePath: string,
  policy: OrchestrationPolicy,
): Promise<void> {
  const agentDir = path.join(workspacePath, ".agent");
  const markdown = await readFile(
    path.join(agentDir, "orchestration.md"),
    "utf8",
  );
  const lock = createLockfile({
    markdown,
    result: { policy, warnings: [], ambiguities: [] },
    model: "test-model",
    now: 0,
  });
  await writeFile(
    path.join(agentDir, LOCK_FILE_NAME),
    serializeLockfile(lock),
    "utf8",
  );
}

function route(
  id: string,
  taskType: string,
  agent: string,
): OrchestrationPolicy["routing"][number] {
  return {
    id,
    taskTypes: [taskType],
    riskCategories: [],
    complexity: [],
    agent,
    strength: "hard",
    weight: 1,
  };
}

/**
 * Routes each task type in {@link SAMPLE_PLAN} to a different template agent —
 * the setup the fan-out acceptance test asserts against.
 */
export const ROUTING_POLICY: OrchestrationPolicy = {
  version: 1,
  orchestrator: "lead",
  maxConcurrency: 4,
  parallelizeIndependentTasks: true,
  routing: [
    route("route-explore", "exploration", "explorer"),
    route("route-impl", "implementation", "coder"),
    route("route-test", "testing", "reviewer"),
  ],
  review: [],
  escalation: [],
  // One attempt per task: a failing task should fail the run outright rather
  // than being retried, which keeps the failure-path assertions exact.
  defaultMaxAttempts: 1,
};

/** {@link ROUTING_POLICY} plus a review rule that fires on the "auth" risk category. */
export const REVIEW_POLICY: OrchestrationPolicy = {
  ...ROUTING_POLICY,
  review: [
    {
      id: "review-auth",
      riskCategories: ["auth"],
      reviewer: "reviewer",
      blocking: true,
      strength: "hard",
    },
  ],
};

export function task(
  id: string,
  overrides: Partial<PlannedTask> = {},
): PlannedTask {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    type: "implementation",
    complexity: "normal",
    dependencies: [],
    affectedAreas: ["src"],
    risk: { level: "low", categories: [] },
    ...overrides,
  };
}

/** Two independent roots that route to different agents, plus one dependent task. */
export const SAMPLE_PLAN: ExecutionPlan = {
  objective: "add a health endpoint",
  tasks: [
    task("T01", { type: "exploration", title: "Survey the server" }),
    task("T02", { type: "implementation", title: "Add the endpoint" }),
    task("T03", {
      type: "testing",
      title: "Cover the endpoint",
      dependencies: ["T02"],
    }),
  ],
};

export function fixedPlannerFactory(plan: ExecutionPlan): PlannerFactory {
  return () => ({ plan: async () => plan });
}

export function throwingPlannerFactory(error: Error): PlannerFactory {
  return () => ({
    plan: async () => {
      throw error;
    },
  });
}

export function successResult(taskId: string, summary: string): TaskResult {
  return {
    taskId,
    status: "success",
    summary,
    decisions: [],
    changedFiles: [],
    tests: { passed: 0, failed: 0, commands: [] },
    unresolvedIssues: [],
    confidence: 0.8,
  };
}

export function capture(): {
  output: OrchestrationOutput;
  lines: string[];
  errLines: string[];
} {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    output: {
      log: (line) => lines.push(line),
      error: (line) => errLines.push(line),
    },
    lines,
    errLines,
  };
}

/** Minimal `NodeJS.WritableStream` stand-in that records every write. */
export class CapturingStream {
  readonly isTTY = false;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get lines(): string[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line !== "");
  }

  asStream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
}
