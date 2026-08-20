import type { ExecutionPlan } from "@agent/coding-agent";
import { SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRunsCommand, taskCountsCell } from "../src/runs-cmd.js";
import { sessionDbPathFor } from "../src/sessions.js";
import {
  capture,
  cleanupWorkspace,
  makeWorkspace,
  makeWorkspaceWithAgentDir,
  ROUTING_POLICY,
  SAMPLE_PLAN,
} from "./orchestration-fixtures.js";

let seq = 0;

interface SeedTask {
  readonly id: string;
  readonly agent: string;
  readonly status: "success" | "failed" | "partial" | "cancelled";
}

/** Writes a run with a plan and one settled result per named task. */
async function seedRun(
  store: SqliteSessionStore,
  run: {
    readonly id: string;
    readonly objective: string;
    readonly createdAt: number;
    readonly status: "completed" | "failed" | "running";
    readonly plan?: ExecutionPlan;
    readonly tasks?: readonly SeedTask[];
  },
): Promise<void> {
  await store.createRun({
    id: run.id,
    objective: run.objective,
    createdAt: run.createdAt,
    policySnapshot: ROUTING_POLICY,
  });
  if (run.plan !== undefined) await store.savePlan(run.id, run.plan);

  for (const entry of run.tasks ?? []) {
    seq += 1;
    await store.appendEvent({
      id: `${run.id}-${seq}`,
      runId: run.id,
      timestamp: run.createdAt + seq,
      type: "task.completed",
      taskId: entry.id,
      data: {
        agent: entry.agent,
        attempt: 1,
        final: true,
        result: { status: entry.status, summary: `${entry.id} done` },
      },
    });
  }
  await store.setRunStatus(run.id, run.status);
}

describe("taskCountsCell", () => {
  it("spells out what went wrong beside the completion count", () => {
    expect(
      taskCountsCell({
        completed: 3,
        failed: 0,
        partial: 0,
        cancelled: 0,
        total: 3,
      }),
    ).toBe("3/3");
    expect(
      taskCountsCell({
        completed: 1,
        failed: 1,
        partial: 0,
        cancelled: 1,
        total: 3,
      }),
    ).toBe("1/3 (1 failed, 1 cancelled)");
  });

  it("names partial tasks instead of dropping them from the line", () => {
    expect(
      taskCountsCell({
        completed: 0,
        failed: 0,
        partial: 1,
        cancelled: 1,
        total: 2,
      }),
    ).toBe("0/2 (1 partial, 1 cancelled)");
  });

  it("falls back to the tasks it heard from when no plan was saved", () => {
    expect(
      taskCountsCell({ completed: 2, failed: 0, partial: 0, cancelled: 0 }),
    ).toBe("2/2");
  });

  it("counts partial tasks in the fallback denominator so the totals add up", () => {
    expect(
      taskCountsCell({ completed: 1, failed: 0, partial: 1, cancelled: 0 }),
    ).toBe("1/2 (1 partial)");
  });
});

describe("agent runs", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspaceWithAgentDir("cli-runs-test-");
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  function openStore(): SqliteSessionStore {
    return new SqliteSessionStore({ path: sessionDbPathFor(workspace) });
  }

  async function seedTwoRuns(): Promise<void> {
    const store = openStore();
    try {
      await seedRun(store, {
        id: "run-older",
        objective: "add a health endpoint",
        createdAt: 1_700_000_000_000,
        status: "completed",
        plan: SAMPLE_PLAN,
        tasks: [
          { id: "T01", agent: "explorer", status: "success" },
          { id: "T02", agent: "coder", status: "success" },
          { id: "T03", agent: "reviewer", status: "success" },
        ],
      });
      await seedRun(store, {
        id: "run-newer",
        objective:
          "rewrite the whole authentication subsystem and every one of its callers",
        createdAt: 1_700_000_900_000,
        status: "failed",
        plan: SAMPLE_PLAN,
        tasks: [
          { id: "T01", agent: "explorer", status: "success" },
          { id: "T02", agent: "coder", status: "failed" },
        ],
      });
    } finally {
      store.close();
    }
  }

  it("says so, without creating a database, when nothing has been recorded", async () => {
    const bare = await makeWorkspace("cli-runs-empty-");
    try {
      const { output, lines } = capture();
      const code = await runRunsCommand({ cwd: bare, json: false }, { output });

      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("No runs recorded yet");
    } finally {
      await cleanupWorkspace(bare);
    }
  });

  it("lists recorded runs newest first, with counts and a truncated objective", async () => {
    await seedTwoRuns();
    const { output, lines } = capture();

    const code = await runRunsCommand(
      { cwd: workspace, json: false },
      { output },
    );

    expect(code).toBe(0);
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("STATUS");
    expect(lines[0]).toContain("STARTED");
    expect(lines[0]).toContain("TASKS");
    expect(lines[0]).toContain("OBJECTIVE");

    const [, newest, oldest] = lines;
    expect(newest).toContain("run-newer");
    expect(newest).toContain("failed");
    expect(newest).toContain("1/3 (1 failed)");
    expect(newest).toContain("2023-11-14T22:28:20.000Z");
    // Long objectives are cut down so the table stays readable.
    expect(newest).toContain("rewrite the whole authentication subsystem");
    expect(newest).toContain("…");
    expect(newest).not.toContain("callers");

    expect(oldest).toContain("run-older");
    expect(oldest).toContain("completed");
    expect(oldest).toContain("3/3");
  });

  it("honours --limit", async () => {
    await seedTwoRuns();
    const { output, lines } = capture();

    await runRunsCommand({ cwd: workspace, json: false, limit: 1 }, { output });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("run-newer");
  });

  it("emits an array of summaries under --json", async () => {
    await seedTwoRuns();
    const { output, lines } = capture();

    const code = await runRunsCommand(
      { cwd: workspace, json: true },
      { output },
    );

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "[]");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: "run-newer",
      status: "failed",
      startedAt: "2023-11-14T22:28:20.000Z",
      taskCounts: { completed: 1, failed: 1, total: 3 },
    });
  });

  it("counts a partial task in the listing and under --json", async () => {
    const store = openStore();
    try {
      await seedRun(store, {
        id: "run-partial",
        objective: "land the token helper",
        createdAt: 1_700_000_000_000,
        status: "failed",
        plan: SAMPLE_PLAN,
        tasks: [
          // A task whose branch could not be merged: work exists, it just
          // did not land. Neither a completion nor a failure.
          { id: "T01", agent: "coder", status: "partial" },
          { id: "T02", agent: "reviewer", status: "cancelled" },
        ],
      });
    } finally {
      store.close();
    }

    const human = capture();
    expect(await runRunsCommand({ cwd: workspace, json: false }, human)).toBe(
      0,
    );
    expect(human.lines[1]).toContain("0/3 (1 partial, 1 cancelled)");

    const json = capture();
    expect(await runRunsCommand({ cwd: workspace, json: true }, json)).toBe(0);
    expect(JSON.parse(json.lines[0] ?? "[]")[0]).toMatchObject({
      id: "run-partial",
      taskCounts: { completed: 0, failed: 0, partial: 1, cancelled: 1 },
    });
  });

  it("emits an empty array under --json when there is no database", async () => {
    const bare = await makeWorkspace("cli-runs-empty-json-");
    try {
      const { output, lines } = capture();
      const code = await runRunsCommand({ cwd: bare, json: true }, { output });

      expect(code).toBe(0);
      expect(lines).toEqual(["[]"]);
    } finally {
      await cleanupWorkspace(bare);
    }
  });
});
