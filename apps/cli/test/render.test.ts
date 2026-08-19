import { UsageTracker } from "@agent/ai";
import type { AgentLoopResult, CodexRunResult } from "@agent/coding-agent";
import type { AgentEvent } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import { JsonRenderer, TextRenderer } from "../src/render.js";

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

describe("TextRenderer / context.compacted events", () => {
  it("renders elided count and chars saved", () => {
    const { renderer: r, stream } = renderer();
    r.emit(codexEvent("context.compacted", { elided: 5, savedChars: 12345 }));
    expect(stream.lines).toEqual([
      "≈ context compacted: 5 tool results elided, 12345 chars saved",
    ]);
  });

  it("uses the singular for exactly one elided result", () => {
    const { renderer: r, stream } = renderer();
    r.emit(codexEvent("context.compacted", { elided: 1, savedChars: 400 }));
    expect(stream.lines).toEqual([
      "≈ context compacted: 1 tool result elided, 400 chars saved",
    ]);
  });

  it("falls back to zero for a malformed payload rather than throwing", () => {
    const { renderer: r, stream } = renderer();
    r.emit(codexEvent("context.compacted", {}));
    expect(stream.lines).toEqual([
      "≈ context compacted: 0 tool results elided, 0 chars saved",
    ]);
  });
});

describe("TextRenderer / claude-code.* events", () => {
  function claudeEvent(type: string, data: unknown): AgentEvent {
    return { id: "evt-1", runId: "run-1", timestamp: 0, type, data };
  }

  it("buffers streamed text and writes it once the block ends", () => {
    const { renderer: r, stream } = renderer();
    for (const text of ["Fixed ", "the ", "test."]) {
      r.emit(
        claudeEvent("claude-code.content_block_delta", {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        }),
      );
    }
    expect(stream.lines).toEqual([]);

    r.emit(
      claudeEvent("claude-code.content_block_stop", {
        type: "stream_event",
        event: { type: "content_block_stop" },
      }),
    );
    expect(stream.lines).toEqual(["Fixed the test."]);
  });

  it("names each tool as it starts", () => {
    const { renderer: r, stream } = renderer();
    r.emit(claudeEvent("claude-code.tool_use", { name: "Edit", id: "t1" }));
    expect(stream.lines).toEqual(["→ claude: Edit"]);
  });

  it("stays quiet for the events it does not model", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      claudeEvent("claude-code.message_start", {
        event: { type: "message_start" },
      }),
    );
    r.emit(claudeEvent("claude-code.completed", { status: "success" }));
    expect(stream.lines).toEqual([]);
  });

  it("reports a Claude Code result with its exit code and usage", () => {
    const { renderer: r, stream } = renderer();
    r.result(
      {
        status: "failed",
        summary: "Claude Code exited with code 1: nope",
        exitCode: 1,
        usage: { inputTokens: 12, outputTokens: 3 },
        events: 4,
      },
      new UsageTracker().totals(),
    );
    expect(stream.lines).toEqual([
      "status: failed",
      "Claude Code exited with code 1: nope",
      "exit code: 1",
      "tokens — input: 12, output: 3",
    ]);
  });
});

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

  it("shows the resolved model and the matched rule for a rule-routed task", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.started", {
        agent: "coder",
        attempt: 1,
        model: "claude-haiku-4-5",
        routing: { rule: "implementation", reason: "rule" },
      }),
    );
    expect(stream.lines).toEqual([
      "▶ T01 → coder [claude-haiku-4-5] (rule: implementation, attempt 1)",
    ]);
  });

  it("shows 'default' when no routing rule matched (orchestrator fallback)", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.started", {
        agent: "architect",
        attempt: 1,
        model: "claude-opus-4-5",
        routing: { reason: "orchestrator" },
      }),
    );
    expect(stream.lines).toEqual([
      "▶ T01 → architect [claude-opus-4-5] (default, attempt 1)",
    ]);
  });

  it("shows 'suggested' when the task's own suggestedAgent was used", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.started", {
        agent: "implementer",
        attempt: 1,
        routing: { reason: "suggestedAgent" },
      }),
    );
    expect(stream.lines).toEqual([
      "▶ T01 → implementer (suggested, attempt 1)",
    ]);
  });

  it("shows the escalation rule and new model on an escalated retry", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      taskEvent("task.started", {
        agent: "architect",
        attempt: 2,
        model: "claude-opus-4-5",
        routing: { rule: "stuck", reason: "escalation" },
      }),
    );
    expect(stream.lines).toEqual([
      "▶ T01 → architect [claude-opus-4-5] (escalation: stuck, attempt 2)",
    ]);
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

