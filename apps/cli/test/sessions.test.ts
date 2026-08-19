import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeTask } from "@agent/coding-agent";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeRunStore,
  DEFAULT_SESSIONS_LIST_LIMIT,
  fanOutSink,
  isoTime,
  openExistingRunStore,
  openRunStore,
  runSessionsForkCommand,
  runSessionsListCommand,
  runStatusFor,
  sessionDbPathFor,
  storeSink,
} from "../src/sessions.js";
import {
  capture,
  cleanupWorkspace,
  makeWorkspace,
  makeWorkspaceWithAgentDir,
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

describe("runSessionsListCommand", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspaceWithAgentDir("cli-sessions-list-test-");
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  it("reports no database as an empty listing, not an error", async () => {
    const empty = await makeWorkspace("cli-sessions-list-empty-");
    try {
      const { output, lines } = capture();
      const code = await runSessionsListCommand(
        { cwd: empty, json: false },
        { output },
      );
      expect(code).toBe(0);
      expect(lines[0]).toMatch(/No chat sessions recorded yet/);

      const { output: jsonOutput, lines: jsonLines } = capture();
      await runSessionsListCommand(
        { cwd: empty, json: true },
        { output: jsonOutput },
      );
      expect(JSON.parse(jsonLines[0] as string)).toEqual([]);
    } finally {
      await cleanupWorkspace(empty);
    }
  });

  it("lists sessions newest-touched first, without a NAME column when none are named", async () => {
    const store = await openRunStore(workspace);
    await store?.createChatSession({
      id: "session-a",
      workspacePath: path.resolve(workspace),
      title: "first",
      createdAt: 1,
    });
    await store?.createChatSession({
      id: "session-b",
      workspacePath: path.resolve(workspace),
      title: "second",
      createdAt: 2,
    });
    closeRunStore(store);

    const { output, lines } = capture();
    const code = await runSessionsListCommand(
      { cwd: workspace, json: false },
      { output },
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^ID\s+UPDATED\s+MSGS\s+TITLE$/);
    // Most recently created (and thus touched) session lists first.
    expect(lines[1]).toContain("second");
    expect(lines[2]).toContain("first");
  });

  it("shows a NAME column once any session is named", async () => {
    const store = await openRunStore(workspace);
    await store?.createChatSession({
      id: "session-a",
      workspacePath: path.resolve(workspace),
      title: "first",
      createdAt: 1,
    });
    await store?.createChatSession({
      id: "session-b",
      workspacePath: path.resolve(workspace),
      title: "second",
      name: "release notes",
      createdAt: 2,
    });
    closeRunStore(store);

    const { output, lines } = capture();
    await runSessionsListCommand({ cwd: workspace, json: false }, { output });
    expect(lines[0]).toMatch(/^ID\s+NAME\s+UPDATED\s+MSGS\s+TITLE$/);
    expect(lines[1]).toContain("release notes");
  });

  it("emits JSON with name only for sessions that have one", async () => {
    const store = await openRunStore(workspace);
    await store?.createChatSession({
      id: "session-a",
      workspacePath: path.resolve(workspace),
      title: "first",
      name: "named",
      createdAt: 1,
    });
    await store?.createChatSession({
      id: "session-b",
      workspacePath: path.resolve(workspace),
      title: "second",
      createdAt: 2,
    });
    closeRunStore(store);

    const { output, lines } = capture();
    await runSessionsListCommand({ cwd: workspace, json: true }, { output });
    const parsed = JSON.parse(lines[0] as string) as readonly Record<
      string,
      unknown
    >[];
    expect(parsed).toHaveLength(2);
    expect(parsed.find((r) => r.id === "session-a")?.name).toBe("named");
    expect("name" in (parsed.find((r) => r.id === "session-b") ?? {})).toBe(
      false,
    );
  });

  it("honours --limit", async () => {
    const store = await openRunStore(workspace);
    for (let i = 0; i < 5; i += 1) {
      await store?.createChatSession({
        id: `s${i}`,
        workspacePath: path.resolve(workspace),
        title: `session ${i}`,
        createdAt: 100 + i,
      });
    }
    closeRunStore(store);

    const { output, lines } = capture();
    await runSessionsListCommand(
      { cwd: workspace, json: false, limit: 2 },
      { output },
    );
    // header + 2 rows
    expect(lines).toHaveLength(3);
  });

  it("defaults the limit to DEFAULT_SESSIONS_LIST_LIMIT", () => {
    expect(DEFAULT_SESSIONS_LIST_LIMIT).toBeGreaterThan(0);
  });
});

