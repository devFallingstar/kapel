import { UsageTracker } from "@agent/ai";
import type {
  AgentProject,
  RuntimeTask,
  TaskResult,
  WorkerExecutor,
} from "@agent/coding-agent";
import {
  ChildProcessWorkerExecutor,
  WorktreeIsolatedExecutor,
} from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestrateCommandOptions } from "../src/orchestrate.js";
import {
  DEFAULT_ISOLATION,
  defaultExecutorFactory,
  runOrchestrate,
  validateIsolation,
  validateWorkerMode,
  worktreeIsolationError,
} from "../src/orchestrate.js";
import { TextRenderer } from "../src/render.js";
import {
  CapturingStream,
  capture,
  cleanupWorkspace,
  copyTemplateAgentDir,
  fixedPlannerFactory,
  initRepo,
  makeWorkspace,
  ROUTING_POLICY,
  SAMPLE_PLAN,
  successResult,
  writeLock,
} from "./orchestration-fixtures.js";

/** The minimum an {@link AgentProject} needs to be for a factory that ignores it. */
function emptyProject(): AgentProject {
  return {
    root: "/virtual/.agent",
    config: { models: {}, agentSlots: {} },
    agents: [],
    orchestrationMarkdown: undefined,
    knownAgentNames: () => new Set<string>(),
    agent: () => undefined,
  };
}

/**
 * A worker that never touches a model: it records who was asked to run what,
 * tracks how many tasks were in flight at once, and fails exactly the task ids
 * it was told to fail.
 */
class ScriptedExecutor implements WorkerExecutor {
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
}

function options(
  cwd: string,
  overrides: Partial<OrchestrateCommandOptions> = {},
): OrchestrateCommandOptions {
  return {
    cwd,
    json: false,
    dryRun: false,
    workerMode: "in-process",
    backend: "native",
    // These fixtures run in throwaway directories that are not repositories,
    // so isolation is opted out of except where a test is about it.
    isolation: "none",
    ...overrides,
  };
}

describe("validateWorkerMode", () => {
  it("accepts the known modes and rejects anything else", () => {
    expect(validateWorkerMode("in-process")).toBe("in-process");
    expect(validateWorkerMode("child")).toBe("child");
    expect(() => validateWorkerMode("thread")).toThrow(/--worker-mode/);
  });
});

describe("validateIsolation", () => {
  it("accepts the known modes and rejects anything else", () => {
    expect(validateIsolation("worktree")).toBe("worktree");
    expect(validateIsolation("none")).toBe("none");
    expect(() => validateIsolation("sandbox")).toThrow(/--isolation/);
  });

  it("defaults to worktree isolation", () => {
    expect(DEFAULT_ISOLATION).toBe("worktree");
  });
});

describe("worktreeIsolationError", () => {
  it("rejects a directory that is not a git repository", async () => {
    const bare = await makeWorkspace("cli-isolation-bare-");
    try {
      const problem = await worktreeIsolationError(bare);
      expect(problem).toContain("git repository with at least one commit");
      expect(problem).toContain("--isolation none");
    } finally {
      await cleanupWorkspace(bare);
    }
  });

  it("accepts a repository that has a commit", async () => {
    const repo = await makeWorkspace("cli-isolation-repo-");
    try {
      await initRepo(repo);
      expect(await worktreeIsolationError(repo)).toBeUndefined();
    } finally {
      await cleanupWorkspace(repo);
    }
  });
});

describe("defaultExecutorFactory / isolation", () => {
  function factoryArgs(
    cwd: string,
    isolation: "worktree" | "none",
  ): Parameters<typeof defaultExecutorFactory>[0] {
    return {
      project: emptyProject(),
      workspacePath: cwd,
      runId: "run-1",
      events: { emit: () => undefined },
      usage: new UsageTracker(),
      // `child` keeps the factory away from model credentials: the executor it
      // builds only needs an argv.
      workerMode: "child",
      backend: "native",
      isolation,
    };
  }

  it("wraps the per-workspace executor in worktree isolation by default", async () => {
    const executor = await defaultExecutorFactory(
      factoryArgs("/does/not/matter", "worktree"),
    );
    expect(executor).toBeInstanceOf(WorktreeIsolatedExecutor);
  });

  it("returns the bare executor under --isolation none", async () => {
    const executor = await defaultExecutorFactory(
      factoryArgs("/does/not/matter", "none"),
    );
    expect(executor).toBeInstanceOf(ChildProcessWorkerExecutor);
  });
});

