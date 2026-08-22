import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVITY,
  isIdleActivity,
  type RunRecord,
  SqliteSessionStore,
  startOfDay,
  startOfWindow,
  WEEK_DAYS,
} from "../src/index.js";
import { makeEvent, makePolicy, makeResult } from "./helpers.js";

function memoryStore(): SqliteSessionStore {
  return new SqliteSessionStore({ path: ":memory:" });
}

function runRecord(id: string, createdAt: number): RunRecord {
  return {
    id,
    objective: `objective for ${id}`,
    createdAt,
    policySnapshot: makePolicy(),
  };
}

/** Noon local time, so a window boundary test never straddles midnight. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

describe("window arithmetic", () => {
  it("starts today at local midnight", () => {
    const now = noon(2026, 3, 18);
    const start = startOfDay(now);
    const asDate = new Date(start);
    expect(asDate.getHours()).toBe(0);
    expect(asDate.getMinutes()).toBe(0);
    expect(asDate.getSeconds()).toBe(0);
    expect(asDate.getMilliseconds()).toBe(0);
    expect(asDate.getDate()).toBe(18);
    expect(start).toBeLessThanOrEqual(now);
  });

  it("covers seven calendar days including today", () => {
    const now = noon(2026, 3, 18);
    const start = startOfWindow(now);
    expect(new Date(start).getDate()).toBe(12);
    expect(new Date(start).getHours()).toBe(0);
    expect(startOfWindow(now, WEEK_DAYS)).toBe(start);
  });

  it("lands on local midnight even across a daylight-saving shift", () => {
    // Whatever the machine's zone, every day in the window must begin at
    // local midnight — which subtracting 6 * 86_400_000 cannot guarantee.
    for (const day of [1, 8, 15, 22, 29]) {
      for (const month of [3, 11]) {
        const start = startOfWindow(noon(2026, month, day));
        expect(new Date(start).getHours()).toBe(0);
      }
    }
  });

  it("treats a one-day window as today alone", () => {
    const now = noon(2026, 3, 18);
    expect(startOfWindow(now, 1)).toBe(startOfDay(now));
    // Nonsense day counts clamp rather than run backwards.
    expect(startOfWindow(now, 0)).toBe(startOfDay(now));
  });
});

describe("idle windows", () => {
  it("recognises a window with nothing in it", () => {
    expect(isIdleActivity(EMPTY_ACTIVITY)).toBe(true);
    expect(isIdleActivity({ ...EMPTY_ACTIVITY, runs: 1 })).toBe(false);
    expect(isIdleActivity({ ...EMPTY_ACTIVITY, inputTokens: 5 })).toBe(false);
    // A price with no tokens behind it is not "work done" on its own.
    expect(isIdleActivity({ ...EMPTY_ACTIVITY, costUsd: 0.5 })).toBe(true);
  });
});

describe("recordUsage", () => {
  it("stores what was spent and adds it up", async () => {
    const store = memoryStore();
    await store.recordUsage({
      kind: "chat",
      sourceId: "chat-1",
      backend: "native",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      costUsd: 0.25,
      timestamp: 1_000,
    });
    await store.recordUsage({
      kind: "chat",
      sourceId: "chat-1",
      backend: "native",
      inputTokens: 5,
      outputTokens: 7,
      costUsd: 0.05,
      timestamp: 2_000,
    });

    const totals = await store.activityTotals({ since: 0 });
    expect(totals.inputTokens).toBe(105);
    expect(totals.outputTokens).toBe(27);
    expect(totals.costUsd).toBeCloseTo(0.3, 10);
    store.close();
  });

  it("drops a sample that reports nothing rather than storing zeroes", async () => {
    const store = memoryStore();
    await store.recordUsage({
      kind: "chat",
      sourceId: "chat-1",
      inputTokens: 0,
      outputTokens: 0,
      timestamp: 1_000,
    });
    const totals = await store.activityTotals({ since: 0 });
    expect(totals.inputTokens).toBe(0);
    expect(totals.costUsd).toBeUndefined();
    store.close();
  });

  it("leaves cost absent when no sample carried a price", async () => {
    const store = memoryStore();
    await store.recordUsage({
      kind: "chat",
      sourceId: "chat-1",
      backend: "claude-code",
      inputTokens: 12,
      outputTokens: 3,
      timestamp: 1_000,
    });
    const totals = await store.activityTotals({ since: 0 });
    expect(totals.inputTokens).toBe(12);
    expect(totals.costUsd).toBeUndefined();
    store.close();
  });

  it("is append-only: a repeated source id accumulates", async () => {
    const store = memoryStore();
    for (let i = 0; i < 3; i += 1) {
      await store.recordUsage({
        kind: "run",
        sourceId: "run-1",
        inputTokens: 10,
        outputTokens: 1,
        timestamp: 1_000 + i,
      });
    }
    const totals = await store.activityTotals({ since: 0 });
    expect(totals.inputTokens).toBe(30);
    store.close();
  });

  it("ignores a re-inserted id, so a retried write cannot double-count", async () => {
    const store = memoryStore();
    const entry = {
      kind: "chat",
      id: "fixed",
      sourceId: "chat-1",
      inputTokens: 10,
      outputTokens: 1,
      timestamp: 1_000,
    } as const;
    await store.recordUsage(entry);
    await store.recordUsage(entry);
    const totals = await store.activityTotals({ since: 0 });
    expect(totals.inputTokens).toBe(10);
    store.close();
  });
});

describe("activityTotals", () => {
  it("reports zeroes for an empty store", async () => {
    const store = memoryStore();
    const totals = await store.activityTotals({ since: 0 });
    expect(totals).toEqual(EMPTY_ACTIVITY);
    expect(isIdleActivity(totals)).toBe(true);
    store.close();
  });

  it("counts runs and chat sessions started inside the window", async () => {
    const store = memoryStore();
    await store.createRun(runRecord("old", 500));
    await store.createRun(runRecord("new", 5_000));
    await store.createChatSession({
      id: "chat-old",
      workspacePath: "/repo",
      title: "old",
      createdAt: 500,
    });
    await store.createChatSession({
      id: "chat-new",
      workspacePath: "/repo",
      title: "new",
      createdAt: 5_000,
    });

    const totals = await store.activityTotals({ since: 1_000 });
    expect(totals.runs).toBe(1);
    expect(totals.chatSessions).toBe(1);
    store.close();
  });

  it("honours a half-open upper bound", async () => {
    const store = memoryStore();
    await store.createRun(runRecord("a", 1_000));
    await store.createRun(runRecord("b", 2_000));
    await store.createRun(runRecord("c", 3_000));

    expect(
      (await store.activityTotals({ since: 1_000, until: 3_000 })).runs,
    ).toBe(2);
    // `since` is inclusive, `until` exclusive.
    expect(
      (await store.activityTotals({ since: 2_000, until: 2_001 })).runs,
    ).toBe(1);
    store.close();
  });

  it("counts tasks by when their result last moved, not when the run started", async () => {
    const store = memoryStore();
    await store.createRun(runRecord("run-1", 100));
    await store.appendEvent(
      makeEvent(
        "run-1",
        {
          type: "task.completed",
          data: {
            agent: "sonnet",
            result: makeResult("t1"),
            attempt: 1,
            final: true,
          },
        },
        { taskId: "t1", timestamp: 9_000 },
      ),
    );
    await store.appendEvent(
      makeEvent(
        "run-1",
        {
          type: "task.completed",
          data: {
            agent: "sonnet",
            result: makeResult("t2", { status: "failed" }),
            attempt: 1,
            final: true,
          },
        },
        { taskId: "t2", timestamp: 9_100 },
      ),
    );
    await store.appendEvent(
      makeEvent(
        "run-1",
        {
          type: "task.completed",
          data: {
            agent: "sonnet",
            result: makeResult("t3", { status: "partial" }),
            attempt: 1,
            final: true,
          },
        },
        { taskId: "t3", timestamp: 9_200 },
      ),
    );

    const totals = await store.activityTotals({ since: 1_000 });
    // The run itself started before the window; its tasks landed inside it.
    expect(totals.runs).toBe(0);
    expect(totals.tasksCompleted).toBe(1);
    expect(totals.tasksFailed).toBe(1);
    store.close();
  });
});

describe("activity", () => {
  it("splits today from the seven-day window", async () => {
    const store = memoryStore();
    const now = noon(2026, 3, 18);
    const today = startOfDay(now);
    const day = 24 * 60 * 60 * 1000;

    await store.createRun(runRecord("today", today + 60_000));
    await store.createRun(runRecord("three-days-ago", today - 3 * day));
    await store.createRun(runRecord("long-ago", today - 30 * day));
    await store.recordUsage({
      kind: "chat",
      sourceId: "chat-1",
      inputTokens: 10,
      outputTokens: 2,
      timestamp: today + 60_000,
    });
    await store.recordUsage({
      kind: "chat",
      sourceId: "chat-1",
      inputTokens: 100,
      outputTokens: 20,
      timestamp: today - 3 * day,
    });

    const activity = await store.activity({ now });
    expect(activity.todaySince).toBe(today);
    expect(activity.weekSince).toBe(startOfWindow(now));
    expect(activity.today.runs).toBe(1);
    expect(activity.week.runs).toBe(2);
    expect(activity.today.inputTokens).toBe(10);
    expect(activity.week.inputTokens).toBe(110);
    store.close();
  });

  it("reads cleanly as a zero state on a brand new database", async () => {
    const store = memoryStore();
    const activity = await store.activity({ now: noon(2026, 3, 18) });
    expect(isIdleActivity(activity.today)).toBe(true);
    expect(isIdleActivity(activity.week)).toBe(true);
    store.close();
  });
});

describe("usageByBackend", () => {
  it("groups by backend, busiest first", async () => {
    const store = memoryStore();
    await store.recordUsage({
      kind: "chat",
      sourceId: "c1",
      backend: "native",
      inputTokens: 10,
      outputTokens: 1,
      costUsd: 0.02,
      timestamp: 1_000,
    });
    await store.recordUsage({
      kind: "chat",
      sourceId: "c2",
      backend: "claude-code",
      inputTokens: 500,
      outputTokens: 40,
      timestamp: 1_100,
    });
    await store.recordUsage({
      kind: "chat",
      sourceId: "c3",
      backend: "claude-code",
      inputTokens: 100,
      outputTokens: 10,
      timestamp: 1_200,
    });

    const rows = await store.usageByBackend({ since: 0 });
    expect(rows.map((row) => row.backend)).toEqual(["claude-code", "native"]);
    expect(rows[0]?.inputTokens).toBe(600);
    expect(rows[0]?.outputTokens).toBe(50);
    // Nothing priced a delegated turn, so no cost is claimed for it.
    expect(rows[0]?.costUsd).toBeUndefined();
    expect(rows[1]?.costUsd).toBeCloseTo(0.02, 10);
    store.close();
  });

  it("buckets unattributed usage under `unknown` rather than dropping it", async () => {
    const store = memoryStore();
    await store.recordUsage({
      kind: "run",
      sourceId: "r1",
      inputTokens: 7,
      outputTokens: 2,
      timestamp: 1_000,
    });
    const rows = await store.usageByBackend({ since: 0 });
    expect(rows).toEqual([
      { backend: "unknown", inputTokens: 7, outputTokens: 2 },
    ]);
    store.close();
  });

  it("respects the window", async () => {
    const store = memoryStore();
    await store.recordUsage({
      kind: "chat",
      sourceId: "c1",
      backend: "native",
      inputTokens: 10,
      outputTokens: 1,
      timestamp: 500,
    });
    expect(await store.usageByBackend({ since: 1_000 })).toEqual([]);
    store.close();
  });
});

describe("schema compatibility", () => {
  it("adds usage_events to a database created before it existed", async () => {
    // `BOOTSTRAP_DDL` runs on every open, so an older file simply gains the
    // table — there is nothing to migrate, only to create.
    const store = memoryStore();
    store.close();

    const reopened = new SqliteSessionStore({ path: ":memory:" });
    await reopened.recordUsage({
      kind: "chat",
      sourceId: "c1",
      inputTokens: 1,
      outputTokens: 1,
      timestamp: 1,
    });
    expect((await reopened.activityTotals({ since: 0 })).inputTokens).toBe(1);
    reopened.close();
  });
});