describe("runSessionsForkCommand", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspaceWithAgentDir("cli-sessions-fork-test-");
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  async function seedSession(): Promise<void> {
    const store = await openRunStore(workspace);
    await store?.createChatSession({
      id: "source-session",
      workspacePath: path.resolve(workspace),
      title: "original conversation",
      modelAlias: "sonnet",
      createdAt: 1,
    });
    await store?.appendChatMessages("source-session", [
      { seq: 0, message: { role: "user", content: "hello" } },
      { seq: 1, message: { role: "assistant", content: "hi" } },
    ]);
    closeRunStore(store);
  }

  it("reports no database as an error", async () => {
    const empty = await makeWorkspace("cli-sessions-fork-empty-");
    try {
      const { output, errLines } = capture();
      const code = await runSessionsForkCommand(
        { cwd: empty, json: false, session: "anything" },
        { output },
      );
      expect(code).toBe(1);
      expect(errLines[0]).toMatch(/No chat sessions recorded yet/);
    } finally {
      await cleanupWorkspace(empty);
    }
  });

  it("forks by id prefix, copying the transcript into a new independent session", async () => {
    await seedSession();

    const { output, lines } = capture();
    const code = await runSessionsForkCommand(
      { cwd: workspace, json: false, session: "source-sess" },
      { output },
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/Forked/);

    const store = await openRunStore(workspace);
    const listed = await store?.listChatSessions(path.resolve(workspace));
    expect(listed).toHaveLength(2);
    const forkedRecord = listed?.find((r) => r.id !== "source-session");
    expect(forkedRecord).toMatchObject({
      title: "original conversation",
      modelAlias: "sonnet",
      messageCount: 2,
    });
    const forkedTranscript = await store?.loadChatSession(
      forkedRecord?.id as string,
    );
    expect(forkedTranscript?.messages.map((m) => m.content)).toEqual([
      "hello",
      "hi",
    ]);
    closeRunStore(store);
  });

  it("names the fork with --name and reports it as JSON", async () => {
    await seedSession();

    const { output, lines } = capture();
    await runSessionsForkCommand(
      {
        cwd: workspace,
        json: true,
        session: "source-session",
        name: "branch a",
      },
      { output },
    );
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.forkedFrom).toBe("source-session");
    expect(parsed.name).toBe("branch a");

    const store = await openRunStore(workspace);
    const forked = await store?.loadChatSession(parsed.id as string);
    expect(forked?.record.name).toBe("branch a");
    closeRunStore(store);
  });

  it("forks by exact name", async () => {
    await seedSession();
    const store = await openRunStore(workspace);
    await store?.renameChatSession("source-session", "pick me");
    closeRunStore(store);

    const { output } = capture();
    const code = await runSessionsForkCommand(
      { cwd: workspace, json: false, session: "pick me" },
      { output },
    );
    expect(code).toBe(0);
  });

  it("errors when the reference does not resolve", async () => {
    await seedSession();

    const { output, errLines } = capture();
    const code = await runSessionsForkCommand(
      { cwd: workspace, json: false, session: "does-not-exist" },
      { output },
    );
    expect(code).toBe(1);
    expect(errLines[0]).toMatch(/No chat session matches/);
  });

  it("does not mutate the source session", async () => {
    await seedSession();

    const { output } = capture();
    await runSessionsForkCommand(
      { cwd: workspace, json: false, session: "source-session" },
      { output },
    );

    const store = await openRunStore(workspace);
    const original = await store?.loadChatSession("source-session");
    expect(original?.messages.map((m) => m.content)).toEqual(["hello", "hi"]);
    expect(original?.record.messageCount).toBe(2);
    closeRunStore(store);
  });
});
