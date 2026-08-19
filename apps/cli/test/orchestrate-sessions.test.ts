import { existsSync } from "node:fs";
import type { RuntimeTask } from "@agent/coding-agent";
import type { AgentEvent } from "@agent/protocol";
import { SqliteSessionStore } from "@agent/session";
import type { TuiController, TuiInit, TuiState } from "@agent/tui";
import { initialTuiState } from "@agent/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestrateCommandOptions } from "../src/orchestrate.js";
import { outcomeLine, runOrchestrate } from "../src/orchestrate.js";
import { TextRenderer } from "../src/render.js";
import { sessionDbPathFor } from "../src/sessions.js";
import {
  CapturingStream,
  capture,
  cleanupWorkspace,
  copyTemplateAgentDir,
  fixedPlannerFactory,
  makeWorkspace,
  ROUTING_POLICY,
  SAMPLE_PLAN,
  ScriptedExecutor,
  task,
  writeLock,
} from "./orchestration-fixtures.js";

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
    isolation: "none",
    ...overrides,
  };
}

/** A `TuiController` stand-in: records what the run fed it and how it ended. */
class FakeTui implements TuiController {
  readonly events: AgentEvent[] = [];
  readonly state: TuiState = initialTuiState();
  outcome: string | undefined;
  unmounted = false;
  init: TuiInit | undefined;

  readonly sink = {
    emit: (event: AgentEvent): void => {
      this.events.push(event);
    },
  };

  finish(outcome: string): void {
    this.outcome = outcome;
  }

  async unmount(): Promise<void> {
    this.unmounted = true;
  }
}

describe("kapel orchestrate — session persistence", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace("cli-orchestrate-store-");
    await copyTemplateAgentDir(workspace);
    await writeLock(workspace, ROUTING_POLICY);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  function openStore(): SqliteSessionStore {
    return new SqliteSessionStore({ path: sessionDbPathFor(workspace) });
  }

  it("records the run, its plan, its events and its final status", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);

    const store = openStore();
    try {
      const runs = await store.listRuns();
      expect(runs).toHaveLength(1);
      const summary = runs[0];
      if (summary === undefined) throw new Error("no run recorded");

      // The run id the user was told to keep is the one that was stored.
      expect(lines.join("\n")).toContain(`Run ${summary.id} —`);
      expect(summary.status).toBe("completed");
      expect(summary.objective).toBe("add a health endpoint");
      expect(summary.taskCounts).toMatchObject({ completed: 3, total: 3 });

      const run = await store.getRun(summary.id);
      expect(run?.plan?.tasks.map((entry) => entry.id)).toEqual([
        "T01",
        "T02",
        "T03",
      ]);
      // The policy snapshot is the one the run executed under.
      expect(run?.policy.orchestrator).toBe(ROUTING_POLICY.orchestrator);

      const events = await store.listEvents(summary.id);
      const types = new Set(events.map((event) => event.type));
      expect(types.has("task.started")).toBe(true);
      expect(types.has("task.completed")).toBe(true);

      const results = await store.taskResults(summary.id);
      expect(results.get("T01")?.agent).toBe("explorer");
      expect(results.get("T02")?.status).toBe("success");
    } finally {
      store.close();
    }
  });

  it("records a failed run as failed", async () => {
    const { output } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(new Set(["T02"])),
      },
    );

    expect(code).toBe(1);

    const store = openStore();
    try {
      const [summary] = await store.listRuns();
      expect(summary?.status).toBe("failed");
      expect(summary?.taskCounts).toMatchObject({
        completed: 1,
        failed: 1,
        cancelled: 1,
      });
    } finally {
      store.close();
    }
  });

  it("--no-save leaves no database behind", async () => {
    const { output } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { save: false }),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);
    expect(existsSync(sessionDbPathFor(workspace))).toBe(false);
  });

  it("keeps a second run of the same workspace alongside the first", async () => {
    const { output } = capture();
    for (let index = 0; index < 2; index += 1) {
      await runOrchestrate("add a health endpoint", options(workspace), {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      });
    }

    const store = openStore();
    try {
      const runs = await store.listRuns();
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((run) => run.id)).size).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("outcomeLine", () => {
  it("reports a clean run and a broken one differently", () => {
    const runtime = (
      id: string,
      status: RuntimeTask["status"],
    ): RuntimeTask => ({ spec: task(id), status, attempts: 1 });

    expect(outcomeLine([runtime("T01", "completed")])).toBe(
      "completed 1/1 tasks",
    );
    expect(
      outcomeLine([
        runtime("T01", "completed"),
        runtime("T02", "failed"),
        runtime("T03", "cancelled"),
      ]),
    ).toBe("failed: 1 task failed, 1 cancelled");
  });
});

describe("kapel orchestrate — --tui", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace("cli-orchestrate-tui-");
    await copyTemplateAgentDir(workspace);
    await writeLock(workspace, ROUTING_POLICY);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  it("feeds the dashboard instead of printing event lines, and prints the summary after unmount", async () => {
    const tui = new FakeTui();
    const stream = new CapturingStream();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { tui: true }),
      {
        output,
        renderer: new TextRenderer(stream.asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
        tuiFactory: (init) => {
          tui.init = init;
          return tui;
        },
      },
    );

    expect(code).toBe(0);
    // The dashboard owns the screen: no per-event renderer writes at all.
    expect(stream.lines).toEqual([]);
    expect(tui.init?.objective).toBe("add a health endpoint");
    expect(tui.init?.taskIds?.map((seed) => seed.id)).toEqual([
      "T01",
      "T02",
      "T03",
    ]);
    expect(tui.events.map((event) => event.type)).toContain("task.completed");
    expect(tui.outcome).toBe("completed 3/3 tasks");
    expect(tui.unmounted).toBe(true);

    // The run header is suppressed; only the post-unmount summary is printed.
    expect(lines.some((line) => line.startsWith("Run "))).toBe(false);
    expect(lines.join("\n")).toContain("3/3 tasks completed");
  });

  it("reports a failed run to the dashboard before tearing it down", async () => {
    const tui = new FakeTui();
    const { output } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { tui: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(new Set(["T02"])),
        tuiFactory: () => tui,
      },
    );

    expect(code).toBe(1);
    expect(tui.outcome).toBe("failed: 1 task failed, 1 cancelled");
    expect(tui.unmounted).toBe(true);
  });

  it("falls back to plain output when the dashboard cannot start", async () => {
    const stream = new CapturingStream();
    const { output, lines, errLines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { tui: true }),
      {
        output,
        renderer: new TextRenderer(stream.asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
        tuiFactory: () => {
          throw new Error("not a tty");
        },
      },
    );

    expect(code).toBe(0);
    expect(errLines.join("\n")).toContain("not a tty");
    expect(stream.lines.join("\n")).toContain("▶ T01 → explorer");
    expect(lines.join("\n")).toContain("3/3 tasks completed");
  });

  it("refuses --tui together with --json", async () => {
    const { output, errLines } = capture();
    const executor = new ScriptedExecutor();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { tui: true, json: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain(
      "--tui cannot be combined with --json",
    );
    // Rejected before planning: nothing ran.
    expect(executor.calls).toEqual([]);
  });
});
