import type {
  ModelDefinition,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  UsageRecorder,
} from "@agent/ai";
import type { AgentDefinition, Tool, ToolContext } from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentLoopRunContext } from "../src/loop.js";
import { PermissionEngine } from "../src/permissions.js";

// --- fakes ----------------------------------------------------------------

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
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #turns: ModelEvent[][];
  readonly #repeatLast: boolean;

  constructor(turns: ModelEvent[][], repeatLast = false) {
    this.#turns = turns.map((turn) => [...turn]);
    this.#repeatLast = repeatLast;
  }

  supports(): boolean {
    return true;
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.signals.push(signal);

    const turn =
      this.#turns.length > 1 || !this.#repeatLast
        ? this.#turns.shift()
        : this.#turns[0];
    if (turn === undefined) throw new Error("scripted provider exhausted");

    for (const event of turn) yield event;
  }
}

/** Provider whose stream never produces anything until it is torn down. */
class HangingProvider implements ModelProvider {
  readonly id = "hanging";
  returned = false;

  supports(): boolean {
    return true;
  }

  stream(): AsyncIterable<ModelEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ModelEvent>> {
            return new Promise<IteratorResult<ModelEvent>>(() => undefined);
          },
          async return(): Promise<IteratorResult<ModelEvent>> {
            self.returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}

class ThrowingProvider implements ModelProvider {
  readonly id = "throwing";

  supports(): boolean {
    return true;
  }

  // biome-ignore lint/correctness/useYield: intentionally throws before yielding
  async *stream(): AsyncIterable<ModelEvent> {
    throw new Error("upstream exploded");
  }
}

class RecordingUsage implements UsageRecorder {
  readonly entries: { model: ModelDefinition; usage: ModelUsage }[] = [];

  record(model: ModelDefinition, usage: ModelUsage): void {
    this.entries.push({ model, usage });
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
}

interface ToolCallRecord {
  readonly input: unknown;
  readonly context: ToolContext;
}

function makeTool(
  name: string,
  execute: (input: unknown, context: ToolContext) => Promise<unknown>,
): Tool & { readonly calls: ToolCallRecord[] } {
  const calls: ToolCallRecord[] = [];
  const description = `${name} tool`;
  const inputSchema = { type: "object" };
  return {
    name,
    description,
    inputSchema,
    calls,
    definition: () => ({ name, description, inputSchema }),
    execute: (input: unknown, context: ToolContext) => {
      calls.push({ input, context });
      return execute(input, context);
    },
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

// --- tests ----------------------------------------------------------------

describe("AgentLoop — plain text turns", () => {
  it("returns success with the accumulated text as summary and output", async () => {
    const provider = new ScriptedProvider([text("Hello, ", "world.")]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
    });

    const result = await loop.run({ instruction: "say hi" }, RUN_CONTEXT);

    expect(result).toEqual({
      status: "success",
      summary: "Hello, world.",
      output: "Hello, world.",
      iterations: 1,
      toolCalls: 0,
      requestedMessages: 2,
    });
  });

  it("seeds the conversation with the system prompt, instruction and context entries", async () => {
    const provider = new ScriptedProvider([text("ok")]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
      temperature: 0.2,
      maxOutputTokens: 512,
    });

    await loop.run(
      { instruction: "fix the bug", context: ["file a", "file b"] },
      RUN_CONTEXT,
    );

    const request = provider.requests[0];
    expect(request).toBeDefined();
    expect(request?.model).toBe(MODEL);
    expect(request?.temperature).toBe(0.2);
    expect(request?.maxOutputTokens).toBe(512);

    const messages = request?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a coding agent.",
    });
    expect(messages[1]?.role).toBe("user");
    const user = messages[1]?.content ?? "";
    expect(user.startsWith("fix the bug")).toBe(true);
    expect(user).toContain("file a");
    expect(user).toContain("file b");
    expect(user.indexOf("file a")).toBeLessThan(user.indexOf("file b"));
  });

