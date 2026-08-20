import type {
  ModelDefinition,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
} from "@agent/ai";
import type {
  AgentDefinition,
  AgentImageAttachment,
  Tool,
  ToolContext,
} from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import { AgentChatSession } from "../src/chat.js";
import type { AgentLoopOptions, AgentLoopRunContext } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";

// --- fakes (mirrors test/loop.test.ts patterns) ----------------------------

const MODEL: ModelDefinition = {
  provider: "fake",
  id: "fake-model-1",
  capabilities: {
    tools: true,
    reasoning: false,
    vision: false,
    structuredOutput: true,
  },
};

const AGENT: AgentDefinition = {
  name: "coder",
  role: "worker",
  model: MODEL,
  systemPrompt: "You are a coding agent.",
  tools: ["echo"],
  permissions: {},
};

const RUN_CONTEXT: AgentLoopRunContext = {
  runId: "run-1",
  taskId: "task-1",
  workspacePath: "/workspace",
};

/** Provider that replays a scripted queue of turns and captures every request. */
class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ModelRequest[] = [];
  readonly #turns: ModelEvent[][];

  constructor(turns: ModelEvent[][]) {
    this.#turns = turns.map((turn) => [...turn]);
  }

  supports(): boolean {
    return true;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const turn = this.#turns.shift();
    if (turn === undefined) throw new Error("scripted provider exhausted");
    for (const event of turn) yield event;
  }
}

class RecordingSink implements EventSink {
  readonly events: AgentEvent[] = [];

  async emit(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }

  ofType(type: string): AgentEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

function makeTool(
  name: string,
  execute: (input: unknown, context: ToolContext) => Promise<unknown>,
): Tool {
  const description = `${name} tool`;
  const inputSchema = { type: "object" };
  return {
    name,
    description,
    inputSchema,
    definition: () => ({ name, description, inputSchema }),
    execute,
  };
}

function text(...chunks: string[]): ModelEvent[] {
  return [
    ...chunks.map((chunk): ModelEvent => ({ type: "text.delta", text: chunk })),
    { type: "done", finishReason: "stop" },
  ];
}

function toolTurn(id: string, name: string, input: unknown): ModelEvent[] {
  return [
    { type: "tool.call", id, name, input },
    { type: "done", finishReason: "tool_use" },
  ];
}

function allowAll(): PermissionEngine {
  return new PermissionEngine({}, { defaultDecision: "allow" });
}

function options(
  provider: ModelProvider,
  overrides: Partial<AgentLoopOptions> = {},
): AgentLoopOptions {
  return {
    agent: AGENT,
    provider,
    tools: [],
    permissions: allowAll(),
    ...overrides,
  };
}

/** Every tool call the model made must have a matching tool result. */
function unansweredToolCallIds(
  messages: readonly ModelMessage[],
): readonly string[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (message.toolCallId !== undefined) answered.add(message.toolCallId);
  }

  const pending: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id)) pending.push(call.id);
    }
  }
  return pending;
}

// --- tests ------------------------------------------------------------------

