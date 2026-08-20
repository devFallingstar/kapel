import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultSessionDbPath,
  InMemorySessionStore,
  type RunRecord,
  reconstructRun,
  type SessionStore,
  SqliteSessionStore,
} from "../src/index.js";
import {
  cleanupDbDirs,
  makeEvent,
  makePlan,
  makePolicy,
  makeResult,
  makeTask,
  tempDbPath,
} from "./helpers.js";

afterAll(() => {
  cleanupDbDirs();
});

function memoryStore(): SqliteSessionStore {
  return new SqliteSessionStore({ path: ":memory:" });
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    objective: "ship the thing",
    createdAt: 1_700_000_000_000,
    policySnapshot: makePolicy(),
    ...overrides,
  };
}

describe("SqliteSessionStore bootstrap", () => {
  it("creates its schema on open and tolerates a second open of the same file", async () => {
    const path = tempDbPath();
    const first = new SqliteSessionStore({ path });
    await first.createRun(runRecord());
    first.close();

    // Re-running the DDL against a populated file must be a no-op, not an error.
    const second = new SqliteSessionStore({ path });
    expect((await second.getRun("run-1"))?.objective).toBe("ship the thing");
    second.close();
  });

  it("enables WAL for file databases and leaves :memory: alone", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    store.close();

    const raw = new Database(path);
    expect(String(raw.pragma("journal_mode", { simple: true }))).toBe("wal");
    raw.close();

    const memory = memoryStore();
    await memory.createRun(runRecord());
    expect(await memory.getRun("run-1")).toBeDefined();
    memory.close();
  });

  it("derives the default database path from an agent directory", () => {
    expect(defaultSessionDbPath("/home/dev/.agent")).toBe(
      "/home/dev/.agent/sessions.db",
    );
  });
});

describe("SqliteSessionStore runs", () => {
  it("round-trips a run and its policy snapshot", async () => {
    const store = memoryStore();
    const record = runRecord();
    await store.createRun(record);

    const run = await store.getRun("run-1");
    expect(run).toBeDefined();
    expect(run?.id).toBe("run-1");
    expect(run?.objective).toBe("ship the thing");
    expect(run?.createdAt).toBe(record.createdAt);
    // A brand new run is "running" and has not been touched since creation.
    expect(run?.status).toBe("running");
    expect(run?.updatedAt).toBe(record.createdAt);
    expect(run?.policy).toEqual(record.policySnapshot);
    expect(run?.plan).toBeUndefined();
    store.close();
  });

  it("returns undefined for an unknown run", async () => {
    const store = memoryStore();
    expect(await store.getRun("nope")).toBeUndefined();
    expect(await reconstructRun(store, "nope")).toBeUndefined();
    store.close();
  });

  it("stores a plan and hands it back on getRun", async () => {
    const store = memoryStore();
    await store.createRun(runRecord());
    const plan = makePlan([
      makeTask("t1"),
      makeTask("t2", { dependencies: ["t1"] }),
    ]);
    await store.savePlan("run-1", plan);

    const run = await store.getRun("run-1");
    expect(run?.plan).toEqual(plan);
    expect(run?.updatedAt).toBeGreaterThanOrEqual(runRecord().createdAt);
    store.close();
  });

  it("updates status and bumps updatedAt", async () => {
    const store = memoryStore();
    await store.createRun(runRecord());
    const before = await store.getRun("run-1");
    await store.setRunStatus("run-1", "completed");

    const after = await store.getRun("run-1");
    expect(after?.status).toBe("completed");
    expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0);
    store.close();
  });
});

