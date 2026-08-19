import type {
  ModelDefinition,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
} from "@agent/ai";
import type { AgentDefinition, Tool, ToolContext } from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  AgentLoopEngine,
  type AgentLoopRunContext,
} from "../src/loop.js";
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
  tools: ["big", "small"],
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

  compactionEvents(): AgentEvent[] {
    return this.events.filter((event) => event.type === "context.compacted");
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

const BIG_CONTENT = "x".repeat(500);
const SMALL_CONTENT = "y".repeat(50);

function bigTool(): Tool {
  return makeTool("big", async () => BIG_CONTENT);
}

function smallTool(): Tool {
  return makeTool("small", async () => SMALL_CONTENT);
}

/** N tool turns (alternating id call-1..call-N) followed by a closing text turn. */
function bigToolTurns(count: number): ModelEvent[][] {
  const turns: ModelEvent[][] = [];
  for (let i = 1; i <= count; i += 1) {
    turns.push(toolTurn(`call-${i}`, "big", {}));
  }
  turns.push(text("done"));
  return turns;
}

const ELISION_PREFIX = "[tool result elided during context compaction: ";

// --- tests ------------------------------------------------------------------

describe("AgentLoop compaction — disabled by default", () => {
  it("keeps full tool-result content across a long run when no compaction option is set", async () => {
    const provider = new ScriptedProvider(bigToolTurns(10));
    const sink = new RecordingSink();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(result.status).toBe("success");
    expect(provider.requests.length).toBeGreaterThan(5);

    const lastRequest = provider.requests[provider.requests.length - 1];
    for (const message of lastRequest?.messages ?? []) {
      if (message.role !== "tool") continue;
      expect(message.content).toBe(BIG_CONTENT);
      expect(message.content.startsWith(ELISION_PREFIX)).toBe(false);
    }

    expect(sink.compactionEvents()).toHaveLength(0);
  });

  it("does not compact when compaction is set but the message count never exceeds maxMessages", async () => {
    const provider = new ScriptedProvider(bigToolTurns(5));
    const sink = new RecordingSink();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      compaction: {}, // defaults: maxMessages 60, never reached by 5 tool turns
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    const lastRequest = provider.requests[provider.requests.length - 1];
    for (const message of lastRequest?.messages ?? []) {
      if (message.role !== "tool") continue;
      expect(message.content).toBe(BIG_CONTENT);
    }
    expect(sink.compactionEvents()).toHaveLength(0);
  });
});

describe("AgentLoop compaction — enabled", () => {
  it("elides old long tool results, preserves recent ones, and leaves system/user/assistant untouched", async () => {
    const provider = new ScriptedProvider(bigToolTurns(10));
    const sink = new RecordingSink();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      compaction: { maxMessages: 8, preserveRecent: 6, minContentChars: 100 },
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);
    expect(result.status).toBe("success");

    // 10 tool turns -> system + user + 10*(assistant+tool) = 22 messages.
    const lastRequest = provider.requests[provider.requests.length - 1];
    const messages = lastRequest?.messages ?? [];
    expect(messages).toHaveLength(22);

    // System and first user message are always intact.
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a coding agent.",
    });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("go");

    // Assistant messages (even indices 2..20) keep their toolCalls untouched.
    for (let t = 1; t <= 10; t += 1) {
      const assistantIndex = 2 * t;
      const assistant = messages[assistantIndex];
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.content).toBe("");
      expect(assistant?.toolCalls).toEqual([
        { id: `call-${t}`, name: "big", input: {} },
      ]);
    }

    // Tool turns 1-7 (index 3..15, odd) aged past the preserveRecent(6) window
    // and are elided; toolCallId/role survive untouched.
    for (let t = 1; t <= 7; t += 1) {
      const toolIndex = 2 * t + 1;
      const message = messages[toolIndex];
      expect(message?.role).toBe("tool");
      expect(message?.toolCallId).toBe(`call-${t}`);
      expect(message?.isError).toBeUndefined();
      expect(message?.content.startsWith(ELISION_PREFIX)).toBe(true);
      expect(message?.content).toBe(
        `[tool result elided during context compaction: ${BIG_CONTENT.length} chars]`,
      );
    }

    // Tool turns 8-10 (index 17,19,21) are within the last 6 messages and
    // stay untouched, full content.
    for (let t = 8; t <= 10; t += 1) {
      const toolIndex = 2 * t + 1;
      const message = messages[toolIndex];
      expect(message?.role).toBe("tool");
      expect(message?.content).toBe(BIG_CONTENT);
    }

    // One compacting pass per newly-aged-out message: 7 total, one message
    // elided each time, at growing message counts 10,12,...,22.
    const events = sink.compactionEvents();
    expect(events).toHaveLength(7);
    for (const event of events) {
      expect(event.data).toMatchObject({ elided: 1 });
      const data = event.data as { elided: number; savedChars: number };
      expect(data.savedChars).toBe(
        BIG_CONTENT.length -
          `[tool result elided during context compaction: ${BIG_CONTENT.length} chars]`
            .length,
      );
    }
    expect(
      events.map((event) => (event.data as { messages: number }).messages),
    ).toEqual([10, 12, 14, 16, 18, 20, 22]);
  });

  it("leaves short tool results under minContentChars untouched even when maxMessages is exceeded", async () => {
    const provider = new ScriptedProvider(bigToolTurns(10));
    const sink = new RecordingSink();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      // minContentChars above BIG_CONTENT's length: nothing ever qualifies.
      compaction: { maxMessages: 8, preserveRecent: 2, minContentChars: 1000 },
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    const lastRequest = provider.requests[provider.requests.length - 1];
    for (const message of lastRequest?.messages ?? []) {
      if (message.role !== "tool") continue;
      expect(message.content).toBe(BIG_CONTENT);
    }
    expect(sink.compactionEvents()).toHaveLength(0);
  });

  it("is idempotent: emits exactly one context.compacted event once nothing new qualifies", async () => {
    const turns: ModelEvent[][] = [
      toolTurn("call-1", "big", {}),
      toolTurn("call-2", "small", {}),
      toolTurn("call-3", "small", {}),
      toolTurn("call-4", "small", {}),
      toolTurn("call-5", "small", {}),
      text("done"),
    ];
    const provider = new ScriptedProvider(turns);
    const sink = new RecordingSink();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [bigTool(), smallTool()],
      permissions: allowAll(),
      events: sink,
      compaction: { maxMessages: 6, preserveRecent: 2, minContentChars: 100 },
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);
    expect(result.status).toBe("success");

    // Only the single "big" tool result ever qualifies for elision; every
    // subsequent compacting pass finds nothing new once it has been elided.
    const events = sink.compactionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ elided: 1 });

    const lastRequest = provider.requests[provider.requests.length - 1];
    const messages = lastRequest?.messages ?? [];
    const bigResult = messages[3];
    expect(bigResult?.role).toBe("tool");
    expect(bigResult?.toolCallId).toBe("call-1");
    expect(bigResult?.content.startsWith(ELISION_PREFIX)).toBe(true);

    for (const message of messages) {
      if (message.role !== "tool" || message.toolCallId === "call-1") continue;
      expect(message.content).toBe(SMALL_CONTENT);
    }
  });

  it("carries compaction forward across iterations (elision persists once applied)", async () => {
    const provider = new ScriptedProvider(bigToolTurns(10));
    const sink = new RecordingSink();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      compaction: { maxMessages: 8, preserveRecent: 6, minContentChars: 100 },
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    // The message elided in an early pass (call-1's result, index 3) stays
    // elided in every later request rather than reverting or duplicating.
    const requestsAfterFirstCompaction = provider.requests.slice(4);
    for (const request of requestsAfterFirstCompaction) {
      const message = request.messages[3];
      if (message === undefined) continue;
      expect(message.content.startsWith(ELISION_PREFIX)).toBe(true);
    }
  });
});