describe("AgentChatSession — conversation continuity", () => {
  it("seeds the first send like a one-shot run and continues the same conversation on the next", async () => {
    const provider = new ScriptedProvider([
      text("Hi there."),
      text("Bye now."),
    ]);
    const session = new AgentChatSession(options(provider));

    const first = await session.send("hello", RUN_CONTEXT);
    expect(first).toEqual({
      status: "success",
      summary: "Hi there.",
      output: "Hi there.",
      iterations: 1,
      toolCalls: 0,
    });

    // First request: system prompt + the instruction, nothing else.
    expect(provider.requests[0]?.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "hello" },
    ]);

    const second = await session.send("and again", RUN_CONTEXT);
    expect(second).toEqual({
      status: "success",
      summary: "Bye now.",
      output: "Bye now.",
      iterations: 1,
      toolCalls: 0,
    });

    // Second request replays the whole first exchange before the new turn.
    expect(provider.requests[1]?.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there." },
      { role: "user", content: "and again" },
    ]);
  });

  it("keeps a send's tool call and its result in history for the next send", async () => {
    const echo = makeTool("echo", async (input) => ({ echoed: input }));
    const provider = new ScriptedProvider([
      toolTurn("call-1", "echo", { value: 42 }),
      text("Echoed it."),
      text("Nothing more."),
    ]);
    const session = new AgentChatSession(options(provider, { tools: [echo] }));

    const first = await session.send("echo 42", RUN_CONTEXT);
    expect(first.status).toBe("success");
    expect(first.iterations).toBe(2);
    expect(first.toolCalls).toBe(1);

    await session.send("anything else?", RUN_CONTEXT);

    // Counters are per send, not cumulative.
    const messages = provider.requests[2]?.messages ?? [];
    expect(messages).toHaveLength(6);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: 42 } }],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ echoed: { value: 42 } }),
    });
    expect(messages[4]).toEqual({ role: "assistant", content: "Echoed it." });
    expect(messages[5]).toEqual({ role: "user", content: "anything else?" });
    expect(unansweredToolCallIds(messages)).toEqual([]);
  });

  it("applies maxIterations per send", async () => {
    const echo = makeTool("echo", async () => "again");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "echo", {}),
      toolTurn("call-2", "echo", {}),
      text("Now done."),
    ]);
    const session = new AgentChatSession(
      options(provider, { tools: [echo], maxIterations: 2 }),
    );

    const first = await session.send("keep going", RUN_CONTEXT);
    expect(first.status).toBe("partial");
    expect(first.iterations).toBe(2);
    expect(first.toolCalls).toBe(2);
    expect(first.summary).toContain("iteration budget");

    // The budget resets: the next send gets its own two iterations.
    const second = await session.send("wrap up", RUN_CONTEXT);
    expect(second.status).toBe("success");
    expect(second.iterations).toBe(1);
    expect(second.toolCalls).toBe(0);

    // The exhausted send's messages are all still there.
    const messages = provider.requests[2]?.messages ?? [];
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "user",
    ]);
    expect(unansweredToolCallIds(messages)).toEqual([]);
  });
});

describe("AgentChatSession — image attachments", () => {
  const shot: AgentImageAttachment = {
    mediaType: "image/png",
    base64: "cG5n",
    path: "/workspace/shot.png",
  };

  it("attaches images to the seeded turn and to a later one, and only to those turns", async () => {
    const provider = new ScriptedProvider([
      text("Seen it."),
      text("Nothing new."),
      text("Seen that too."),
    ]);
    const session = new AgentChatSession(options(provider));

    await session.send("what is this?", RUN_CONTEXT, [shot]);
    // The seeded user turn carries the image (`AgentLoopEngine.seed`).
    expect(provider.requests[0]?.messages[1]).toEqual({
      role: "user",
      content: "what is this?",
      images: [shot],
    });

    // A turn with no images says nothing about them at all.
    await session.send("and now?", RUN_CONTEXT);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "and now?",
    });

    // A later turn attaches its own, and the earlier image is still in history.
    const second: AgentImageAttachment = { ...shot, path: "/workspace/b.png" };
    await session.send("this one?", RUN_CONTEXT, [second]);
    const messages = provider.requests[2]?.messages ?? [];
    expect(messages[1]?.images).toEqual([shot]);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "this one?",
      images: [second],
    });
  });

  it("keeps images in the snapshot, safely copied", async () => {
    const provider = new ScriptedProvider([text("Seen it.")]);
    const session = new AgentChatSession(options(provider));
    await session.send("what is this?", RUN_CONTEXT, [shot]);

    const snapshot = session.messages();
    const copied = snapshot[1]?.images as { base64: string }[];
    expect(copied).toEqual([shot]);
    // Mutating the snapshot cannot reach the retained history.
    const first = copied[0] ?? { base64: "" };
    first.base64 = "tampered";
    expect(session.messages()[1]?.images?.[0]?.base64).toBe("cG5n");
  });
});