  it("attaches images to the seeded user message (P1-9), and omits `images` when there are none", async () => {
    const provider = new ScriptedProvider([text("ok")]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
    });

    await loop.run(
      {
        instruction: "what is in this screenshot?",
        images: [
          { mediaType: "image/png", base64: "cG5n", path: "/tmp/a.png" },
        ],
      },
      RUN_CONTEXT,
    );

    const messages = provider.requests[0]?.messages ?? [];
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.images).toEqual([
      { mediaType: "image/png", base64: "cG5n", path: "/tmp/a.png" },
    ]);

    const secondProvider = new ScriptedProvider([text("ok")]);
    const secondLoop = new AgentLoop({
      agent: AGENT,
      provider: secondProvider,
      tools: [],
      permissions: allowAll(),
    });
    await secondLoop.run({ instruction: "no images here" }, RUN_CONTEXT);
    const plainMessages = secondProvider.requests[0]?.messages ?? [];
    expect(plainMessages[1]).not.toHaveProperty("images");
  });

  it("passes the tool definitions to the provider", async () => {
    const echo = makeTool("echo", async (input) => input);
    const provider = new ScriptedProvider([text("done")]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [echo],
      permissions: allowAll(),
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(provider.requests[0]?.tools).toEqual([
      {
        name: "echo",
        description: "echo tool",
        inputSchema: { type: "object" },
      },
    ]);
  });
});