describe("SqliteSessionStore events", () => {
  it("lists events by timestamp and preserves insertion order within a timestamp", async () => {
    const store = memoryStore();
    await store.createRun(runRecord());

    await store.appendEvent(
      makeEvent("run-1", "run.started", { id: "a", timestamp: 20 }),
    );
    await store.appendEvent(
      makeEvent("run-1", "second", { id: "b", timestamp: 10 }),
    );
    await store.appendEvent(
      makeEvent("run-1", "third", { id: "c", timestamp: 10 }),
    );
    await store.appendEvent(
      makeEvent("run-1", "fourth", { id: "d", timestamp: 10 }),
    );

    const ids = (await store.listEvents("run-1")).map((event) => event.id);
    expect(ids).toEqual(["b", "c", "d", "a"]);
    store.close();
  });

  it("round-trips optional event fields and arbitrary data", async () => {
    const store = memoryStore();
    const event = makeEvent("run-1", "task.progress", {
      taskId: "t1",
      workerId: "w7",
      data: { nested: { list: [1, 2, 3] }, flag: true },
    });
    await store.appendEvent(event);

    const [stored] = await store.listEvents("run-1");
    expect(stored).toEqual(event);

    const bare = makeEvent("run-1", "run.started");
    await store.appendEvent(bare);
    const [, storedBare] = await store.listEvents("run-1");
    expect(storedBare).toEqual(bare);
    expect(storedBare && "taskId" in storedBare).toBe(false);
    expect(storedBare && "data" in storedBare).toBe(false);
    store.close();
  });

  it("scopes events to their run and to a task", async () => {
    const store = memoryStore();
    await store.appendEvent(
      makeEvent("run-1", "task.started", { taskId: "t1" }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.started", { taskId: "t2" }),
    );
    await store.appendEvent(
      makeEvent("run-2", "task.started", { taskId: "t1" }),
    );

    expect((await store.listEvents("run-1")).length).toBe(2);
    expect((await store.listEvents("run-2")).length).toBe(1);
    const taskEvents = await store.taskEvents("run-1", "t1");
    expect(taskEvents.map((event) => event.taskId)).toEqual(["t1"]);
    store.close();
  });

  it("ignores a replayed event id instead of failing the append", async () => {
    const store = memoryStore();
    const event = makeEvent("run-1", "run.started", { id: "dup" });
    await store.appendEvent(event);
    await store.appendEvent(event);
    expect((await store.listEvents("run-1")).length).toBe(1);
    store.close();
  });
});

describe("SqliteSessionStore task_results maintenance", () => {
  it("tracks a task from start to successful completion", async () => {
    const store = memoryStore();
    await store.appendEvent(
      makeEvent("run-1", "task.started", {
        taskId: "t1",
        data: { agent: "sonnet", attempt: 1 },
      }),
    );

    let results = await store.taskResults("run-1");
    expect(results.get("t1")).toMatchObject({
      taskId: "t1",
      agent: "sonnet",
      attempts: 1,
      status: "running",
    });
    expect(results.get("t1")?.result).toBeUndefined();

    const result = makeResult("t1");
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { agent: "sonnet", result, attempt: 1, final: true },
      }),
    );

    results = await store.taskResults("run-1");
    expect(results.get("t1")?.status).toBe("success");
    expect(results.get("t1")?.attempts).toBe(1);
    expect(results.get("t1")?.result).toEqual(result);
    store.close();
  });

  it("follows a realistic retry, escalation, failure and dependent-cancel sequence", async () => {
    const store = memoryStore();
    await store.createRun(runRecord());
    await store.savePlan(
      "run-1",
      makePlan([
        makeTask("t1"),
        makeTask("t2", { dependencies: ["t1"] }),
        makeTask("t3"),
      ]),
    );

    // t1: first attempt fails on sonnet, escalates to opus, fails for good.
    await store.appendEvent(
      makeEvent("run-1", "task.started", {
        taskId: "t1",
        data: { agent: "sonnet", attempt: 1 },
      }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: {
          agent: "sonnet",
          result: makeResult("t1", { status: "failed", confidence: 0.2 }),
          attempt: 1,
          final: false,
        },
      }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.escalated", {
        taskId: "t1",
        data: { from: "sonnet", to: "opus", rule: "retry-to-opus" },
      }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.started", {
        taskId: "t1",
        data: { agent: "opus", attempt: 2 },
      }),
    );
    const finalFailure = makeResult("t1", {
      status: "failed",
      confidence: 0.3,
    });
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { agent: "opus", result: finalFailure, attempt: 2, final: true },
      }),
    );
    // t2 depended on t1 and is swept.
    await store.appendEvent(
      makeEvent("run-1", "task.cancelled", {
        taskId: "t2",
        data: { reason: "dependency-failed", dependency: "t1" },
      }),
    );
    // t3 is independent and succeeds.
    await store.appendEvent(
      makeEvent("run-1", "task.started", {
        taskId: "t3",
        data: { agent: "haiku", attempt: 1 },
      }),
    );
    const t3Result = makeResult("t3");
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t3",
        data: { agent: "haiku", result: t3Result, attempt: 1, final: true },
      }),
    );

    const results = await store.taskResults("run-1");
    expect([...results.keys()]).toEqual(["t1", "t2", "t3"]);
    // The escalation moved the recorded agent to the rule's target.
    expect(results.get("t1")).toMatchObject({
      agent: "opus",
      attempts: 2,
      status: "failed",
    });
    expect(results.get("t1")?.result).toEqual(finalFailure);
    expect(results.get("t2")?.status).toBe("cancelled");
    expect(results.get("t3")).toMatchObject({
      agent: "haiku",
      status: "success",
    });
    store.close();
  });

  it("creates a placeholder row when an escalation arrives before any start", async () => {
    const store = memoryStore();
    await store.appendEvent(
      makeEvent("run-1", "task.escalated", {
        taskId: "t1",
        data: { from: "sonnet", to: "opus", rule: "r1" },
      }),
    );
    const results = await store.taskResults("run-1");
    expect([...results.keys()]).toEqual(["t1"]);
    expect(results.get("t1")).toEqual({
      taskId: "t1",
      agent: "opus",
      attempts: 0,
      status: "pending",
    });
    store.close();
  });

  it("tolerates missing, oddly shaped and untyped event data", async () => {
    const store = memoryStore();
    await store.appendEvent(
      makeEvent("run-1", "task.started", { taskId: "t1" }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { agent: 42, attempt: "many", result: "not-an-object" },
      }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.escalated", { taskId: "t1", data: [1, 2, 3] }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t2",
        data: { result: { status: "bogus" } },
      }),
    );

    const results = await store.taskResults("run-1");
    expect(results.get("t1")).toMatchObject({ attempts: 0, status: "running" });
    expect(results.get("t1")?.agent).toBeUndefined();
    // An unrecognised result status leaves the row at its placeholder state.
    expect(results.get("t2")?.status).toBe("pending");
    store.close();
  });

  it("ignores events that carry no task id", async () => {
    const store = memoryStore();
    await store.appendEvent(makeEvent("run-1", "task.completed"));
    await store.appendEvent(makeEvent("run-1", "run.completed"));
    expect((await store.taskResults("run-1")).size).toBe(0);
    expect((await store.listEvents("run-1")).length).toBe(2);
    store.close();
  });
});