describe("AgentChatSession — snapshots", () => {
  it("returns a mutation-safe snapshot matching what the provider saw plus the reply", async () => {
    const echo = makeTool("echo", async () => "tool output");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "echo", { a: 1 }),
      text("All set."),
    ]);
    const session = new AgentChatSession(options(provider, { tools: [echo] }));

    await session.send("do it", RUN_CONTEXT);

    const snapshot = session.messages();
    const lastRequest = provider.requests[1]?.messages ?? [];
    expect(snapshot).toEqual([
      ...lastRequest,
      { role: "assistant", content: "All set." },
    ]);
    expect(snapshot[0]).toEqual({
      role: "system",
      content: "You are a coding agent.",
    });

    // Mutating the snapshot (array or entries) must not reach the session.
    const mutable = snapshot as ModelMessage[];
    mutable.push({ role: "user", content: "injected" });
    const first = mutable[0] as { content: string };
    first.content = "tampered";
    const assistant = snapshot.find(
      (message) => message.role === "assistant",
    ) as { toolCalls?: { id: string }[] };
    const call = assistant.toolCalls?.[0];
    if (call !== undefined) call.id = "tampered-id";

    const fresh = session.messages();
    expect(fresh).toHaveLength(5);
    expect(fresh[0]?.content).toBe("You are a coding agent.");
    expect(fresh[2]?.toolCalls?.[0]?.id).toBe("call-1");
  });

  it("restores a snapshot into a new session and continues from it", async () => {
    const first = new ScriptedProvider([
      text("Reply one."),
      text("Reply two."),
    ]);
    const original = new AgentChatSession(options(first));
    await original.send("hello", RUN_CONTEXT);
    await original.send("more", RUN_CONTEXT);
    const snapshot = original.messages();
    expect(snapshot).toHaveLength(5);

    const second = new ScriptedProvider([text("Restored reply.")]);
    const restored = AgentChatSession.restore(options(second), snapshot);

    const result = await restored.send("after restore", RUN_CONTEXT);
    expect(result.status).toBe("success");
    expect(result.summary).toBe("Restored reply.");

    // The restored history is used as-is: no second system prompt is seeded.
    expect(second.requests[0]?.messages).toEqual([
      ...snapshot,
      { role: "user", content: "after restore" },
    ]);
    expect(
      second.requests[0]?.messages.filter(
        (message) => message.role === "system",
      ),
    ).toHaveLength(1);

    // Restoring copies: the source session is untouched by the new turn.
    expect(original.messages()).toEqual(snapshot);
  });

  it("treats an empty restore as a fresh session", async () => {
    const provider = new ScriptedProvider([text("Fresh.")]);
    const session = AgentChatSession.restore(options(provider), []);

    expect(session.messages()).toEqual([]);
    const result = await session.send("hello", RUN_CONTEXT);

    expect(result.summary).toBe("Fresh.");
    expect(provider.requests[0]?.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "hello" },
    ]);
  });
});

describe("AgentChatSession — single flight", () => {
  it("throws when a send starts while another is in flight", async () => {
    let release: (() => void) | undefined;
    const slow = makeTool("slow", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "done";
    });
    const provider = new ScriptedProvider([
      toolTurn("call-1", "slow", {}),
      text("finished"),
    ]);
    const session = new AgentChatSession(options(provider, { tools: [slow] }));

    const running = session.send("first", RUN_CONTEXT);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(session.send("second", RUN_CONTEXT)).rejects.toThrow(
      /in flight/i,
    );

    release?.();
    const result = await running;
    expect(result.status).toBe("success");

    // The rejected send left nothing behind.
    expect(
      session.messages().filter((message) => message.role === "user"),
    ).toHaveLength(1);

    // And the session is usable again afterwards.
    expect(session.messages()).toHaveLength(5);
  });
});

describe("AgentChatSession — cancellation keeps history replayable", () => {
  it("answers tool calls abandoned mid-batch so the next send is provider-valid", async () => {
    const hang = makeTool(
      "hang",
      async () => new Promise<string>(() => undefined),
    );
    const provider = new ScriptedProvider([
      [
        { type: "tool.call", id: "call-1", name: "hang", input: {} },
        { type: "tool.call", id: "call-2", name: "hang", input: {} },
        { type: "done", finishReason: "tool_use" },
      ],
      text("Back again."),
    ]);
    const session = new AgentChatSession(options(provider, { tools: [hang] }));
    const controller = new AbortController();

    const running = session.send("hang please", {
      ...RUN_CONTEXT,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    const cancelled = await running;

    expect(cancelled.status).toBe("failed");
    expect(cancelled.summary).toMatch(/cancel/i);

    // The user turn and the assistant tool-call turn stay, but both calls are
    // answered so no dangling tool_use remains.
    const history = session.messages();
    expect(unansweredToolCallIds(history)).toEqual([]);
    expect(history).toHaveLength(5);
    expect(history[3]).toEqual({
      role: "tool",
      toolCallId: "call-1",
      isError: true,
      content: "[cancelled before execution]",
    });
    expect(history[4]).toEqual({
      role: "tool",
      toolCallId: "call-2",
      isError: true,
      content: "[cancelled before execution]",
    });

    // The follow-up send is accepted and carries a valid conversation.
    const result = await session.send("what happened?", RUN_CONTEXT);
    expect(result.status).toBe("success");
    const messages = provider.requests[1]?.messages ?? [];
    expect(unansweredToolCallIds(messages)).toEqual([]);
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "what happened?",
    });
  });
});