describe("AgentLoop — tool execution", () => {
  it("executes a requested tool and feeds the result back into the next turn", async () => {
    const echo = makeTool("echo", async (input) => ({ echoed: input }));
    const provider = new ScriptedProvider([
      toolTurn("call-1", "echo", { value: 42 }),
      text("All done."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [echo],
      permissions: allowAll(),
    });

    const result = await loop.run({ instruction: "echo 42" }, RUN_CONTEXT);

    expect(result.status).toBe("success");
    expect(result.summary).toBe("All done.");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);

    // Tool received the raw input and a fully-populated ToolContext.
    expect(echo.calls).toHaveLength(1);
    expect(echo.calls[0]?.input).toEqual({ value: 42 });
    expect(echo.calls[0]?.context.runId).toBe("run-1");
    expect(echo.calls[0]?.context.taskId).toBe("task-1");
    expect(echo.calls[0]?.context.workspacePath).toBe("/workspace");
    expect(echo.calls[0]?.context.signal).toBeInstanceOf(AbortSignal);
    expect(echo.calls[0]?.context.signal.aborted).toBe(false);

    // Second request carries the assistant tool-call turn plus the tool result.
    const second = provider.requests[1];
    expect(second).toBeDefined();
    const messages = second?.messages ?? [];
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: 42 } }],
    });
    expect(messages[3]?.role).toBe("tool");
    expect(messages[3]?.toolCallId).toBe("call-1");
    expect(messages[3]?.content).toBe(
      JSON.stringify({ echoed: { value: 42 } }),
    );
    expect(messages[3]?.isError).toBeUndefined();
  });

  it("passes string tool output through verbatim", async () => {
    const cat = makeTool("cat", async () => "file contents");
    const provider = new ScriptedProvider([
      toolTurn("c1", "cat", {}),
      text("ok"),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [cat],
      permissions: allowAll(),
    });

    await loop.run({ instruction: "read" }, RUN_CONTEXT);

    expect(provider.requests[1]?.messages[3]?.content).toBe("file contents");
  });

  it("runs multiple tool calls sequentially in order", async () => {
    const order: string[] = [];
    const first = makeTool("first", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("first");
      return "1";
    });
    const second = makeTool("second", async () => {
      order.push("second");
      return "2";
    });
    const provider = new ScriptedProvider([
      [
        { type: "tool.call", id: "a", name: "first", input: {} },
        { type: "tool.call", id: "b", name: "second", input: {} },
        { type: "done", finishReason: "tool_use" },
      ],
      text("finished"),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [first, second],
      permissions: allowAll(),
    });

    const result = await loop.run({ instruction: "both" }, RUN_CONTEXT);

    expect(order).toEqual(["first", "second"]);
    expect(result.toolCalls).toBe(2);
    const messages = provider.requests[1]?.messages ?? [];
    expect(messages[3]?.toolCallId).toBe("a");
    expect(messages[4]?.toolCallId).toBe("b");
  });

  it("feeds an error result back when the tool is denied, and keeps looping", async () => {
    const danger = makeTool("danger", async () => "should never run");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "danger", { rm: "-rf" }),
      text("Understood, stopping."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [danger],
      permissions: new PermissionEngine(
        { danger: "deny" },
        { defaultDecision: "allow" },
      ),
    });

    const result = await loop.run({ instruction: "danger" }, RUN_CONTEXT);

    expect(danger.calls).toHaveLength(0);
    expect(result.status).toBe("success");
    expect(result.iterations).toBe(2);
    const message = provider.requests[1]?.messages[3];
    expect(message?.role).toBe("tool");
    expect(message?.toolCallId).toBe("call-1");
    expect(message?.isError).toBe(true);
    expect(message?.content).toContain("denied by policy");
  });

  it("denies 'ask' tools in non-interactive mode with an explanatory result", async () => {
    const write = makeTool("write", async () => "written");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "write", {}),
      text("ok"),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [write],
      permissions: new PermissionEngine({ write: "ask" }),
    });

    await loop.run({ instruction: "write" }, RUN_CONTEXT);

    expect(write.calls).toHaveLength(0);
    expect(provider.requests[1]?.messages[3]?.content).toContain(
      "no prompter available in non-interactive mode",
    );
  });

  it("carries a refusal's words back to the model and keeps the turn going", async () => {
    const remove = makeTool("bash", async () => "removed");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "bash", { command: "rm -rf build" }),
      text("빌드 산출물이라 지워도 된다고 봤는데, 확인 없이는 두겠습니다."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [remove],
      permissions: new PermissionEngine(
        { bash: "ask" },
        {
          prompter: {
            ask: async () => ({
              allowed: false,
              feedback: "왜 이 파일을 지우려는 거야?",
            }),
          },
        },
      ),
    });

    const result = await loop.run({ instruction: "clean up" }, RUN_CONTEXT);

    // The call did not run, and the same turn carried on to an answer.
    expect(remove.calls).toHaveLength(0);
    expect(result.status).toBe("success");
    expect(result.iterations).toBe(2);

    const message = provider.requests[1]?.messages[3];
    expect(message?.role).toBe("tool");
    expect(message?.toolCallId).toBe("call-1");
    expect(message?.isError).toBe(true);
    // Verbatim, multi-byte and all — these are the user's words, not a summary.
    expect(message?.content).toContain("왜 이 파일을 지우려는 거야?");
    expect(message?.content).toContain("declined by the user, who said:");
    expect(message?.content).toContain("the user's own words");
  });

  it("answers a wordless refusal with the bare reason, as before", async () => {
    const write = makeTool("write", async () => "written");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "write", {}),
      text("ok"),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [write],
      permissions: new PermissionEngine(
        { write: "ask" },
        { prompter: { ask: async () => false } },
      ),
    });

    await loop.run({ instruction: "write" }, RUN_CONTEXT);

    expect(write.calls).toHaveLength(0);
    expect(provider.requests[1]?.messages[3]?.content).toBe(
      'Tool "write" was not permitted: denied by prompter',
    );
  });

  it("turns a thrown tool error into an error result and keeps looping", async () => {
    const boom = makeTool("boom", async () => {
      throw new Error("disk on fire");
    });
    const provider = new ScriptedProvider([
      toolTurn("call-1", "boom", {}),
      text("Recovered."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [boom],
      permissions: allowAll(),
    });

    const result = await loop.run({ instruction: "boom" }, RUN_CONTEXT);

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Recovered.");
    const message = provider.requests[1]?.messages[3];
    expect(message?.isError).toBe(true);
    expect(message?.content).toContain("disk on fire");
  });

  it("reports unknown tool names as an error result", async () => {
    const provider = new ScriptedProvider([
      toolTurn("call-1", "nosuchtool", {}),
      text("Sorry about that."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(result.status).toBe("success");
    const message = provider.requests[1]?.messages[3];
    expect(message?.isError).toBe(true);
    expect(message?.content).toBe("Unknown tool: nosuchtool");
  });
});

describe("AgentLoop — budgets, usage and failures", () => {
  it("returns 'partial' when the iteration budget is exhausted", async () => {
    const echo = makeTool("echo", async () => "again");
    const provider = new ScriptedProvider(
      [toolTurn("call-1", "echo", {})],
      true,
    );
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [echo],
      permissions: allowAll(),
      maxIterations: 3,
    });

    const result = await loop.run({ instruction: "loop forever" }, RUN_CONTEXT);

    expect(result.status).toBe("partial");
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(3);
    expect(result.summary).toContain("iteration budget");
    expect(provider.requests).toHaveLength(3);
  });

  it("forwards every usage event to the recorder with the agent model", async () => {
    const usage = new RecordingUsage();
    const provider = new ScriptedProvider([
      [
        { type: "tool.call", id: "call-1", name: "echo", input: {} },
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        { type: "done", finishReason: "tool_use" },
      ],
      [
        { type: "text.delta", text: "done" },
        {
          type: "usage",
          inputTokens: 20,
          outputTokens: 7,
          cachedInputTokens: 3,
        },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [makeTool("echo", async () => "x")],
      permissions: allowAll(),
      usage,
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(usage.entries).toEqual([
      { model: MODEL, usage: { inputTokens: 10, outputTokens: 5 } },
      {
        model: MODEL,
        usage: { inputTokens: 20, outputTokens: 7, cachedInputTokens: 3 },
      },
    ]);
    expect(usage.entries[0]?.usage.cachedInputTokens).toBeUndefined();
  });

  it("returns 'failed' when the provider stream throws", async () => {
    const loop = new AgentLoop({
      agent: AGENT,
      provider: new ThrowingProvider(),
      tools: [],
      permissions: allowAll(),
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("upstream exploded");
    expect(result.iterations).toBe(1);
  });
});

describe("AgentLoop — cancellation and timeout", () => {
  it("fails with a cancellation summary when the caller aborts", async () => {
    const provider = new HangingProvider();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
    });
    const controller = new AbortController();

    const running = loop.run(
      { instruction: "hang" },
      { ...RUN_CONTEXT, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    const result = await running;

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cancel/i);
    expect(provider.returned).toBe(true);
  });

  it("fails with a timeout summary when timeoutMs elapses", async () => {
    const provider = new HangingProvider();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
      timeoutMs: 20,
    });

    const result = await loop.run({ instruction: "hang" }, RUN_CONTEXT);

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/timed out/i);
    expect(result.summary).toContain("20ms");
  });

  it("does not let a hung tool outlive the abort, and aborts the tool's signal", async () => {
    let toolSignal: AbortSignal | undefined;
    const hang = makeTool("hang", async (_input, context) => {
      toolSignal = context.signal;
      return new Promise<string>(() => undefined);
    });
    const provider = new ScriptedProvider([
      toolTurn("call-1", "hang", {}),
      text("never"),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [hang],
      permissions: allowAll(),
      timeoutMs: 20,
    });

    const result = await loop.run({ instruction: "hang" }, RUN_CONTEXT);

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/timed out/i);
    expect(toolSignal?.aborted).toBe(true);
    // The loop unwound instead of waiting for the second scripted turn.
    expect(provider.requests).toHaveLength(1);
  });

  it("fails immediately when the caller's signal is already aborted", async () => {
    const provider = new HangingProvider();
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
    });

    const result = await loop.run(
      { instruction: "go" },
      { ...RUN_CONTEXT, signal: AbortSignal.abort() },
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cancel/i);
  });
});