describe("TextRenderer / worktree.* events", () => {
  function worktreeEvent(
    type: string,
    data: unknown,
    taskId = "T01",
  ): AgentEvent {
    return { id: "evt-1", runId: "run-1", timestamp: 0, type, taskId, data };
  }

  it("names the branch a task's checkout was created on", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.created", {
        branch: "agent-task/run-1/T01",
        path: "/repo/.agent/worktrees/run-1/T01",
      }),
    );
    expect(stream.lines).toEqual([
      "⎇ T01 worktree created (agent-task/run-1/T01)",
    ]);
  });

  it("shows a merge with the short commit it landed as", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.integrated", {
        merged: true,
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    );
    expect(stream.lines).toEqual(["⇡ T01 merged → 01234567"]);
  });

  it("shows the conflicting files when the merge did not happen", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.integrated", {
        merged: false,
        reason: "conflicts",
        conflictFiles: ["src/a.ts", "src/b.ts"],
      }),
    );
    expect(stream.lines).toEqual(["⚠ T01 merge conflict: src/a.ts, src/b.ts"]);
  });

  it("falls back to the reason when nothing conflicted", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.integrated", {
        merged: false,
        reason: "dirty-base",
        conflictFiles: [],
      }),
    );
    expect(stream.lines).toEqual(["⚠ T01 not merged (dirty-base)"]);
  });

  it("mentions a preserved branch but stays quiet about a clean removal", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.removed", {
        keptBranch: true,
        branch: "agent-task/run-1/T01",
      }),
    );
    r.emit(
      worktreeEvent("worktree.removed", {
        keptBranch: false,
        branch: "agent-task/run-1/T02",
      }),
    );
    expect(stream.lines).toEqual(["⎇ T01 branch kept: agent-task/run-1/T01"]);
  });
});

describe("TextRenderer / validation.* events", () => {
  function validationEvent(
    type: string,
    data: unknown,
    taskId = "T01",
  ): AgentEvent {
    return { id: "evt-1", runId: "run-1", timestamp: 0, type, taskId, data };
  }

  it("announces a validator starting, dimmed", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      validationEvent("validation.started", {
        name: "typecheck",
        command: "npm run typecheck",
      }),
    );
    expect(stream.lines).toEqual(["⚙ T01 validator typecheck…"]);
  });

  it("marks a passing validator with its duration", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      validationEvent("validation.completed", {
        name: "typecheck",
        passed: true,
        exitCode: 0,
        durationMs: 1234,
      }),
    );
    expect(stream.lines).toEqual(["  ✓ typecheck (1.2s)"]);
  });

  it("marks a failing validator with its exit code and duration", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      validationEvent("validation.completed", {
        name: "typecheck",
        passed: false,
        exitCode: 1,
        durationMs: 3400,
      }),
    );
    expect(stream.lines).toEqual(["  ✗ typecheck (exit 1, 3.4s)"]);
  });

  it("reports an unknown exit code when the process was killed by a signal", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      validationEvent("validation.completed", {
        name: "test",
        passed: false,
        exitCode: null,
        durationMs: 600000,
      }),
    );
    expect(stream.lines).toEqual(["  ✗ test (exit unknown, 600.0s)"]);
  });
});

describe("TextRenderer / task.low_confidence events", () => {
  function lowConfidenceEvent(data: unknown, taskId = "T01"): AgentEvent {
    return {
      id: "evt-1",
      runId: "run-1",
      timestamp: 0,
      type: "task.low_confidence",
      taskId,
      data,
    };
  }

  it("reports a low-confidence result that will be redone", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      lowConfidenceEvent({
        agent: "implementer",
        confidence: 0.3,
        threshold: 0.6,
        rule: "low-conf",
      }),
    );
    expect(stream.lines).toEqual([
      "↻ T01 low confidence 0.30 < 0.60 — redoing",
    ]);
  });

  it("reports a low-confidence result accepted once attempts are exhausted", () => {
    const { renderer: r, stream } = renderer();
    r.emit(
      lowConfidenceEvent({
        agent: "implementer",
        confidence: 0.3,
        threshold: 0.6,
        rule: "low-conf",
        accepted: true,
      }),
    );
    expect(stream.lines).toEqual([
      "↻ T01 low confidence 0.30 < 0.60 — accepted (attempts exhausted)",
    ]);
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

describe("JsonRenderer / task.started model and routing", () => {
  it("passes the model and routing fields through to the JSONL line untouched", () => {
    const chunks: string[] = [];
    const stream = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const r = new JsonRenderer(stream);

    const event: AgentEvent = {
      id: "evt-1",
      runId: "run-1",
      timestamp: 0,
      type: "task.started",
      taskId: "T01",
      data: {
        agent: "coder",
        attempt: 1,
        model: "claude-haiku-4-5",
        routing: { rule: "implementation", reason: "rule" },
      },
    };
    r.emit(event);

    expect(JSON.parse(chunks.join(""))).toEqual(event);
  });
});
