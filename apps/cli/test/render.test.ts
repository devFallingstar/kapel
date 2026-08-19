import { UsageTracker } from "@agent/ai";
import type { AgentLoopResult, CodexRunResult } from "@agent/coding-agent";
import type { AgentEvent } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import { TextRenderer } from "../src/render.js";

/** Minimal fake `NodeJS.WritableStream` that just captures every write. */
class CapturingStream {
  readonly isTTY = false;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get lines(): string[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line !== "");
  }
}

function renderer(): { renderer: TextRenderer; stream: CapturingStream } {
  const stream = new CapturingStream();
  return {
    renderer: new TextRenderer(stream as unknown as NodeJS.WritableStream),
    stream,
  };
}

function codexEvent(type: string, data: unknown): AgentEvent {
  return {
    id: "evt-1",
    runId: "run-1",
    timestamp: 0,
    type,
    data,
  };
}

describe("TextRenderer / codex.* events", () => {
  it("prints the agent_message text from a top-level item", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        type: "item.completed",
        item: { type: "agent_message", text: "Hello from codex" },
      }),
    );
    expect(stream.lines).toEqual(["Hello from codex"]);
  });

  it("prints the agent_message text when wrapped in msg.item", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        msg: {
          type: "item.completed",
          item: { type: "agent_message", text: "Wrapped hello" },
        },
      }),
    );
    expect(stream.lines).toEqual(["Wrapped hello"]);
  });

  it("extracts agent_message text from array content parts", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        item: {
          type: "agent_message",
          content: [{ text: "part one " }, { text: "part two" }],
        },
      }),
    );
    expect(stream.lines).toEqual(["part one part two"]);
  });

  it("prints a command_execution item with the → codex: prefix", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        item: { type: "command_execution", command: "npm test" },
      }),
    );
    expect(stream.lines).toEqual(["→ codex: npm test"]);
  });

  it("truncates a long command_execution to ~120 chars", () => {
    const { renderer: r, stream } = renderer();
    const longCommand = "echo ".repeat(40).trim();
    r.emit(
      codexEvent("codex.item.completed", {
        item: { type: "command_execution", command: longCommand },
      }),
    );
    expect(stream.lines).toHaveLength(1);
    const line = stream.lines[0] as string;
    expect(line.startsWith("→ codex: ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual("→ codex: ".length + 120);
    expect(line).toContain("…");
  });

  it("joins an argv array for command_execution", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        item: { type: "command_execution", argv: ["ls", "-la", "/tmp"] },
      }),
    );
    expect(stream.lines).toEqual(["→ codex: ls -la /tmp"]);
  });

  it("prints a file_change item with the ✎ prefix", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        item: { type: "file_change", path: "src/foo.ts" },
      }),
    );
    expect(stream.lines).toEqual(["✎ src/foo.ts"]);
  });

  it("summarizes a file_change changes array when no path/summary is given", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.completed", {
        item: {
          type: "file_change",
          changes: [{ path: "a.ts" }, { path: "b.ts" }],
        },
      }),
    );
    expect(stream.lines).toEqual(["✎ a.ts, b.ts"]);
  });

  it("stays quiet for turn.completed usage rollups", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.turn.completed", {
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    expect(stream.lines).toEqual([]);
  });

  it("stays quiet for the synthetic codex.completed marker", () => {
    const { renderer: r, stream } = renderer();
    r.emit(codexEvent("codex.completed", { status: "success", exitCode: 0 }));
    expect(stream.lines).toEqual([]);
  });

  it("stays quiet for an unrecognized codex.* event type", () => {
    const { renderer: r, stream } = renderer();
    r.emit(codexEvent("codex.some_future_event", { anything: "goes" }));
    expect(stream.lines).toEqual([]);
  });

  it("stays quiet for an item type it doesn't recognize", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      codexEvent("codex.item.started", {
        item: { type: "reasoning", text: "thinking..." },
      }),
    );
    expect(stream.lines).toEqual([]);
  });
});

