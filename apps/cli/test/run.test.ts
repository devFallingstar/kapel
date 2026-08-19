import { Readable } from "node:stream";
import type { ModelDefinition, ModelEvent, ModelProvider } from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import { PermissionEngine } from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS } from "../src/permissions.js";
import { TextRenderer } from "../src/render.js";
import {
  agentLoopOptions,
  composeObjectiveWithStdin,
  DEFAULT_COMPACTION,
  MAX_PIPED_STDIN_BYTES,
  objectiveWithPipedStdin,
  PIPED_STDIN_DELIMITER,
  readPipedStdin,
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

// --- P1-6: piped stdin merged into the objective --------------------------

/** A fake `process.stdin`-shaped stream, optionally flagged as a TTY. */
function fakeStdin(
  chunks: readonly (string | Buffer)[],
  isTTY = false,
): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = Readable.from(chunks) as NodeJS.ReadableStream & {
    isTTY?: boolean;
  };
  if (isTTY) stream.isTTY = true;
  return stream;
}

describe("readPipedStdin", () => {
  it("reads and concatenates every chunk as UTF-8 text", async () => {
    const text = await readPipedStdin(fakeStdin(["hello, ", "world"]));
    expect(text).toBe("hello, world");
  });

  it("returns an empty string for a stream that ends with no data", async () => {
    const text = await readPipedStdin(fakeStdin([]));
    expect(text).toBe("");
  });

  it("passes text within the cap through unchanged", async () => {
    const text = await readPipedStdin(fakeStdin(["short"]), 1024);
    expect(text).toBe("short");
  });

  it("truncates text past the cap and appends the marker", async () => {
    const text = await readPipedStdin(fakeStdin(["abcdefghij"]), 4);
    expect(text).toBe("abcd\n[stdin truncated]");
  });

  it("truncates correctly when the cap falls inside a later chunk", async () => {
    const text = await readPipedStdin(
      fakeStdin(["abcde", "fghij", "klmno"]),
      12,
    );
    expect(text).toBe("abcdefghijkl\n[stdin truncated]");
  });

  it("drains chunks arriving after the cap without including them", async () => {
    const text = await readPipedStdin(
      fakeStdin(["abcde", "this arrives after the cap is already hit"]),
      3,
    );
    expect(text).toBe("abc\n[stdin truncated]");
  });

  it("defaults the cap to MAX_PIPED_STDIN_BYTES (1 MiB)", async () => {
    const exactlyAtCap = "x".repeat(MAX_PIPED_STDIN_BYTES);
    expect(await readPipedStdin(fakeStdin([exactlyAtCap]))).toBe(exactlyAtCap);

    const oneOver = "x".repeat(MAX_PIPED_STDIN_BYTES + 1);
    expect(await readPipedStdin(fakeStdin([oneOver]))).toBe(
      `${"x".repeat(MAX_PIPED_STDIN_BYTES)}\n[stdin truncated]`,
    );
  });
});

describe("composeObjectiveWithStdin", () => {
  it("appends piped stdin after the delimiter", () => {
    const merged = composeObjectiveWithStdin(
      "explain this failure",
      "Error: boom\n  at foo.js:1:1",
    );
    expect(merged).toBe(
      `explain this failure${PIPED_STDIN_DELIMITER}Error: boom\n  at foo.js:1:1`,
    );
    // The documented shape from the roadmap item: objective, blank line,
    // a "--- piped input ---" section header, then the piped text.
    expect(merged).toBe(
      "explain this failure\n\n--- piped input ---\nError: boom\n  at foo.js:1:1",
    );
  });

  it("leaves the objective unchanged when piped stdin is empty", () => {
    expect(composeObjectiveWithStdin("do the thing", "")).toBe("do the thing");
  });
});

describe("objectiveWithPipedStdin", () => {
  it("merges piped stdin into the objective when stdin is not a TTY", async () => {
    const merged = await objectiveWithPipedStdin(
      "explain this failure",
      fakeStdin(["Error: boom"], false),
    );
    expect(merged).toBe(
      "explain this failure\n\n--- piped input ---\nError: boom",
    );
  });

  it("returns the objective unchanged for 0-byte piped stdin (case 4)", async () => {
    const merged = await objectiveWithPipedStdin(
      "explain this failure",
      fakeStdin([], false),
    );
    expect(merged).toBe("explain this failure");
  });

  it("never reads stdin when it is a TTY (case 3)", async () => {
    const stream = fakeStdin(["should never be read"], true);
    let read = false;
    stream.on("data", () => {
      read = true;
    });
    const merged = await objectiveWithPipedStdin("do the thing", stream);
    expect(merged).toBe("do the thing");
    expect(read).toBe(false);
  });

  it("carries a truncation marker through when piped stdin exceeds the cap", async () => {
    const oneOver = "x".repeat(MAX_PIPED_STDIN_BYTES + 1);
    const merged = await objectiveWithPipedStdin(
      "summarize",
      fakeStdin([oneOver], false),
    );
    expect(merged).toBe(
      `summarize\n\n--- piped input ---\n${"x".repeat(MAX_PIPED_STDIN_BYTES)}\n[stdin truncated]`,
    );
  });
});