describe("AgentChatSession — compaction across sends", () => {
  it("elides an older send's long tool results once the history grows", async () => {
    const BIG = "x".repeat(500);
    const big = makeTool("big", async () => BIG);
    const provider = new ScriptedProvider([
      toolTurn("call-1", "big", {}),
      text("one"),
      toolTurn("call-2", "big", {}),
      text("two"),
      text("three"),
    ]);
    const sink = new RecordingSink();
    const session = new AgentChatSession(
      options(provider, {
        tools: [big],
        events: sink,
        compaction: { maxMessages: 8, preserveRecent: 4, minContentChars: 100 },
      }),
    );

    await session.send("first", RUN_CONTEXT);
    await session.send("second", RUN_CONTEXT);
    // Nothing has aged out yet.
    expect(sink.ofType("context.compacted")).toHaveLength(0);

    await session.send("third", RUN_CONTEXT);

    const compactions = sink.ofType("context.compacted");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.data).toMatchObject({ elided: 1, messages: 10 });

    const request = provider.requests[4]?.messages ?? [];
    // Send #1's tool result was elided; send #2's is still inside the window.
    expect(request[3]?.toolCallId).toBe("call-1");
    expect(request[3]?.content).toBe(
      `[tool result elided during context compaction: ${BIG.length} chars]`,
    );
    expect(request[7]?.toolCallId).toBe("call-2");
    expect(request[7]?.content).toBe(BIG);

    // The elision is retained, not just applied to one request.
    expect(session.messages()[3]?.content).toContain("elided");
  });

  it("compactNow forces a pass immediately, ignoring maxMessages (/compact)", async () => {
    const BIG = "x".repeat(500);
    const big = makeTool("big", async () => BIG);
    const provider = new ScriptedProvider([
      toolTurn("call-1", "big", {}),
      text("one"),
      toolTurn("call-2", "big", {}),
      text("two"),
    ]);
    const sink = new RecordingSink();
    const session = new AgentChatSession(
      options(provider, {
        tools: [big],
        events: sink,
        // maxMessages(100) is nowhere near what two sends produce, so the
        // automatic pass never fires — compactNow must not care.
        compaction: {
          maxMessages: 100,
          preserveRecent: 4,
          minContentChars: 100,
        },
      }),
    );

    await session.send("first", RUN_CONTEXT);
    await session.send("second", RUN_CONTEXT);
    expect(sink.ofType("context.compacted")).toHaveLength(0);

    const result = await session.compactNow(RUN_CONTEXT);
    expect(result.elided).toBe(1);

    const compactions = sink.ofType("context.compacted");
    expect(compactions).toHaveLength(1);

    // send #1's tool result aged out of the 4-message preserve window and
    // was elided; the retained snapshot reflects it immediately.
    expect(session.messages()[3]?.content).toContain("elided");
    expect(session.messages()[7]?.content).toBe(BIG);
  });

  it("compactNow reports zero on a session with no history yet", async () => {
    const provider = new ScriptedProvider([]);
    const session = new AgentChatSession(options(provider));
    expect(await session.compactNow(RUN_CONTEXT)).toEqual({
      elided: 0,
      savedChars: 0,
    });
  });
});

describe("AgentChatSession — events", () => {
  it("wraps each send in chat.turn.started/completed with a 1-based turn number", async () => {
    const echo = makeTool("echo", async () => "ok");
    const provider = new ScriptedProvider([
      text("First."),
      toolTurn("call-1", "echo", {}),
      text("Second."),
    ]);
    const sink = new RecordingSink();
    const session = new AgentChatSession(
      options(provider, { tools: [echo], events: sink }),
    );

    await session.send("one", RUN_CONTEXT);
    expect(sink.types()).toEqual([
      "chat.turn.started",
      "loop.started",
      "model.text.delta",
      "model.turn.completed",
      "loop.completed",
      "chat.turn.completed",
    ]);

    await session.send("two", RUN_CONTEXT);
    expect(sink.types().slice(6)).toEqual([
      "chat.turn.started",
      "loop.started",
      "model.turn.completed",
      "tool.execution.started",
      "tool.execution.completed",
      "model.text.delta",
      "model.turn.completed",
      "loop.completed",
      "chat.turn.completed",
    ]);

    expect(sink.ofType("chat.turn.started").map((event) => event.data)).toEqual(
      [{ turn: 1 }, { turn: 2 }],
    );
    expect(
      sink.ofType("chat.turn.completed").map((event) => event.data),
    ).toEqual([
      { turn: 1, status: "success" },
      { turn: 2, status: "success" },
    ]);

    for (const event of sink.events) {
      expect(event.runId).toBe("run-1");
      expect(event.taskId).toBe("task-1");
    }
  });
});
