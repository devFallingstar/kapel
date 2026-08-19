import type { ModelDefinition, ModelEvent, ModelProvider } from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import { PermissionEngine } from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS } from "../src/permissions.js";
import { TextRenderer } from "../src/render.js";
import {
  agentLoopOptions,
  DEFAULT_COMPACTION,
  DEFAULT_MAX_ITERATIONS,
} from "../src/run.js";

// --- fixtures ----------------------------------------------------------------

const MODEL: ModelDefinition = {
  provider: "anthropic",
  id: "claude-sonnet-5-x",
  capabilities: {
    tools: true,
    reasoning: false,
    vision: false,
    structuredOutput: true,
  },
};

const AGENT: AgentDefinition = {
  name: "agent",
  role: "worker",
  model: MODEL,
  systemPrompt: "You are a coding agent.",
  tools: [],
  permissions: DEFAULT_PERMISSIONS,
};

function provider(): ModelProvider {
  return {
    id: "anthropic",
    supports: () => true,
    // biome-ignore lint/correctness/useYield: never called in these tests.
    stream: async function* (): AsyncIterable<ModelEvent> {
      throw new Error("unreachable");
    },
  };
}

function permissions(): PermissionEngine {
  return new PermissionEngine(DEFAULT_PERMISSIONS, {
    defaultDecision: "ask",
  });
}

// --- tests ---------------------------------------------------------------

describe("DEFAULT_COMPACTION", () => {
  it("is an empty options object, deferring entirely to loop.ts's built-in defaults", () => {
    expect(DEFAULT_COMPACTION).toEqual({});
  });
});

describe("agentLoopOptions", () => {
  it("wires DEFAULT_COMPACTION into the constructed AgentLoopOptions", () => {
    const built = agentLoopOptions({
      agent: AGENT,
      provider: provider(),
      permissions: permissions(),
      usage: new UsageTracker(),
      events: new TextRenderer(),
      maxIterations: 8,
    });

    expect(built.compaction).toBe(DEFAULT_COMPACTION);
    expect(built.agent).toBe(AGENT);
    expect(built.maxIterations).toBe(8);
    // The full built-in tool set is always attached, regardless of what the
    // agent definition itself lists by name.
    expect(built.tools.length).toBeGreaterThan(0);
    expect(built.timeoutMs).toBeUndefined();
  });

  it("forwards timeoutMs only when given, matching the run.ts and interactive.ts call sites", () => {
    const withTimeout = agentLoopOptions({
      agent: AGENT,
      provider: provider(),
      permissions: permissions(),
      usage: new UsageTracker(),
      events: new TextRenderer(),
      maxIterations: 4,
      timeoutMs: 30_000,
    });
    expect(withTimeout.timeoutMs).toBe(30_000);

    const withoutTimeout = agentLoopOptions({
      agent: AGENT,
      provider: provider(),
      permissions: permissions(),
      usage: new UsageTracker(),
      events: new TextRenderer(),
      maxIterations: 4,
    });
    expect("timeoutMs" in withoutTimeout).toBe(false);
  });
});

describe("DEFAULT_MAX_ITERATIONS", () => {
  it("bounds a native turn's tool loop, with no flag to raise it", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_ITERATIONS)).toBe(true);
  });
});
