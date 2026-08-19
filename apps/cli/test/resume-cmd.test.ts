import { SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestrateCommandOptions } from "../src/orchestrate.js";
import { runOrchestrate } from "../src/orchestrate.js";
import { TextRenderer } from "../src/render.js";
import type { ResumeCommandOptions } from "../src/resume-cmd.js";
import { runResume } from "../src/resume-cmd.js";
import { sessionDbPathFor } from "../src/sessions.js";
import {
  CapturingStream,
  capture,
  cleanupWorkspace,
  copyTemplateAgentDir,
  fixedPlannerFactory,
  makeWorkspace,
  REVIEW_POLICY,
  ROUTING_POLICY,
  SAMPLE_PLAN,
  ScriptedExecutor,
  writeLock,
} from "./orchestration-fixtures.js";

describe("kapel resume", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace("cli-resume-test-");
    await copyTemplateAgentDir(workspace);
    await writeLock(workspace, ROUTING_POLICY);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  function orchestrateOptions(): OrchestrateCommandOptions {
    return {
      cwd: workspace,
      json: false,
      dryRun: false,
      backend: "native",
      isolation: "none",
    };
  }

  function resumeOptions(
    overrides: Partial<ResumeCommandOptions> = {},
  ): ResumeCommandOptions {
    return {
      cwd: workspace,
      json: false,
      backend: "native",
      isolation: "none",
      ...overrides,
    };
  }

  function openStore(): SqliteSessionStore {
    return new SqliteSessionStore({ path: sessionDbPathFor(workspace) });
  }

  /** Runs an orchestration that fails `failing`, and returns its run id. */
  async function firstPass(failing: readonly string[]): Promise<string> {
    const { output } = capture();
    await runOrchestrate("add a health endpoint", orchestrateOptions(), {
      output,
      renderer: new TextRenderer(new CapturingStream().asStream()),
      plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
      executorFactory: () => new ScriptedExecutor(new Set(failing)),
    });

    const store = openStore();
    try {
      const [run] = await store.listRuns();
      if (run === undefined) throw new Error("the first pass recorded no run");
      return run.id;
    } finally {
      store.close();
    }
  }

  it("re-executes only the tasks that never succeeded, into the same run", async () => {
    const runId = await firstPass(["T02"]);

    const before = openStore();
    let eventsBefore: number;
    try {
      expect((await before.getRun(runId))?.status).toBe("failed");
      eventsBefore = (await before.listEvents(runId)).length;
    } finally {
      before.close();
    }

    const executor = new ScriptedExecutor();
    const { output, lines } = capture();

    const code = await runResume(runId, resumeOptions(), {
      output,
      renderer: new TextRenderer(new CapturingStream().asStream()),
      executorFactory: () => executor,
    });

    expect(code).toBe(0);
    // T01 already succeeded and is not run again; T03 was only cancelled
    // because T02 failed, so it runs once T02 lands.
    expect(executor.taskIds).toEqual(["T02", "T03"]);

    const text = lines.join("\n");
    expect(text).toContain(`Resuming run ${runId} — 2 of 3 tasks left`);
    expect(text).toContain("3/3 tasks completed");
    // The pre-marked task keeps the agent and result it had the first time.
    expect(text).toContain("completed  T01  explorer");

    const after = openStore();
    try {
      const run = await after.getRun(runId);
      expect(run?.status).toBe("completed");
      // Same run, more history — the events accrue rather than restarting.
      expect((await after.listEvents(runId)).length).toBeGreaterThan(
        eventsBefore,
      );
      expect(await after.listRuns()).toHaveLength(1);

      const results = await after.taskResults(runId);
      expect(results.get("T02")?.status).toBe("success");
      expect(results.get("T03")?.status).toBe("success");
    } finally {
      after.close();
    }
  });

  it("does nothing, successfully, when the run has no unfinished tasks", async () => {
    const runId = await firstPass([]);
    const executor = new ScriptedExecutor();
    const { output, lines } = capture();

    const code = await runResume(runId, resumeOptions(), {
      output,
      executorFactory: () => executor,
    });

    expect(code).toBe(0);
    expect(executor.calls).toEqual([]);
    expect(lines.join("\n")).toContain("Nothing to resume");
  });

  it("rejects an unknown run", async () => {
    await firstPass(["T02"]);
    const { output, errLines } = capture();

    const code = await runResume("no-such-run", resumeOptions(), { output });

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("Unknown run no-such-run");
  });

  it("rejects a run that never got a plan saved", async () => {
    const store = openStore();
    try {
      await store.createRun({
        id: "planless",
        objective: "add a health endpoint",
        createdAt: Date.now(),
        policySnapshot: ROUTING_POLICY,
      });
    } finally {
      store.close();
    }
    const { output, errLines } = capture();

    const code = await runResume("planless", resumeOptions(), { output });

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("has no saved plan");
  });

  it("says so when the workspace has recorded nothing at all", async () => {
    const bare = await makeWorkspace("cli-resume-empty-");
    try {
      const { output, errLines } = capture();
      const code = await runResume("whatever", resumeOptions({ cwd: bare }), {
        output,
      });

      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("No runs recorded yet");
    } finally {
      await cleanupWorkspace(bare);
    }
  });

  it("resumes under the run's own policy snapshot, warning that the lock moved on", async () => {
    const runId = await firstPass(["T02"]);
    // The project's policy is recompiled between the two passes.
    await writeLock(workspace, REVIEW_POLICY);

    const executor = new ScriptedExecutor();
    const { output, errLines } = capture();

    const code = await runResume(runId, resumeOptions(), {
      output,
      renderer: new TextRenderer(new CapturingStream().asStream()),
      executorFactory: () => executor,
    });

    expect(code).toBe(0);
    expect(errLines.join("\n")).toContain(
      "policy has changed since run started",
    );
    expect(errLines.join("\n")).toContain(
      "policy snapshot recorded with the run",
    );
    expect(executor.taskIds).toEqual(["T02", "T03"]);
  });

  it("stays quiet when the project's policy has not moved", async () => {
    const runId = await firstPass(["T02"]);
    const { output, errLines } = capture();

    await runResume(runId, resumeOptions(), {
      output,
      renderer: new TextRenderer(new CapturingStream().asStream()),
      executorFactory: () => new ScriptedExecutor(),
    });

    expect(errLines.join("\n")).not.toContain("policy");
  });

  it("refuses --tui together with --json", async () => {
    const runId = await firstPass(["T02"]);
    const executor = new ScriptedExecutor();
    const { output, errLines } = capture();

    const code = await runResume(
      runId,
      resumeOptions({ tui: true, json: true }),
      { output, executorFactory: () => executor },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain(
      "--tui cannot be combined with --json",
    );
    expect(executor.calls).toEqual([]);
  });
});
