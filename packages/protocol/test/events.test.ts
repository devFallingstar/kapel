import { describe, expect, it } from "vitest";
import {
  type AgentEventData,
  AgentEventSchema,
  agentEvent,
  CLAUDE_CODE_EVENT_PREFIX,
  CODEX_EVENT_PREFIX,
  InMemoryEventBus,
  KNOWN_AGENT_EVENT_TYPES,
  type KnownAgentEvent,
  KnownAgentEventSchema,
  MODEL_TEXT_DELTA_EVENT,
  parseAgentEvent,
} from "../src/index.js";

const ENVELOPE = { id: "e1", runId: "run-1", timestamp: 1_700_000_000_000 };

function taskResult() {
  return {
    taskId: "t1",
    status: "success" as const,
    summary: "did the thing",
    decisions: ["kept it simple"],
    changedFiles: ["src/a.ts"],
    tests: { passed: 2, failed: 0, commands: ["npm test"] },
    unresolvedIssues: [],
    confidence: 0.9,
  };
}

/**
 * One well-formed payload per tag in the closed set. Kept as a table rather
 * than a test each so the exhaustiveness check below can prove nothing was
 * forgotten: a new variant with no entry here fails to compile.
 */
const PAYLOADS: {
  readonly [T in KnownAgentEvent["type"]]: AgentEventData<T>;
} = {
  "run.started": { objective: "ship it" },
  "run.completed": { tasks: [{ id: "t1" }] },
  "task.held": { taskId: "t1", conflictsWith: "t2" },
  "task.started": {
    agent: "coder",
    attempt: 1,
    model: "claude-opus-5",
    routing: { rule: "route-impl", reason: "rule" },
  },
  "task.completed": {
    agent: "coder",
    result: taskResult(),
    attempt: 1,
    final: true,
  },
  "task.escalated": { from: "coder", to: "lead", rule: "escalate" },
  "task.cancelled": { reason: "dependency-failed", dependency: "t0" },
  "task.low_confidence": {
    taskId: "t1",
    agent: "coder",
    confidence: 0.4,
    threshold: 0.7,
    rule: "escalate",
    accepted: true,
  },
  "loop.started": { agent: "coder", model: "m", maxIterations: 8 },
  "loop.completed": { status: "success", iterations: 3, toolCalls: 2 },
  "model.turn.completed": {
    text: "hello",
    toolCallCount: 0,
    finishReason: "stop",
  },
  [MODEL_TEXT_DELTA_EVENT]: { text: "hel", iteration: 1 },
  "context.compacted": { elided: 2, savedChars: 900, messages: 40 },
  "tool.execution.started": { tool: "bash", input: { command: "ls" } },
  "tool.execution.completed": { tool: "bash", ok: false, denied: true },
  "mcp.server.started": {
    server: "github",
    tools: 3,
    skippedTools: 1,
    implementation: "github-mcp-server",
  },
  "mcp.server.failed": { server: "github", reason: 'could not start "npx"' },
  "chat.turn.started": { turn: 1, backend: "delegated" },
  "chat.turn.completed": { turn: 1, status: "success" },
  "validation.started": { name: "test", command: "npm test" },
  "validation.completed": {
    name: "test",
    passed: false,
    exitCode: 1,
    durationMs: 2_400,
  },
  "backend.tool_scoping_unsupported": { backend: "codex", agent: "reviewer" },
  "worktree.created": { taskId: "t1", branch: "b", path: "/tmp/w" },
  "worktree.integrated": {
    taskId: "t1",
    merged: false,
    conflictFiles: ["src/a.ts"],
    reason: "dirty-base",
    detail: "src/a.ts is modified",
  },
  "worktree.removed": { taskId: "t1", keptBranch: true, branch: "b" },
};