describe("reconstructRun", () => {
  it("splits planned tasks into completed and incomplete", async () => {
    const store = memoryStore();
    await store.createRun(runRecord());
    await store.savePlan(
      "run-1",
      makePlan([
        makeTask("t1"),
        makeTask("t2", { dependencies: ["t1"] }),
        makeTask("t3"),
        makeTask("t4"),
      ]),
    );

    const t1Result = makeResult("t1");
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { agent: "sonnet", result: t1Result, attempt: 1, final: true },
      }),
    );
    // t2 failed for good, t3 was cancelled, t4 never started.
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t2",
        data: {
          agent: "opus",
          result: makeResult("t2", { status: "failed" }),
          attempt: 2,
          final: true,
        },
      }),
    );
    await store.appendEvent(
      makeEvent("run-1", "task.cancelled", {
        taskId: "t3",
        data: { reason: "dependency-failed" },
      }),
    );

    const reconstruction = await reconstructRun(store, "run-1");
    expect(reconstruction?.run.id).toBe("run-1");
    expect([...(reconstruction?.completed.keys() ?? [])]).toEqual(["t1"]);
    expect(reconstruction?.completed.get("t1")).toEqual(t1Result);
    // A failed task is not done: it comes back as work still to do, in plan order.
    expect(reconstruction?.incompleteTaskIds).toEqual(["t2", "t3", "t4"]);
    store.close();
  });

  it("reports no outstanding tasks when no plan was saved", async () => {
    const store = memoryStore();
    await store.createRun(runRecord());
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { result: makeResult("t1"), final: true },
      }),
    );

    const reconstruction = await reconstructRun(store, "run-1");
    expect(reconstruction?.run.plan).toBeUndefined();
    expect([...(reconstruction?.completed.keys() ?? [])]).toEqual(["t1"]);
    expect(reconstruction?.incompleteTaskIds).toEqual([]);
    store.close();
  });

  it("treats a success whose result blob is corrupt as incomplete", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    await store.createRun(runRecord());
    await store.savePlan("run-1", makePlan([makeTask("t1")]));
    await store.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { result: makeResult("t1"), final: true },
      }),
    );
    store.close();

    const raw = new Database(path);
    raw
      .prepare("UPDATE task_results SET result_json = ? WHERE task_id = ?")
      .run("{not json", "t1");
    raw.close();

    const reopened = new SqliteSessionStore({ path });
    const results = await reopened.taskResults("run-1");
    expect(results.get("t1")?.status).toBe("success");
    expect(results.get("t1")?.result).toBeUndefined();
    const reconstruction = await reconstructRun(reopened, "run-1");
    expect(reconstruction?.completed.size).toBe(0);
    expect(reconstruction?.incompleteTaskIds).toEqual(["t1"]);
    reopened.close();
  });
});