describe("AgentLoopEngine.compactNow — forced compaction (/compact)", () => {
  /** A short conversation, well under any auto-compaction threshold. */
  function conversation(): ModelMessage[] {
    return [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "big", input: {} }],
      },
      { role: "tool", toolCallId: "call-1", content: BIG_CONTENT },
      { role: "assistant", content: "" },
      { role: "tool", toolCallId: "call-2", content: BIG_CONTENT },
    ];
  }

  it("compacts immediately even though messages.length never approached maxMessages", async () => {
    const sink = new RecordingSink();
    const engine = new AgentLoopEngine({
      agent: AGENT,
      provider: new ScriptedProvider([]),
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      // maxMessages(100) is nowhere near this 6-message conversation, so the
      // automatic pass (#compact, run only from `drive`) would never fire —
      // compactNow must not care.
      compaction: { maxMessages: 100, preserveRecent: 2, minContentChars: 100 },
    });

    const messages = conversation();
    const result = await engine.compactNow(messages, RUN_CONTEXT);

    // Only call-1's result is outside the last 2 messages' preserve window.
    expect(result).toEqual({
      elided: 1,
      savedChars:
        BIG_CONTENT.length -
        `[tool result elided during context compaction: ${BIG_CONTENT.length} chars]`
          .length,
    });
    expect(messages[3]?.content.startsWith(ELISION_PREFIX)).toBe(true);
    // call-2's result is within the preserved tail and stays untouched.
    expect(messages[5]?.content).toBe(BIG_CONTENT);

    const events = sink.compactionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ elided: 1, messages: 6 });
  });

  it("falls back to this module's own defaults when the engine has no compaction option at all", async () => {
    const sink = new RecordingSink();
    const engine = new AgentLoopEngine({
      agent: AGENT,
      provider: new ScriptedProvider([]),
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      // No `compaction` — the automatic pass is disabled entirely, but
      // compactNow should still do something sensible (default
      // preserveRecent 20 keeps this whole 6-message conversation intact).
    });

    const messages = conversation();
    const result = await engine.compactNow(messages, RUN_CONTEXT);

    expect(result).toEqual({ elided: 0, savedChars: 0 });
    expect(sink.compactionEvents()).toHaveLength(0);
    expect(messages[3]?.content).toBe(BIG_CONTENT);
  });

  it("reports zero and emits nothing on an empty or already-compact history", async () => {
    const sink = new RecordingSink();
    const engine = new AgentLoopEngine({
      agent: AGENT,
      provider: new ScriptedProvider([]),
      tools: [bigTool()],
      permissions: allowAll(),
      events: sink,
      compaction: { preserveRecent: 0, minContentChars: 100 },
    });

    expect(await engine.compactNow([], RUN_CONTEXT)).toEqual({
      elided: 0,
      savedChars: 0,
    });
    expect(sink.compactionEvents()).toHaveLength(0);
  });
});