describe("agent orchestrate", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace("cli-orchestrate-test-");
    await copyTemplateAgentDir(workspace);
    await writeLock(workspace, ROUTING_POLICY);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  it("fans independent tasks out to the agents the policy routes them to", async () => {
    const executor = new ScriptedExecutor();
    const stream = new CapturingStream();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(stream.asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(0);

    // The acceptance criterion: independent tasks reached *different*
    // configured workers, and did so concurrently.
    const byTask = new Map(
      executor.calls.map((call) => [call.taskId, call.agent]),
    );
    expect(byTask.get("T01")).toBe("explorer");
    expect(byTask.get("T02")).toBe("coder");
    expect(byTask.get("T03")).toBe("reviewer");
    expect(new Set(byTask.values()).size).toBe(3);
    expect(executor.maxInFlight).toBeGreaterThanOrEqual(2);

    // T03 depends on T02, so it can only have started after T02 finished.
    const order = executor.calls.map((call) => call.taskId);
    expect(order.indexOf("T03")).toBe(2);

    const rendered = stream.lines.join("\n");
    expect(rendered).toContain("▶ T01 → explorer (attempt 1)");
    expect(rendered).toContain("▶ T02 → coder (attempt 1)");
    expect(rendered).toContain("✔ T03 — T03 done by reviewer");

    const summary = lines.join("\n");
    expect(summary).toContain("STATUS");
    expect(summary).toContain("completed  T01  explorer");
    expect(summary).toContain("3/3 tasks completed");
    expect(summary).toContain("tokens —");
  });

  it("fails the run and cancels dependents when a task fails", async () => {
    const executor = new ScriptedExecutor(new Set(["T02"]));
    const stream = new CapturingStream();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(stream.asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(1);
    expect(executor.calls.map((call) => call.taskId)).not.toContain("T03");

    const rendered = stream.lines.join("\n");
    expect(rendered).toContain("✖ T02 — T02 blew up");
    expect(rendered).toContain("⊘ T03 (dependency-failed)");

    const summary = lines.join("\n");
    expect(summary).toContain("failed     T02");
    expect(summary).toContain("cancelled  T03");
    expect(summary).toContain("1/3 tasks completed");
  });

  it("--dry-run prints the plan and runs no tasks", async () => {
    const executor = new ScriptedExecutor();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { dryRun: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(0);
    expect(executor.calls).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("Objective: add a health endpoint");
    expect(text).toContain("ID   TYPE");
    expect(text).not.toContain("tasks completed");
  });

  it("emits a run.summary line in --json mode", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { json: true }),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.type).toBe("run.summary");
    expect(parsed.ok).toBe(true);
    expect(parsed.tasks.map((entry: { agent: string }) => entry.agent)).toEqual(
      ["explorer", "coder", "reviewer"],
    );
  });

  it("reports an executor that cannot be built, without running anything", async () => {
    const { output, errLines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => {
          throw new Error("The Codex CLI is not installed.");
        },
      },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("The Codex CLI is not installed.");
  });

  it("refuses to run with worktree isolation outside a git repository", async () => {
    const executor = new ScriptedExecutor();
    const { output, errLines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree" }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("--isolation none");
    // Fail fast: nothing was executed.
    expect(executor.calls).toEqual([]);
  });

  it("runs normally with worktree isolation when the workspace is a repository", async () => {
    await initRepo(workspace);
    const executor = new ScriptedExecutor();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree" }),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("3/3 tasks completed");
  });

  it("does not hold --dry-run to the isolation precondition", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree", dryRun: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Objective: add a health endpoint");
  });

  it("reports the isolation precondition through --json", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree", json: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(lines.at(-1) ?? "{}");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--isolation none");
  });

  it("stops at the plan stage when the lock is stale", async () => {
    const bare = await makeWorkspace("cli-orchestrate-bare-");
    try {
      const { output, errLines } = capture();
      const code = await runOrchestrate(
        "add a health endpoint",
        options(bare),
        {
          output,
          plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
          executorFactory: () => new ScriptedExecutor(),
        },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("agent init");
    } finally {
      await cleanupWorkspace(bare);
    }
  });
});