describe("SqliteSessionStore corrupt rows", () => {
  it("reads a run whose policy, plan and event data blobs are unparseable", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    await store.createRun(runRecord());
    await store.savePlan("run-1", makePlan([makeTask("t1")]));
    await store.appendEvent(
      makeEvent("run-1", "run.started", { id: "corrupt-data" }),
    );
    store.close();

    const raw = new Database(path);
    raw
      .prepare("UPDATE runs SET policy_json = ?, plan_json = ?")
      .run("{oops", "[[[");
    raw
      .prepare("UPDATE events SET data_json = ? WHERE id = ?")
      .run("{oops", "corrupt-data");
    raw.close();

    const reopened = new SqliteSessionStore({ path });
    const run = await reopened.getRun("run-1");
    expect(run?.id).toBe("run-1");
    expect(run?.policy).toEqual({});
    expect(run?.plan).toBeUndefined();

    const [event] = await reopened.listEvents("run-1");
    expect(event?.id).toBe("corrupt-data");
    expect(event && "data" in event).toBe(false);

    // A corrupt plan simply drops the "total" from the summary counts.
    const [summary] = await reopened.listRuns();
    expect(summary?.taskCounts.total).toBeUndefined();
    reopened.close();
  });
});

describe("SqliteSessionStore listRuns", () => {
  it("returns runs newest first with task counts and honours a limit", async () => {
    const store = memoryStore();
    await store.createRun(runRecord({ id: "old", createdAt: 100 }));
    await store.createRun(runRecord({ id: "mid", createdAt: 200 }));
    await store.createRun(runRecord({ id: "new", createdAt: 300 }));

    await store.savePlan(
      "mid",
      makePlan([makeTask("t1"), makeTask("t2"), makeTask("t3")]),
    );
    await store.appendEvent(
      makeEvent("mid", "task.completed", {
        taskId: "t1",
        data: { result: makeResult("t1"), final: true },
      }),
    );
    await store.appendEvent(
      makeEvent("mid", "task.completed", {
        taskId: "t2",
        data: { result: makeResult("t2", { status: "failed" }), final: true },
      }),
    );
    await store.appendEvent(
      makeEvent("mid", "task.cancelled", { taskId: "t3", data: {} }),
    );
    await store.setRunStatus("mid", "failed");

    const all = await store.listRuns();
    expect(all.map((run) => run.id)).toEqual(["new", "mid", "old"]);

    const mid = all[1];
    expect(mid?.status).toBe("failed");
    expect(mid?.taskCounts).toEqual({
      completed: 1,
      failed: 1,
      partial: 0,
      cancelled: 1,
      total: 3,
    });
    // Runs without a saved plan have no known total.
    expect(all[0]?.taskCounts).toEqual({
      completed: 0,
      failed: 0,
      partial: 0,
      cancelled: 0,
    });

    const limited = await store.listRuns({ limit: 2 });
    expect(limited.map((run) => run.id)).toEqual(["new", "mid"]);
    store.close();
  });

  it("counts a partial task in its own bucket rather than losing it", async () => {
    const store = memoryStore();
    await store.createRun(runRecord({ id: "run", createdAt: 100 }));
    await store.savePlan("run", makePlan([makeTask("t1"), makeTask("t2")]));
    await store.appendEvent(
      makeEvent("run", "task.completed", {
        taskId: "t1",
        data: { result: makeResult("t1", { status: "partial" }), final: true },
      }),
    );
    await store.appendEvent(
      makeEvent("run", "task.cancelled", { taskId: "t2", data: {} }),
    );

    const [summary] = await store.listRuns();
    expect(summary?.taskCounts).toEqual({
      completed: 0,
      failed: 0,
      partial: 1,
      cancelled: 1,
      total: 2,
    });
    store.close();
  });

  it("returns an empty list for an empty database", async () => {
    const store = memoryStore();
    expect(await store.listRuns()).toEqual([]);
    expect(await store.listRuns({ limit: 5 })).toEqual([]);
    store.close();
  });
});

