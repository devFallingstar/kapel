import type { ModelMessage } from "@agent/ai";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  type BackendChatEntry,
  BackendChatSession,
  type BackendChatSessionOptions,
  type BackendTurnOutcome,
  type BackendTurnRequest,
  backendTurnRunner,
  type DelegatingBackendLike,
} from "../src/backend-chat.js";

// --- fakes -----------------------------------------------------------------

/** Runner that records every request and replays a scripted queue of outcomes. */
class RecordingRunner {
  readonly requests: BackendTurnRequest[] = [];
  readonly #outcomes: BackendTurnOutcome[];

  constructor(outcomes: readonly BackendTurnOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  run = async (request: BackendTurnRequest): Promise<BackendTurnOutcome> => {
    this.requests.push(request);
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) throw new Error("runner exhausted");
    return outcome;
  };
}

class CollectingSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }
}

function ok(
  summary: string,
  extra: Partial<BackendTurnOutcome> = {},
): BackendTurnOutcome {
  return { status: "success", summary, ...extra };
}

function options(
  runner: BackendChatSessionOptions["runner"],
  extra: Partial<BackendChatSessionOptions> = {},
): BackendChatSessionOptions {
  return {
    runner,
    runId: "run-1",
    workspacePath: "/workspace",
    ...extra,
  };
}

// --- transcript vs continuation --------------------------------------------

describe("BackendChatSession (stateless mode)", () => {
  it("passes the prior transcript and no sessionRef on later turns", async () => {
    const runner = new RecordingRunner([
      ok("hello back", { sessionRef: "sess-1" }),
      ok("second reply"),
    ]);
    const session = new BackendChatSession(options(runner.run));

    await session.send("first");
    await session.send("second");

    const first = runner.requests[0];
    const second = runner.requests[1];
    expect(first?.transcript).toEqual([]);
    expect(first?.sessionRef).toBeUndefined();
    expect(second?.instruction).toBe("second");
    expect(second?.sessionRef).toBeUndefined();
    expect(
      second?.transcript.map((entry) => [entry.role, entry.content]),
    ).toEqual([
      ["user", "first"],
      ["assistant", "hello back"],
    ]);
  });

  it("forwards run context and the caller's signal", async () => {
    const runner = new RecordingRunner([ok("done")]);
    const session = new BackendChatSession(options(runner.run));
    const controller = new AbortController();

    await session.send("go", { signal: controller.signal, taskId: "task-9" });

    expect(runner.requests[0]?.context).toEqual({
      runId: "run-1",
      workspacePath: "/workspace",
      taskId: "task-9",
      signal: controller.signal,
    });
  });

  it("attaches image paths to the turn that sent them, and to no other", async () => {
    const runner = new RecordingRunner([ok("looked"), ok("and then")]);
    const session = new BackendChatSession(options(runner.run));

    await session.send("look at this", undefined, ["/repo/shot.png"]);
    await session.send("now fix it");

    expect(runner.requests[0]?.imagePaths).toEqual(["/repo/shot.png"]);
    // The attachment belongs to one turn: the transcript replays the text
    // (whose annotation line already names the file), not the attachment.
    expect(runner.requests[1]?.imagePaths).toBeUndefined();
  });

  it("caps the transcript at transcriptTurns entries", async () => {
    const runner = new RecordingRunner([
      ok("a1"),
      ok("a2"),
      ok("a3"),
      ok("a4"),
    ]);
    const session = new BackendChatSession(
      options(runner.run, { transcriptTurns: 3 }),
    );

    await session.send("u1");
    await session.send("u2");
    await session.send("u3");
    await session.send("u4");

    // Six prior entries exist before turn 4; only the last three travel.
    expect(
      runner.requests[3]?.transcript.map((entry) => entry.content),
    ).toEqual(["a2", "u3", "a3"]);
  });

  it("sends no transcript when transcriptTurns is zero", async () => {
    const runner = new RecordingRunner([ok("a1"), ok("a2")]);
    const session = new BackendChatSession(
      options(runner.run, { transcriptTurns: 0 }),
    );

    await session.send("u1");
    await session.send("u2");

    expect(runner.requests[1]?.transcript).toEqual([]);
  });
});

