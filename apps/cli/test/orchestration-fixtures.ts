import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExecutionPlan,
  OrchestrationPolicy,
  PlannedTask,
  RuntimeTask,
  TaskResult,
  WorkerExecutor,
} from "@agent/coding-agent";
import { createLockfile, serializeLockfile } from "@agent/coding-agent";
import type { OrchestrationOutput, PlannerFactory } from "../src/plan.js";

export // Session-provided scratch dir when set (keeps CI and local machines on
// the OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

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

const execFileAsync = promisify(execFile);

/** Turns a workspace into a git repository with one commit, for isolation tests. */
export async function initRepo(workspacePath: string): Promise<void> {
  const run = async (...args: string[]): Promise<void> => {
    await execFileAsync("git", args, { cwd: workspacePath });
  };
  await run("init", "-q", "-b", "main");
  await run("config", "user.email", "fixture@example.test");
  await run("config", "user.name", "Fixture");
  await run("config", "commit.gpgsign", "false");
  await writeFile(path.join(workspacePath, "README.md"), "base\n", "utf8");
  await run("add", "-A");
  await run("commit", "-q", "-m", "initial");
}

/**
 * A throwaway workspace that already has an (empty) `.agent` directory — the
 * only thing the session store needs to live somewhere.
 */
export async function makeWorkspaceWithAgentDir(
  prefix: string,
): Promise<string> {
  const workspacePath = await makeWorkspace(prefix);
  await mkdir(path.join(workspacePath, ".agent"), { recursive: true });
  return workspacePath;
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

/**
 * A worker that never touches a model: it records who was asked to run what,
 * tracks how many tasks were in flight at once, and fails exactly the task ids
 * it was told to fail.
 */
export class ScriptedExecutor implements WorkerExecutor {
  readonly calls: { taskId: string; agent: string }[] = [];
  maxInFlight = 0;
  #inFlight = 0;

  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  async execute(task: RuntimeTask, agent: string): Promise<TaskResult> {
    const taskId = task.spec.id;
    this.calls.push({ taskId, agent });
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.#inFlight -= 1;

    if (this.failing.has(taskId)) {
      return {
        taskId,
        status: "failed",
        summary: `${taskId} blew up`,
        decisions: [],
        changedFiles: [],
        tests: { passed: 0, failed: 0, commands: [] },
        unresolvedIssues: [],
        confidence: 0.1,
      };
    }
    return successResult(taskId, `${taskId} done by ${agent}`);
  }

  /** The task ids this executor was asked to run, in dispatch order. */
  get taskIds(): readonly string[] {
    return this.calls.map((call) => call.taskId);
  }
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
