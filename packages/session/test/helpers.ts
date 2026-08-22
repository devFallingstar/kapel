import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionPlan,
  PlannedTask,
  TaskResult,
} from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import type {
  AgentEvent,
  AgentEventBody,
  AgentEventEnvelope,
} from "@agent/protocol";
import { parseAgentEvent } from "@agent/protocol";

// Session-provided scratch dir when set (keeps CI and local machines on
// the OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

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

/** Envelope defaults, so a test only spells out what it is actually asserting on. */
function nextEnvelope(
  runId: string,
  overrides: Partial<AgentEventEnvelope>,
): AgentEventEnvelope {
  seq += 1;
  const { id, timestamp, taskId, workerId } = overrides;
  return {
    id: id ?? `e${seq}`,
    runId,
    timestamp: timestamp ?? 1000 + seq,
    ...(taskId === undefined ? {} : { taskId }),
    ...(workerId === undefined ? {} : { workerId }),
  };
}

export function makeEvent(
  runId: string,
  body: AgentEventBody,
  overrides: Partial<AgentEventEnvelope> = {},
): AgentEvent {
  return { ...nextEnvelope(runId, overrides), ...body };
}

/**
 * A row written by a kapel that knew an event type this build does not — the
 * case `parseAgentEvent` exists for. Built through that function rather than
 * cast into place, so a test using it is exercising the same lenient path the
 * store does rather than a shape the runtime could never produce.
 */
export function makeLegacyEvent(
  runId: string,
  type: string,
  overrides: Partial<AgentEventEnvelope> & { data?: unknown } = {},
): AgentEvent {
  const { data, ...envelopeOverrides } = overrides;
  const event = parseAgentEvent({
    ...nextEnvelope(runId, envelopeOverrides),
    type,
    ...(data === undefined ? {} : { data }),
  });
  if (event === undefined) {
    throw new Error(`makeLegacyEvent built something unparseable: ${type}`);
  }
  return event;
}