describe("BackendChatSession (continuation mode)", () => {
  it("passes the sessionRef and an empty transcript once one is known", async () => {
    const runner = new RecordingRunner([
      ok("hello back", { sessionRef: "sess-1" }),
      ok("second reply", { sessionRef: "sess-1" }),
    ]);
    const session = new BackendChatSession(
      options(runner.run, { supportsContinuation: true }),
    );

    await session.send("first");
    expect(runner.requests[0]?.sessionRef).toBeUndefined();
    expect(session.sessionRef()).toBe("sess-1");

    await session.send("second");
    expect(runner.requests[1]?.sessionRef).toBe("sess-1");
    expect(runner.requests[1]?.transcript).toEqual([]);
  });

  it("falls back to the transcript when the backend reported no session id", async () => {
    const runner = new RecordingRunner([ok("a1"), ok("a2")]);
    const session = new BackendChatSession(
      options(runner.run, { supportsContinuation: true }),
    );

    await session.send("u1");
    await session.send("u2");

    expect(session.sessionRef()).toBeUndefined();
    expect(runner.requests[1]?.transcript).toHaveLength(2);
  });
});

// --- entries, restore, model messages ---------------------------------------

describe("BackendChatSession history", () => {
  it("records user and assistant entries and copies them defensively", async () => {
    const runner = new RecordingRunner([ok("reply", { output: "full text" })]);
    const session = new BackendChatSession(options(runner.run));

    await session.send("ask");
    const entries = session.entries();

    expect(entries.map((entry) => [entry.role, entry.content])).toEqual([
      ["user", "ask"],
      ["assistant", "full text"],
    ]);
    (entries as BackendChatEntry[]).push({
      role: "user",
      content: "tampered",
      at: 0,
    });
    expect(session.entries()).toHaveLength(2);
  });

  it("round-trips through restore, including the sessionRef", async () => {
    const first = new BackendChatSession(
      options(new RecordingRunner([ok("a1", { sessionRef: "sess-7" })]).run, {
        supportsContinuation: true,
      }),
    );
    await first.send("u1");

    const runner = new RecordingRunner([ok("a2")]);
    const restored = BackendChatSession.restore(
      options(runner.run, { supportsContinuation: true }),
      first.entries(),
      first.sessionRef(),
    );

    expect(restored.entries()).toEqual(first.entries());
    expect(restored.sessionRef()).toBe("sess-7");

    await restored.send("u2");
    expect(runner.requests[0]?.sessionRef).toBe("sess-7");
  });

  it("continues turn numbering after restore", async () => {
    const sink = new CollectingSink();
    const runner = new RecordingRunner([ok("a2")]);
    const restored = BackendChatSession.restore(
      options(runner.run, { events: sink }),
      [
        { role: "user", content: "u1", at: 1 },
        { role: "assistant", content: "a1", at: 2 },
      ],
    );

    await restored.send("u2");

    expect(sink.events[0]?.data).toMatchObject({ turn: 2 });
  });

  it("round-trips model messages, dropping system and tool messages", () => {
    const messages: readonly ModelMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", input: {} }],
      },
      { role: "tool", toolCallId: "c1", content: "file contents" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];

    const session = BackendChatSession.fromModelMessages(
      options(new RecordingRunner([]).run),
      messages,
      "sess-3",
    );

    expect(session.toModelMessages()).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
    expect(session.sessionRef()).toBe("sess-3");

    const again = BackendChatSession.fromModelMessages(
      options(new RecordingRunner([]).run),
      session.toModelMessages(),
    );
    expect(again.toModelMessages()).toEqual(session.toModelMessages());
  });
});

// --- failure, cancellation, single flight -----------------------------------

