import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionPlan,
  PlannedTask,
  TaskResult,
} from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent } from "@agent/protocol";

const SCRATCHPAD =
  "/tmp/claude-0/-home-user-multi-model-orchestration-agent/475a4108-ea0d-56a1-9770-14d838a0e5f8/scratchpad";

const created: string[] = [];

/** A fresh directory for a test's database files, removed by `cleanupDbDirs`. */
export function tempDbPath(name = "sessions.db"): string {
  let base: string;
  try {
    base = mkdtempSync(join(SCRATCHPAD, "session-"));
  } catch {
    base = mkdtempSync(join(tmpdir(), "session-"));
  }
  created.push(base);
  return join(base, name);
}

export function cleanupDbDirs(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makePolicy(
  overrides: Partial<OrchestrationPolicy> = {},
): OrchestrationPolicy {
  return {
    version: 1,
    orchestrator: "opus",
    maxConcurrency: 3,
    parallelizeIndependentTasks: true,
    routing: [
      {
        id: "impl-to-sonnet",
        taskTypes: ["implementation"],
        riskCategories: [],
        complexity: ["normal"],
        agent: "sonnet",
        strength: "preference",
        weight: 0.8,
      },
    ],
    review: [],
    escalation: [
      {
        id: "retry-to-opus",
        fromAgent: "sonnet",
        toAgent: "opus",
        afterFailures: 1,
      },
    ],
    defaultMaxAttempts: 2,
    ...overrides,
  };
}

export function makeTask(
  id: string,
  overrides: Partial<PlannedTask> = {},
): PlannedTask {
  return {
    id,
    title: `task ${id}`,
    goal: `do ${id}`,
    type: "implementation",
    complexity: "normal",
    dependencies: [],
    affectedAreas: [],
    risk: { level: "low", categories: [] },
    ...overrides,
  };
}

export function makePlan(tasks: readonly PlannedTask[]): ExecutionPlan {
  return { objective: "ship the thing", tasks };
}

export function makeResult(
  taskId: string,
  overrides: Partial<TaskResult> = {},
): TaskResult {
  return {
    taskId,
    status: "success",
    summary: `${taskId} done`,
    decisions: [],
    changedFiles: [`src/${taskId}.ts`],
    tests: { passed: 1, failed: 0, commands: ["npm test"] },
    unresolvedIssues: [],
    confidence: 0.9,
    ...overrides,
  };
}

let seq = 0;

export function makeEvent(
  runId: string,
  type: string,
  overrides: Partial<Omit<AgentEvent, "runId" | "type">> = {},
): AgentEvent {
  seq += 1;
  const { taskId, workerId, data, ...rest } = overrides;
  return {
    id: `e${seq}`,
    runId,
    timestamp: 1000 + seq,
    type,
    ...rest,
    ...(taskId === undefined ? {} : { taskId }),
    ...(workerId === undefined ? {} : { workerId }),
    ...(data === undefined ? {} : { data }),
  };
}