describe("AgentEventSchema — the closed set", () => {
  for (const type of KNOWN_AGENT_EVENT_TYPES) {
    it(`parses ${type} with its own payload`, () => {
      const event = { ...ENVELOPE, type, data: PAYLOADS[type] };
      expect(AgentEventSchema.parse(event)).toEqual(event);
    });
  }

  it("covers every variant of the closed set", () => {
    // `PAYLOADS` is keyed by the union, so a variant added without a payload
    // here is a compile error; this asserts the exported list agrees too.
    expect(Object.keys(PAYLOADS).sort()).toEqual(
      [...KNOWN_AGENT_EVENT_TYPES].sort(),
    );
  });

  it("keeps the whole envelope, optional fields included", () => {
    const event = {
      ...ENVELOPE,
      taskId: "t1",
      workerId: "w7",
      type: "task.held",
      data: PAYLOADS["task.held"],
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it("leaves an absent taskId absent rather than filling it in", () => {
    const parsed = AgentEventSchema.parse({
      ...ENVELOPE,
      type: "run.started",
      data: { objective: "ship it" },
    });
    expect("taskId" in parsed).toBe(false);
    expect("workerId" in parsed).toBe(false);
  });
});

describe("AgentEventSchema — malformed payloads", () => {
  const bad: readonly [string, unknown][] = [
    ["a payload-less known event", { ...ENVELOPE, type: "run.started" }],
    [
      "a missing required field",
      { ...ENVELOPE, type: "task.started", data: { attempt: 1 } },
    ],
    [
      "a field of the wrong type",
      {
        ...ENVELOPE,
        type: "task.started",
        data: { agent: "coder", attempt: "many" },
      },
    ],
    [
      "a payload that is not an object at all",
      { ...ENVELOPE, type: "task.escalated", data: [1, 2, 3] },
    ],
    [
      "a reason outside the closed set",
      { ...ENVELOPE, type: "task.cancelled", data: { reason: "bored" } },
    ],
    [
      "a result missing its test counts",
      {
        ...ENVELOPE,
        type: "task.completed",
        data: {
          agent: "coder",
          attempt: 1,
          final: true,
          result: { ...taskResult(), tests: undefined },
        },
      },
    ],
    [
      "an unusable envelope",
      { id: "e1", type: "run.started", data: { objective: "x" } },
    ],
    [
      "a non-numeric timestamp",
      {
        ...ENVELOPE,
        timestamp: "yesterday",
        type: "run.started",
        data: { objective: "x" },
      },
    ],
  ];

  for (const [name, value] of bad) {
    it(`rejects ${name}`, () => {
      expect(AgentEventSchema.safeParse(value).success).toBe(false);
      expect(KnownAgentEventSchema.safeParse(value).success).toBe(false);
    });
  }
});

describe("the pass-through namespaces", () => {
  it("accepts any codex.* and claude-code.* type, payload untouched", () => {
    for (const type of [
      `${CODEX_EVENT_PREFIX}thread.started`,
      `${CODEX_EVENT_PREFIX}some.type.shipped.next.week`,
      `${CLAUDE_CODE_EVENT_PREFIX}content_block_delta`,
      `${CLAUDE_CODE_EVENT_PREFIX}brand_new`,
    ]) {
      const data = { arbitrary: { nested: [1, 2, 3] } };
      const parsed = AgentEventSchema.parse({ ...ENVELOPE, type, data });
      expect(parsed.type).toBe(type);
      expect(parsed.data).toEqual(data);
    }
  });

  it("accepts a pass-through event with no payload at all", () => {
    const event = { ...ENVELOPE, type: `${CODEX_EVENT_PREFIX}turn.started` };
    const parsed = AgentEventSchema.parse(event);
    expect(parsed).toEqual(event);
    expect("data" in parsed).toBe(false);
  });

  it("does not let the open namespaces swallow a known type", () => {
    // `codex.*` matches by prefix only: a bare `task.started` must still be
    // held to its own payload rather than sliding into the loose member.
    expect(
      AgentEventSchema.safeParse({ ...ENVELOPE, type: "task.started" }).success,
    ).toBe(false);
  });
});

describe("parseAgentEvent — reading events back", () => {
  it("returns the typed variant for an event this build knows", () => {
    const event = {
      ...ENVELOPE,
      type: "loop.completed",
      data: PAYLOADS["loop.completed"],
    };
    expect(parseAgentEvent(event)).toEqual(event);
  });

  it("keeps a legacy type as a pass-through event rather than dropping it", () => {
    // The compatibility case: a row an older kapel wrote under a name this
    // build has no schema for. Type, envelope and payload all survive.
    const event = {
      ...ENVELOPE,
      taskId: "t1",
      type: "task.progress",
      data: { percent: 40 },
    };
    const parsed = parseAgentEvent(event);
    expect(parsed).toEqual(event);
    expect(parsed?.type).toBe("task.progress");
    expect(parsed?.data).toEqual({ percent: 40 });
  });

  it("keeps a legacy event that carries no payload", () => {
    const event = { ...ENVELOPE, type: "worker.progress" };
    expect(parseAgentEvent(event)).toEqual(event);
  });

  it("drops an event whose payload contradicts a tag consumers may trust", () => {
    // The deliberate limit on leniency: admitting this would hand a consumer
    // something typed as `task.started` with no `agent` on it.
    expect(
      parseAgentEvent({ ...ENVELOPE, type: "task.started", data: {} }),
    ).toBeUndefined();
  });

  it("drops anything without a usable envelope", () => {
    expect(parseAgentEvent(undefined)).toBeUndefined();
    expect(parseAgentEvent("task.started")).toBeUndefined();
    expect(parseAgentEvent({ type: "whatever" })).toBeUndefined();
    expect(
      parseAgentEvent({ id: "e1", runId: "r", timestamp: 1 }),
    ).toBeUndefined();
  });
});

describe("agentEvent", () => {
  it("stamps an id and a timestamp onto a body", () => {
    const before = Date.now();
    const event = agentEvent(
      { runId: "run-1" },
      { type: "run.started", data: { objective: "ship it" } },
    );
    expect(event.runId).toBe("run-1");
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it("omits taskId and workerId instead of writing them as undefined", () => {
    const event = agentEvent(
      { runId: "run-1" },
      { type: "loop.started", data: PAYLOADS["loop.started"] },
    );
    expect("taskId" in event).toBe(false);
    expect("workerId" in event).toBe(false);
  });

  it("carries taskId and workerId through when given", () => {
    const event = agentEvent(
      { runId: "run-1", taskId: "t1", workerId: "w7" },
      { type: "task.held", data: PAYLOADS["task.held"] },
    );
    expect(event).toMatchObject({ taskId: "t1", workerId: "w7" });
  });

  it("gives two events built back to back distinct ids", () => {
    const body = { type: "run.started", data: { objective: "x" } } as const;
    const first = agentEvent({ runId: "r" }, body);
    const second = agentEvent({ runId: "r" }, body);
    expect(first.id).not.toBe(second.id);
  });
});

describe("InMemoryEventBus", () => {
  const event = agentEvent(
    { runId: "run-1" },
    { type: "run.started", data: { objective: "ship it" } },
  );

  it("delivers to every subscriber and stops on unsubscribe", async () => {
    const bus = new InMemoryEventBus();
    const first: string[] = [];
    const second: string[] = [];
    const off = bus.subscribe((e) => {
      first.push(e.type);
    });
    bus.subscribe((e) => {
      second.push(e.type);
    });

    await bus.emit(event);
    off();
    await bus.emit(event);

    expect(first).toEqual(["run.started"]);
    expect(second).toEqual(["run.started", "run.started"]);
  });

  it("awaits an async listener before resolving", async () => {
    const bus = new InMemoryEventBus();
    let done = false;
    bus.subscribe(async () => {
      await Promise.resolve();
      done = true;
    });
    await bus.emit(event);
    expect(done).toBe(true);
  });
});