describe("AgentLoop — streamed text deltas", () => {
  it("emits one model.text.delta per streamed chunk, in order", async () => {
    const sink = new RecordingSink();
    const provider = new ScriptedProvider([text("Hel", "lo, ", "world.")]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
      events: sink,
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    const deltas = sink.events.filter(
      (event) => event.type === "model.text.delta",
    );
    expect(deltas.map((event) => event.data)).toEqual([
      { text: "Hel", iteration: 1 },
      { text: "lo, ", iteration: 1 },
      { text: "world.", iteration: 1 },
    ]);
    for (const event of deltas) {
      expect(event.runId).toBe("run-1");
      expect(event.taskId).toBe("task-1");
    }
  });

  it("leaves model.turn.completed carrying the whole turn, unchanged", async () => {
    const sink = new RecordingSink();
    const provider = new ScriptedProvider([text("Hel", "lo, ", "world.")]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
      events: sink,
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);

    const completed = sink.events.filter(
      (event) => event.type === "model.turn.completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toEqual({
      text: "Hello, world.",
      toolCallCount: 0,
      finishReason: "stop",
    });
    expect(result.output).toBe("Hello, world.");
  });

  it("numbers the deltas by the model turn they belong to", async () => {
    const sink = new RecordingSink();
    const echo = makeTool("echo", async () => "ok");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "echo", {}),
      text("Done."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [echo],
      permissions: allowAll(),
      events: sink,
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(
      sink.events
        .filter((event) => event.type === "model.text.delta")
        .map((event) => event.data),
    ).toEqual([{ text: "Done.", iteration: 2 }]);
  });

  it("emits no delta at all for a provider that streams no text", async () => {
    const sink = new RecordingSink();
    const provider = new ScriptedProvider([
      [{ type: "done", finishReason: "stop" }],
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
      events: sink,
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(sink.types()).toEqual([
      "loop.started",
      "model.turn.completed",
      "loop.completed",
    ]);
    expect(sink.events[1]?.data).toEqual({
      toolCallCount: 0,
      finishReason: "stop",
    });
  });

  it("says nothing for an empty chunk", async () => {
    const sink = new RecordingSink();
    const provider = new ScriptedProvider([
      [
        { type: "text.delta", text: "" },
        { type: "text.delta", text: "hi" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [],
      permissions: allowAll(),
      events: sink,
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(
      sink.events
        .filter((event) => event.type === "model.text.delta")
        .map((event) => event.data),
    ).toEqual([{ text: "hi", iteration: 1 }]);
  });
});

describe("AgentLoop — events", () => {
  it("emits lifecycle events in order", async () => {
    const sink = new RecordingSink();
    const echo = makeTool("echo", async () => "ok");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "echo", { value: 1 }),
      text("Finished."),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [echo],
      permissions: allowAll(),
      events: sink,
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(sink.types()).toEqual([
      "loop.started",
      "model.turn.completed",
      "tool.execution.started",
      "tool.execution.completed",
      "model.text.delta",
      "model.turn.completed",
      "loop.completed",
    ]);

    for (const event of sink.events) {
      expect(event.runId).toBe("run-1");
      expect(event.taskId).toBe("task-1");
      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
      expect(typeof event.timestamp).toBe("number");
    }
    expect(new Set(sink.events.map((event) => event.id)).size).toBe(
      sink.events.length,
    );

    expect(sink.events[1]?.data).toEqual({
      toolCallCount: 1,
      finishReason: "tool_use",
    });
    expect(sink.events[2]?.data).toEqual({ tool: "echo", input: { value: 1 } });
    expect(sink.events[3]?.data).toEqual({ tool: "echo", ok: true });
    expect(sink.events[4]?.data).toEqual({ text: "Finished.", iteration: 2 });
    expect(sink.events[5]?.data).toEqual({
      text: "Finished.",
      toolCallCount: 0,
      finishReason: "stop",
    });
    expect(sink.events[6]?.data).toEqual({
      status: result.status,
      iterations: 2,
      toolCalls: 1,
    });
  });

  it("marks denied tool executions with denied:true", async () => {
    const sink = new RecordingSink();
    const danger = makeTool("danger", async () => "nope");
    const provider = new ScriptedProvider([
      toolTurn("call-1", "danger", {}),
      text("ok"),
    ]);
    const loop = new AgentLoop({
      agent: AGENT,
      provider,
      tools: [danger],
      permissions: new PermissionEngine(
        { danger: "deny" },
        { defaultDecision: "allow" },
      ),
      events: sink,
    });

    await loop.run({ instruction: "go" }, RUN_CONTEXT);

    expect(sink.events[3]?.data).toEqual({
      tool: "danger",
      ok: false,
      denied: true,
    });
  });

  it("emits loop.completed on failure and survives a throwing sink", async () => {
    const failing: EventSink = {
      emit() {
        throw new Error("sink is down");
      },
    };
    const loop = new AgentLoop({
      agent: AGENT,
      provider: new ThrowingProvider(),
      tools: [],
      permissions: allowAll(),
      events: failing,
    });

    const result = await loop.run({ instruction: "go" }, RUN_CONTEXT);
    expect(result.status).toBe("failed");
  });
});