describe("SqliteSessionStore persistence", () => {
  it("lets a second store instance read what the first wrote", async () => {
    const path = tempDbPath();
    const writer = new SqliteSessionStore({ path });
    await writer.createRun(runRecord());
    await writer.savePlan("run-1", makePlan([makeTask("t1"), makeTask("t2")]));
    await writer.appendEvent(
      makeEvent("run-1", "task.started", {
        taskId: "t1",
        data: { agent: "sonnet", attempt: 1 },
      }),
    );

    // Opened while the writer is still live: this is the cross-process case.
    const reader = new SqliteSessionStore({ path });
    expect((await reader.getRun("run-1"))?.plan?.tasks.length).toBe(2);
    expect((await reader.listEvents("run-1")).length).toBe(1);
    expect((await reader.taskResults("run-1")).get("t1")?.agent).toBe("sonnet");
    reader.close();

    await writer.appendEvent(
      makeEvent("run-1", "task.completed", {
        taskId: "t1",
        data: { agent: "sonnet", result: makeResult("t1"), attempt: 1 },
      }),
    );
    await writer.setRunStatus("run-1", "completed");
    writer.close();

    // Reopened after close: everything survived the process boundary.
    const resumed = new SqliteSessionStore({ path });
    const reconstruction = await reconstructRun(resumed, "run-1");
    expect(reconstruction?.run.status).toBe("completed");
    expect(reconstruction?.completed.has("t1")).toBe(true);
    expect(reconstruction?.incompleteTaskIds).toEqual(["t2"]);
    resumed.close();
  });

  it("rejects use after close and reopens cleanly", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    await store.createRun(runRecord());
    store.close();
    await expect(store.getRun("run-1")).rejects.toThrow();

    const reopened = new SqliteSessionStore({ path });
    expect((await reopened.getRun("run-1"))?.objective).toBe("ship the thing");
    reopened.close();
  });

  it("keeps interleaved appends atomic and complete", async () => {
    const store = memoryStore();
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.appendEvent(
          makeEvent("run-1", "task.started", {
            id: `x${index}`,
            timestamp: 500,
            taskId: `t${index % 5}`,
            data: { agent: "sonnet", attempt: 1 },
          }),
        ),
      ),
    );

    expect((await store.listEvents("run-1")).length).toBe(50);
    const results = await store.taskResults("run-1");
    expect(results.size).toBe(5);
    for (const entry of results.values()) {
      expect(entry).toMatchObject({ agent: "sonnet", status: "running" });
    }
    store.close();
  });
});

describe("SessionStore parity", () => {
  const stores: readonly (readonly [string, () => SessionStore])[] = [
    ["InMemorySessionStore", () => new InMemorySessionStore()],
    ["SqliteSessionStore", () => memoryStore()],
  ];

  for (const [name, create] of stores) {
    it(`${name} satisfies create/append/list`, async () => {
      const store = create();
      await store.createRun(runRecord());
      const first = makeEvent("run-1", "run.started", { timestamp: 1 });
      const second = makeEvent("run-1", "run.completed", { timestamp: 2 });
      await store.appendEvent(first);
      await store.appendEvent(second);

      expect(await store.listEvents("run-1")).toEqual([first, second]);
      expect(await store.listEvents("other")).toEqual([]);

      if (store instanceof SqliteSessionStore) store.close();
    });
  }
});