describe("BackendChatSession failure handling", () => {
  it("rejects a concurrent send", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new BackendChatSession(
      options(async () => {
        await gate;
        return ok("done");
      }),
    );

    const first = session.send("one");
    await expect(session.send("two")).rejects.toThrow(/already in flight/);
    release?.();
    await first;
  });

  it("turns a failed outcome into a failed result without throwing", async () => {
    const session = new BackendChatSession(
      options(async () => ({ status: "failed", summary: "exit code 1" })),
    );

    const result = await session.send("break it");

    expect(result).toMatchObject({ status: "failed", summary: "exit code 1" });
    expect(session.entries().map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("records no assistant entry when a failed outcome carried no text", async () => {
    const session = new BackendChatSession(
      options(async () => ({ status: "failed", summary: "" })),
    );

    const result = await session.send("break it");

    expect(result.status).toBe("failed");
    expect(session.entries().map((entry) => entry.content)).toEqual([
      "break it",
    ]);
  });

  it("keeps the user entry when the runner throws", async () => {
    const session = new BackendChatSession(
      options(async () => {
        throw new Error("claude binary not found");
      }),
    );

    const result = await session.send("hello");

    expect(result).toEqual({
      status: "failed",
      summary: "claude binary not found",
    });
    expect(session.entries()).toHaveLength(1);
    expect(session.entries()[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });

  it("reports a cancellation when the signal is already aborted", async () => {
    const runner = new RecordingRunner([ok("never")]);
    const session = new BackendChatSession(options(runner.run));
    const controller = new AbortController();
    controller.abort();

    const result = await session.send("go", { signal: controller.signal });

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cancelled/i);
    expect(runner.requests).toHaveLength(0);
    expect(session.entries()).toHaveLength(1);
  });

  it("reports a cancellation when the runner aborts mid-turn", async () => {
    const controller = new AbortController();
    const session = new BackendChatSession(
      options(async () => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }),
    );

    const result = await session.send("go", { signal: controller.signal });

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cancelled/i);
    expect(session.entries().map((entry) => entry.role)).toEqual(["user"]);
  });

  it("survives a sink that throws", async () => {
    const session = new BackendChatSession(
      options(async () => ok("fine"), {
        events: {
          emit() {
            throw new Error("sink is gone");
          },
        },
      }),
    );

    await expect(session.send("hi")).resolves.toMatchObject({
      status: "success",
    });
  });
});

// --- events ------------------------------------------------------------------

describe("BackendChatSession events", () => {
  it("emits chat.turn.* with turn numbers and the run envelope", async () => {
    const sink = new CollectingSink();
    const runner = new RecordingRunner([ok("a1"), ok("a2")]);
    const session = new BackendChatSession(
      options(runner.run, { events: sink }),
    );

    await session.send("u1", { taskId: "task-1" });
    await session.send("u2", { taskId: "task-1" });

    expect(sink.events.map((event) => event.type)).toEqual([
      "chat.turn.started",
      "chat.turn.completed",
      "chat.turn.started",
      "chat.turn.completed",
    ]);
    expect(sink.events[0]?.data).toEqual({ turn: 1, backend: "delegated" });
    expect(sink.events[1]?.data).toEqual({ turn: 1, status: "success" });
    expect(sink.events[2]?.data).toEqual({ turn: 2, backend: "delegated" });
    for (const event of sink.events) {
      expect(event.runId).toBe("run-1");
      expect(event.taskId).toBe("task-1");
      expect(typeof event.id).toBe("string");
      expect(typeof event.timestamp).toBe("number");
    }
  });

  it("reports a failed status on the completed event", async () => {
    const sink = new CollectingSink();
    const session = new BackendChatSession(
      options(async () => ({ status: "partial", summary: "ran out of time" }), {
        events: sink,
      }),
    );

    await session.send("u1");

    expect(sink.events[1]?.data).toEqual({ turn: 1, status: "partial" });
    expect(sink.events[0]?.taskId).toBeUndefined();
  });
});

// --- the backend adapter -----------------------------------------------------

describe("backendTurnRunner", () => {
  interface BackendInput {
    instruction: string;
    context?: readonly string[];
    imagePaths?: readonly string[];
  }

  class FakeBackend implements DelegatingBackendLike {
    readonly calls: {
      input: BackendInput;
      context: Record<string, unknown>;
    }[] = [];

    async run(
      input: BackendInput,
      context: {
        runId: string;
        taskId?: string;
        workspacePath: string;
        signal?: AbortSignal;
      },
    ) {
      this.calls.push({ input, context });
      return {
        status: "success" as const,
        summary: "did the thing",
        output: "long output",
        sessionId: "sess-42",
        usage: { inputTokens: 10, outputTokens: 20 },
        costUsd: 0.5,
      };
    }
  }

  const request = (
    extra: Partial<BackendTurnRequest> = {},
  ): BackendTurnRequest => ({
    instruction: "do it",
    transcript: [],
    context: { runId: "run-1", workspacePath: "/workspace" },
    ...extra,
  });

  it("maps sessionId to sessionRef and passes usage through", async () => {
    const backend = new FakeBackend();
    const outcome = await backendTurnRunner(backend)(request());

    expect(outcome).toEqual({
      status: "success",
      summary: "did the thing",
      output: "long output",
      sessionRef: "sess-42",
      usage: { inputTokens: 10, outputTokens: 20 },
      costUsd: 0.5,
    });
    expect(backend.calls[0]?.input.context).toBeUndefined();
  });

  it("renders the transcript into a prompt context entry", async () => {
    const backend = new FakeBackend();
    await backendTurnRunner(backend)(
      request({
        transcript: [
          { role: "user", content: "u1", at: 1 },
          { role: "assistant", content: "a1", at: 2 },
        ],
      }),
    );

    expect(backend.calls[0]?.input.context).toEqual([
      "Earlier in this conversation:\nuser: u1\nassistant: a1",
    ]);
  });

  it("caps each rendered transcript entry", async () => {
    const backend = new FakeBackend();
    await backendTurnRunner(backend)(
      request({
        transcript: [{ role: "user", content: "x".repeat(5000), at: 1 }],
      }),
    );

    const rendered = backend.calls[0]?.input.context?.[0] ?? "";
    expect(rendered.length).toBeLessThan(2100);
    expect(rendered.endsWith("…")).toBe(true);
  });

  it("omits the transcript when promptWithTranscript is false", async () => {
    const backend = new FakeBackend();
    await backendTurnRunner(backend, { promptWithTranscript: false })(
      request({ transcript: [{ role: "user", content: "u1", at: 1 }] }),
    );

    expect(backend.calls[0]?.input.context).toBeUndefined();
  });

  it("forwards attached image paths to the backend, and omits them otherwise", async () => {
    const backend = new FakeBackend();
    const runner = backendTurnRunner(backend);

    await runner(request({ imagePaths: ["/repo/a.png", "/repo/b.png"] }));
    await runner(request());

    expect(backend.calls[0]?.input.imagePaths).toEqual([
      "/repo/a.png",
      "/repo/b.png",
    ]);
    expect(backend.calls[1]?.input.imagePaths).toBeUndefined();
  });

  it("forwards taskId and signal to the backend run context", async () => {
    const backend = new FakeBackend();
    const controller = new AbortController();
    await backendTurnRunner(backend)(
      request({
        context: {
          runId: "run-2",
          workspacePath: "/ws",
          taskId: "task-3",
          signal: controller.signal,
        },
      }),
    );

    expect(backend.calls[0]?.context).toEqual({
      runId: "run-2",
      workspacePath: "/ws",
      taskId: "task-3",
      signal: controller.signal,
    });
  });

  it("drives a full session end to end", async () => {
    const backend = new FakeBackend();
    const session = new BackendChatSession(
      options(backendTurnRunner(backend), { supportsContinuation: true }),
    );

    await session.send("u1");
    await session.send("u2");

    expect(session.sessionRef()).toBe("sess-42");
    expect(backend.calls[1]?.input.context).toBeUndefined();
    expect(session.entries()).toHaveLength(4);
  });
});