describe("TextRenderer / task.* lifecycle events", () => {
  function taskEvent(type: string, data: unknown, taskId = "T01"): AgentEvent {
    return { id: "evt-1", runId: "run-1", timestamp: 0, type, taskId, data };
  }

  it("announces a started task with its agent and attempt", () => {
    const { renderer: r, stream } = renderer();
    r.emit(taskEvent("task.started", { agent: "coder", attempt: 1 }));
    expect(stream.lines).toEqual(["▶ T01 → coder (attempt 1)"]);
  });

  it("marks a successful task with ✔ and its summary's first line", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.completed", {
        agent: "coder",
        final: true,
        result: { status: "success", summary: "Added the endpoint.\nDetails." },
      }),
    );
    expect(stream.lines).toEqual(["✔ T01 — Added the endpoint."]);
  });

  it("marks a failed task with ✖ and flags a non-final attempt as retrying", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.completed", {
        agent: "coder",
        final: false,
        result: { status: "failed", summary: "Build broke" },
      }),
    );
    expect(stream.lines).toEqual(["✖ T01 — Build broke (retrying)"]);
  });

  it("renders a summary-less result without inventing text", () => {
    const { renderer: r, stream } = renderer();
    r.emit(taskEvent("task.completed", { result: { status: "failed" } }));
    expect(stream.lines).toEqual(["✖ T01 — (no summary)"]);
  });

  it("shows an escalation as a reroute between agents", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.escalated", {
        from: "coder",
        to: "lead",
        rule: "esc-retry",
      }),
    );
    expect(stream.lines).toEqual(["↑ T01 rerouted coder → lead"]);
  });

  it("shows a cancellation with its reason", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent(
        "task.cancelled",
        { reason: "dependency-failed", dependency: "T02" },
        "T03",
      ),
    );
    expect(stream.lines).toEqual(["⊘ T03 (dependency-failed)"]);
  });

  it("still renders worker loop events flowing through the same sink", () => {
    const { renderer: r, stream } = renderer();
    r.emit(taskEvent("model.turn.completed", { text: "thinking out loud" }));
    expect(stream.lines).toEqual(["thinking out loud"]);
  });
});

describe("TextRenderer#result / CodexRunResult", () => {
  it("shows the summary but no exit-code line on a clean success", () => {
    const { renderer: r, stream } = renderer();
    const result: CodexRunResult = {
      status: "success",
      summary: "Fixed the failing test.",
      exitCode: 0,
      events: 3,
    };
    r.result(result, new UsageTracker().totals());
    const text = stream.chunks.join("");
    expect(text).toContain("status: success");
    expect(text).toContain("Fixed the failing test.");
    expect(text).not.toContain("exit code:");
  });

  it("shows the exit code when non-zero", () => {
    const { renderer: r, stream } = renderer();
    const result: CodexRunResult = {
      status: "failed",
      summary: "Codex exited with code 1: boom",
      exitCode: 1,
      events: 1,
    };
    r.result(result, new UsageTracker().totals());
    expect(stream.chunks.join("")).toContain("exit code: 1");
  });

  it("prefers the result's own usage over the (zero) UsageTracker totals", () => {
    const { renderer: r, stream } = renderer();
    const result: CodexRunResult = {
      status: "success",
      summary: "Done.",
      exitCode: 0,
      events: 2,
      usage: { inputTokens: 123, outputTokens: 45 },
    };
    r.result(result, new UsageTracker().totals());
    const text = stream.chunks.join("");
    expect(text).toContain("input: 123");
    expect(text).toContain("output: 45");
  });

  it("omits the tokens line when codex reported no usage", () => {
    const { renderer: r, stream } = renderer();
    const result: CodexRunResult = {
      status: "success",
      summary: "Done.",
      exitCode: 0,
      events: 0,
    };
    r.result(result, new UsageTracker().totals());
    expect(stream.chunks.join("")).not.toContain("tokens —");
  });

  it("still renders native AgentLoopResult results the old way", () => {
    const { renderer: r, stream } = renderer();
    const result: AgentLoopResult = {
      status: "success",
      summary: "All good.",
      iterations: 3,
      toolCalls: 5,
    };
    r.result(result, new UsageTracker().totals());
    const text = stream.chunks.join("");
    expect(text).toContain("iterations: 3  tool calls: 5");
    expect(text).not.toContain("exit code:");
  });
});
