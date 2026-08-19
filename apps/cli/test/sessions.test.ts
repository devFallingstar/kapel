import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeTask } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeRunStore,
  fanOutSink,
  isoTime,
  openExistingRunStore,
  openRunStore,
  runStatusFor,
  sessionDbPathFor,
  storeSink,
} from "../src/sessions.js";
import {
  cleanupWorkspace,
  makeWorkspace,
  task,
} from "./orchestration-fixtures.js";

function event(type: string, id = "e1"): AgentEvent {
  return { id, runId: "run-1", timestamp: 1_700_000_000_000, type };
}

function recorder(): { sink: EventSink; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    sink: {
      emit: (received) => {
        seen.push(received.type);
      },
    },
  };
}

function runtimeTask(id: string, status: RuntimeTask["status"]): RuntimeTask {
  return { spec: task(id), status, attempts: 1 };
}

describe("fanOutSink", () => {
  it("delivers every event to every sink, in order", async () => {
    const first = recorder();
    const second = recorder();
    const sink = fanOutSink(first.sink, undefined, second.sink);

    await sink.emit(event("task.started"));
    await sink.emit(event("task.completed", "e2"));

    expect(first.seen).toEqual(["task.started", "task.completed"]);
    expect(second.seen).toEqual(["task.started", "task.completed"]);
  });

  it("keeps the renderer working when a store sink throws", async () => {
    const renderer = recorder();
    const throwing: EventSink = {
      emit: () => {
        throw new Error("database is locked");
      },
    };
    const sink = fanOutSink(renderer.sink, throwing);

    // Nothing is pending — a synchronous throw is absorbed on the spot.
    expect(sink.emit(event("task.started"))).toBeUndefined();
    expect(renderer.seen).toEqual(["task.started"]);
  });

  it("swallows a sink that rejects asynchronously", async () => {
    const renderer = recorder();
    const rejecting: EventSink = {
      emit: async () => {
        throw new Error("disk full");
      },
    };
    // The rejecting sink comes first: a later sink must still be reached.
    const sink = fanOutSink(rejecting, renderer.sink);

    await expect(sink.emit(event("task.started"))).resolves.toBeUndefined();
    expect(renderer.seen).toEqual(["task.started"]);
  });

  it("is a no-op when every sink is absent", () => {
    expect(fanOutSink(undefined, undefined).emit(event("x"))).toBeUndefined();
  });
});

describe("storeSink", () => {
  it("appends events to the store and reports nothing on failure", async () => {
    const store = new SqliteSessionStore({ path: ":memory:" });
    const sink = storeSink(store);
    await sink.emit(event("task.started"));
    expect((await store.listEvents("run-1")).map((e) => e.type)).toEqual([
      "task.started",
    ]);

    store.close();
    // A closed store rejects every write; the sink must absorb that.
    await expect(sink.emit(event("task.completed", "e2"))).resolves.toBe(
      undefined,
    );
  });

  it("keeps streamed text deltas out of the database", async () => {
    const store = new SqliteSessionStore({ path: ":memory:" });
    const sink = storeSink(store);

    await sink.emit(event("loop.started"));
    for (let i = 0; i < 5; i += 1) {
      await sink.emit(event("model.text.delta", `d${i}`));
    }
    await sink.emit(event("model.turn.completed", "e2"));

    // Only the turn-level events are replayable history; the per-token ones
    // would be thousands of rows saying what those two already say.
    expect((await store.listEvents("run-1")).map((e) => e.type)).toEqual([
      "loop.started",
      "model.turn.completed",
    ]);
    store.close();
  });
});

describe("runStatusFor", () => {
  it("is completed only when every task completed", () => {
    expect(
      runStatusFor(
        [runtimeTask("T01", "completed"), runtimeTask("T02", "completed")],
        false,
      ),
    ).toBe("completed");
    expect(
      runStatusFor(
        [runtimeTask("T01", "completed"), runtimeTask("T02", "failed")],
        false,
      ),
    ).toBe("failed");
  });

  it("reports an aborted run as cancelled regardless of task states", () => {
    expect(runStatusFor([runtimeTask("T01", "completed")], true)).toBe(
      "cancelled",
    );
  });
});

describe("store discovery", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspace("cli-sessions-test-");
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  it("does not open (or create) a database without a .agent directory", async () => {
    expect(await openRunStore(workspace)).toBeUndefined();
    expect(openExistingRunStore(workspace)).toBeUndefined();
  });

  it("opens a database under .agent, and finds it again afterwards", async () => {
    await mkdir(path.join(workspace, ".agent"), { recursive: true });

    const created = await openRunStore(workspace);
    expect(created).toBeDefined();
    await created?.createRun({
      id: "run-1",
      objective: "ship it",
      createdAt: 1,
      policySnapshot: {
        version: 1,
        orchestrator: "lead",
        maxConcurrency: 1,
        parallelizeIndependentTasks: true,
        routing: [],
        review: [],
        escalation: [],
        defaultMaxAttempts: 1,
      },
    });
    closeRunStore(created);

    expect(sessionDbPathFor(workspace)).toBe(
      path.join(workspace, ".agent", "sessions.db"),
    );
    const reopened = openExistingRunStore(workspace);
    expect((await reopened?.getRun("run-1"))?.objective).toBe("ship it");
    closeRunStore(reopened);
  });
});

describe("isoTime", () => {
  it("renders epoch milliseconds as ISO-8601", () => {
    expect(isoTime(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
