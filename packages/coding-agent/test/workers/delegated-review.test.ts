import {
  DeterministicScheduler,
  PolicyRouter,
  type RuntimeTask,
  TaskGraph,
  type TaskResult,
  type WorkerExecutionContext,
  type WorkerExecutor,
} from "@agent/orchestration";
import { PolicySchema } from "@agent/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeWorkerExecutor } from "../../src/workers/claude-code-executor.js";
import { writeFakeClaude } from "../backends/test-helpers.js";
import { cleanup, makePlannedTask, makeTempDir } from "./test-helpers.js";

/**
 * The two halves of a blocking review, end to end: the policy has to route the
 * review to the reviewer (not to whoever the tier rule would pick), and a
 * rejection stated in the reply has to reach the scheduler as a failure so the
 * dependents are cancelled. A field test found both broken at once — the coder
 * reviewed its own work and its "REJECTED" prose was recorded as a success.
 */

/** The mock template's routing shape, verbatim. */
const POLICY = PolicySchema.parse({
  version: 1,
  orchestrator: "lead",
  maxConcurrency: 1,
  defaultMaxAttempts: 1,
  routing: [
    {
      id: "route-coder",
      complexity: ["normal"],
      agent: "coder",
      strength: "hard",
    },
    {
      id: "route-reviewer",
      taskTypes: ["review"],
      agent: "reviewer",
      strength: "hard",
    },
  ],
});

const REJECTION = {
  approved: false,
  summary: "The auth token is written to the log.",
  issues: [
    { severity: "blocking", description: "Redact the token before logging." },
  ],
};

/** One `{"type":"result", ...}` line for the fake claude to print. */
function resultLine(text: string): string {
  return JSON.stringify({ type: "result", result: text, session_id: "s" });
}

/** Records who each task was routed to, then delegates to the real executor. */
class RecordingExecutor implements WorkerExecutor {
  readonly routed: { taskId: string; agent: string }[] = [];

  constructor(private readonly inner: WorkerExecutor) {}

  execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    this.routed.push({ taskId: task.spec.id, agent });
    return this.inner.execute(task, agent, signal, context);
  }
}

describe("a rejected delegated review blocks the run", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("delegated-review-");
    workspace = await makeTempDir("delegated-review-ws-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("routes the review to the reviewer and cancels the dependents on rejection", async () => {
    // The fake CLI answers by task: work tasks report prose, the review replies
    // with the JSON verdict the briefing asked for.
    const binaryPath = await writeFakeClaude(dir, {
      body: [
        'if [[ "$*" == *"## Review task"* ]]; then',
        `  printf '%s\\n' '${resultLine(JSON.stringify(REJECTION))}'`,
        "else",
        `  printf '%s\\n' '${resultLine("Implemented the token helper.")}'`,
        "fi",
        "exit 0",
      ].join("\n"),
    });

    const worker = new RecordingExecutor(
      new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-1",
        backendOptions: { binaryPath },
      }),
    );

    const graph = new TaskGraph({
      objective: "Wire a token helper",
      tasks: [
        makePlannedTask({ id: "T01" }),
        makePlannedTask({
          id: "T01-review-review-auth",
          type: "review",
          dependencies: ["T01"],
          suggestedAgent: "reviewer",
        }),
        makePlannedTask({
          id: "T02",
          dependencies: ["T01-review-review-auth"],
        }),
      ],
    });

    await new DeterministicScheduler(new PolicyRouter(), worker).run(
      "run-1",
      graph,
      POLICY,
    );

    expect(worker.routed).toEqual([
      { taskId: "T01", agent: "coder" },
      { taskId: "T01-review-review-auth", agent: "reviewer" },
    ]);

    expect(graph.get("T01").status).toBe("completed");
    expect(graph.get("T01-review-review-auth").status).toBe("failed");
    // The whole point: work that depended on the reviewed change never runs.
    expect(graph.get("T02").status).toBe("cancelled");
    expect(graph.get("T01-review-review-auth").result?.summary).toBe(
      "Review rejected: The auth token is written to the log.",
    );
  }, 20_000);

  it("lets the run continue when the same review approves", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      body: [
        'if [[ "$*" == *"## Review task"* ]]; then',
        `  printf '%s\\n' '${resultLine(
          JSON.stringify({ approved: true, summary: "Safe to keep." }),
        )}'`,
        "else",
        `  printf '%s\\n' '${resultLine("Implemented the token helper.")}'`,
        "fi",
        "exit 0",
      ].join("\n"),
    });

    const worker = new ClaudeCodeWorkerExecutor({
      workspacePath: workspace,
      runId: "run-1",
      backendOptions: { binaryPath },
    });

    const graph = new TaskGraph({
      objective: "Wire a token helper",
      tasks: [
        makePlannedTask({ id: "T01" }),
        makePlannedTask({
          id: "T01-review-review-auth",
          type: "review",
          dependencies: ["T01"],
        }),
        makePlannedTask({
          id: "T02",
          dependencies: ["T01-review-review-auth"],
        }),
      ],
    });

    await new DeterministicScheduler(new PolicyRouter(), worker).run(
      "run-1",
      graph,
      POLICY,
    );

    expect(graph.get("T01-review-review-auth").status).toBe("completed");
    expect(graph.get("T02").status).toBe("completed");
  }, 20_000);
});
