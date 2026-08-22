import type { UsageBreakdown } from "@agent/ai";
import { UNATTRIBUTED, UsageTracker } from "@agent/ai";
import type { AgentLoopResult, CodexRunResult } from "@agent/coding-agent";
import type { AgentEvent } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  formatCostUsd,
  formatTokenCount,
  formatTokenFlow,
  JsonRenderer,
  TextRenderer,
  usageBreakdownLine,
  usageRollupLines,
} from "../src/render.js";
import { StatusLine } from "../src/status-line.js";
import { stylesFor } from "../src/styles.js";

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

  it("streams text as it arrives and terminates the line when the block ends", () => {
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
    // Every chunk is on screen the moment it arrives — not held to the end of
    // the block — and nothing has terminated the line yet.
    expect(stream.chunks).toEqual(["Fixed ", "the ", "test."]);

    r.emit(
      claudeEvent("claude-code.content_block_stop", {
        type: "stream_event",
        event: { type: "content_block_stop" },
      }),
    );
    expect(stream.chunks.at(-1)).toBe("\n");
    expect(stream.lines).toEqual(["Fixed the test."]);
  });

  it("buffers a delegated task's text to the end of the block", () => {
    const { renderer: r, stream } = renderer();
    const taskEvent = (type: string, data: unknown): AgentEvent => ({
      id: "evt-1",
      runId: "run-1",
      taskId: "T01",
      timestamp: 0,
      type,
      data,
    });
    for (const text of ["Fixed ", "the ", "test."]) {
      r.emit(
        taskEvent("claude-code.content_block_delta", {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        }),
      );
    }
    // One task among several cannot own a partial line on a shared terminal.
    expect(stream.lines).toEqual([]);

    r.emit(
      taskEvent("claude-code.content_block_stop", {
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

  it("names the offending paths on a dirty-base refusal", () => {
    // "dirty-base" on its own leaves the reader with nothing to fix; the
    // detail the manager already built says which paths are in the way.
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.integrated", {
        merged: false,
        reason: "dirty-base",
        conflictFiles: [],
        detail: "base working tree has uncommitted changes: src/app.ts",
      }),
    );
    expect(stream.lines).toEqual([
      "⚠ T01 not merged (dirty-base): base working tree has uncommitted changes: src/app.ts",
    ]);
  });

  it("passes through the remedy suggestion on a dirty-base detail", () => {
    // worktrees.ts appends a remedy for real user files past the path list;
    // the renderer just prints whatever detail it is given, verbatim.
    const { renderer: r, stream } = renderer();
    r.emit(
      worktreeEvent("worktree.integrated", {
        merged: false,
        reason: "dirty-base",
        conflictFiles: [],
        detail:
          "base working tree has uncommitted changes: src/app.ts; commit or stash them, or add generated files to .gitignore",
      }),
    );
    expect(stream.lines).toEqual([
      "⚠ T01 not merged (dirty-base): base working tree has uncommitted changes: src/app.ts; commit or stash them, or add generated files to .gitignore",
    ]);
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

/** Erase-the-line sequence the status line writes; see `status-line.ts`. */
const ERASE_SEQ = "\r\u001b[2K";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

// --- P0-2: streamed turn text and the status line ---------------------------

/** A capturing stream that claims to be a terminal, so the status line arms. */
class TtyStream extends CapturingStream {
  override readonly isTTY = true;
  readonly columns = 80;
}

/** Anything a pipe must never see: `\r`, `\b`, ESC and friends. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the assertion.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f]/;

function loopEvent(
  type: string,
  data: unknown = {},
  taskId?: string,
): AgentEvent {
  return {
    id: `evt-${type}`,
    runId: "run-1",
    timestamp: 0,
    type,
    ...(taskId === undefined ? {} : { taskId }),
    data,
  };
}

function delta(text: string, taskId?: string): AgentEvent {
  return loopEvent("model.text.delta", { text, iteration: 1 }, taskId);
}

/** A renderer over a fake TTY, with a status line that only paints on demand. */
function ttyRenderer(options: { tokens?: () => number } = {}): {
  renderer: TextRenderer;
  stream: TtyStream;
  clock: { ms: number };
} {
  const stream = new TtyStream();
  const clock = { ms: 0 };
  const status = new StatusLine({
    output: stream as unknown as NodeJS.WritableStream & { isTTY?: boolean },
    tty: true,
    now: () => clock.ms,
    // No timer at all: every paint in these tests is one the renderer asked
    // for, which is what makes the byte sequence assertable.
    ticker: () => () => undefined,
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  });
  return {
    renderer: new TextRenderer(stream as unknown as NodeJS.WritableStream, {
      status,
    }),
    stream,
    clock,
  };
}

describe("TextRenderer / streamed model text", () => {
  it("writes each delta as it arrives, with no line of its own", () => {
    const { renderer: r, stream } = renderer();
    r.emit(delta("Hel"));
    r.emit(delta("lo, "));
    r.emit(delta("world."));
    expect(stream.chunks).toEqual(["Hel", "lo, ", "world."]);
  });

  it("does not reprint the turn's text once it has been streamed", () => {
    const { renderer: r, stream } = renderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(delta("Hello, "));
    r.emit(delta("world."));
    r.emit(
      loopEvent("model.turn.completed", {
        text: "Hello, world.",
        toolCallCount: 0,
        finishReason: "stop",
      }),
    );
    r.emit(loopEvent("loop.completed", { status: "success" }));

    expect(stream.chunks.join("")).toBe("Hello, world.\n");
    expect(stream.lines).toEqual(["Hello, world."]);
  });

  it("prints the whole turn when nothing was streamed for it", () => {
    const { renderer: r, stream } = renderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(
      loopEvent("model.turn.completed", {
        text: "A non-streaming provider said this.",
        toolCallCount: 0,
      }),
    );
    expect(stream.lines).toEqual(["A non-streaming provider said this."]);
  });

  it("streams each turn independently: a second turn still falls back", () => {
    const { renderer: r, stream } = renderer();
    r.emit(delta("streamed"));
    r.emit(loopEvent("model.turn.completed", { text: "streamed" }));
    r.emit(loopEvent("model.turn.completed", { text: "not streamed" }));
    expect(stream.lines).toEqual(["streamed", "not streamed"]);
  });

  it("terminates the streamed line before a tool line is printed", () => {
    const { renderer: r, stream } = renderer();
    r.emit(delta("Let me look."));
    r.emit(
      loopEvent("tool.execution.started", {
        tool: "bash",
        input: { command: "ls" },
      }),
    );
    r.emit(loopEvent("tool.execution.completed", { tool: "bash", ok: true }));

    expect(stream.lines).toEqual([
      "Let me look.",
      '\u2192 bash {"command":"ls"}',
      "  \u2713",
    ]);
  });

  it("ignores a delta belonging to a task, and still prints that turn whole", () => {
    const { renderer: r, stream } = renderer();
    r.emit(delta("partial ", "T01"));
    r.emit(loopEvent("model.turn.completed", { text: "partial text" }, "T01"));
    expect(stream.lines).toEqual(["partial text"]);
  });

  it("leaks no control characters into a non-TTY stream", () => {
    const { renderer: r, stream } = renderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(delta("thinking out loud"));
    r.emit(loopEvent("model.turn.completed", { text: "thinking out loud" }));
    r.emit(
      loopEvent("tool.execution.started", { tool: "bash", input: { a: 1 } }),
    );
    r.emit(loopEvent("tool.execution.completed", { tool: "bash", ok: true }));
    r.emit(loopEvent("loop.completed", { status: "success" }));

    const text = stream.chunks.join("");
    expect(CONTROL_CHARS.test(text)).toBe(false);
    expect(text).not.toContain("\r");
  });

  it("ends a streamed line before the REPL's own output lands", () => {
    const { renderer: r, stream } = renderer();
    r.emit(delta("Done."));
    r.line("tokens +12 in, +3 out");
    expect(stream.lines).toEqual(["Done.", "tokens +12 in, +3 out"]);
  });
});

describe("TextRenderer / status line", () => {
  it("shows a spinner, the elapsed seconds and the token count on a TTY", () => {
    const { renderer: r, stream, clock } = ttyRenderer({ tokens: () => 1234 });
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    clock.ms = 3000;
    r.emit(loopEvent("tool.execution.completed", { tool: "bash", ok: true }));

    const painted = stream.chunks.filter((chunk) => chunk.includes("thinking"));
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.at(-1)).toContain("thinking 3s");
    expect(painted.at(-1)).toContain("1.2k tokens");
  });

  it("names the tool it is waiting on", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(
      loopEvent("tool.execution.started", { tool: "bash", input: { a: 1 } }),
    );
    expect(stream.chunks.at(-1)).toContain("bash 0s");
  });

  it("erases the status line immediately before real output", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(
      loopEvent("tool.execution.started", { tool: "bash", input: { a: 1 } }),
    );

    const text = stream.chunks.join("");
    // The erase sequence is the last thing written before the tool line.
    expect(text).toContain(`${ERASE_SEQ}${DIM}\u2192${RESET} bash`);
  });

  it("stops the status line while text is streaming", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(delta("Hello"));
    expect(stream.chunks.at(-1)).toBe("Hello");
    expect(stream.chunks.at(-2)).toBe(ERASE_SEQ);
  });

  it("leaves nothing on screen once the turn ends", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.emit(loopEvent("loop.started", { agent: "agent" }));
    r.emit(loopEvent("loop.completed", { status: "success" }));
    expect(stream.chunks.at(-1)).toBe(ERASE_SEQ);
  });

  it("never arms off a TTY", () => {
    const { renderer: r, stream } = renderer();
    r.emit(loopEvent("chat.turn.started", { turn: 1 }));
    r.emit(loopEvent("chat.turn.completed", { turn: 1, status: "success" }));
    expect(stream.chunks).toEqual([]);
  });
});

// --- The role palette on a terminal -----------------------------------------

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const BOLD = "\u001b[1m";

describe("TextRenderer / roles on a terminal", () => {
  it("marks a finished tool call green and a failed one red", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.emit(loopEvent("tool.execution.completed", { ok: true }));
    expect(stream.chunks.join("")).toContain(`${GREEN}\u2713${RESET}`);

    const failed = ttyRenderer();
    failed.renderer.emit(
      loopEvent("tool.execution.completed", { ok: false, denied: true }),
    );
    const text = failed.stream.chunks.join("");
    expect(text).toContain(`${RED}\u2717${RESET}`);
    expect(text).toContain(`${DIM}(denied)${RESET}`);
  });

  it("leaves assistant text undecorated — it is the content, not the frame", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.emit(delta("Hello"));
    expect(stream.chunks.at(-1)).toBe("Hello");
  });

  it("colours the run's verdict by what it says, and keeps it bold", () => {
    const { renderer: r, stream } = ttyRenderer();
    r.result(
      {
        status: "success",
        summary: "Done.",
        exitCode: 0,
        events: 1,
      } as CodexRunResult,
      new UsageTracker().totals(),
    );
    expect(stream.chunks.join("")).toContain(`${GREEN}${BOLD}status: success`);
  });

  it("writes not one escape when NO_COLOR is set, TTY or not", () => {
    const stream = new TtyStream();
    const r = new TextRenderer(stream as unknown as NodeJS.WritableStream, {
      styles: stylesFor(stream, { NO_COLOR: "1" }),
      status: new StatusLine({ tty: false }),
    });
    r.emit(loopEvent("tool.execution.started", { tool: "bash", input: {} }));
    r.emit(loopEvent("tool.execution.completed", { ok: true }));
    expect(stream.chunks.join("")).not.toContain("\u001b[");
  });
});

describe("JsonRenderer / model.text.delta", () => {
  it("passes deltas through as their own JSONL lines, unchanged", () => {
    const stream = new CapturingStream();
    const r = new JsonRenderer(stream as unknown as NodeJS.WritableStream);

    const event = delta("Hel");
    r.emit(event);
    r.emit(
      loopEvent("model.turn.completed", { text: "Hello", toolCallCount: 0 }),
    );

    const lines = stream.chunks
      .join("")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown);
    expect(lines[0]).toEqual(event);
    expect(lines[1]).toMatchObject({
      type: "model.turn.completed",
      data: { text: "Hello", toolCallCount: 0 },
    });
  });
});

describe("cost attribution formatting", () => {
  function entry(overrides: Partial<UsageBreakdown> = {}): UsageBreakdown {
    return {
      key: "claude-opus-5",
      usage: { inputTokens: 12_345, outputTokens: 2_100 },
      costUsd: 0.42,
      pricing: "known",
      models: ["claude-opus-5"],
      agents: ["orchestrator"],
      tasks: ["T01"],
      samples: 1,
      ...overrides,
    };
  }

  it("abbreviates token counts without inventing precision", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1.0k");
    expect(formatTokenCount(12_345)).toBe("12.3k");
    expect(formatTokenCount(2_400_000)).toBe("2.4M");
  });

  it("renders an unpriced bucket as n/a rather than $0.00", () => {
    expect(formatCostUsd(0, "unknown")).toBe("n/a");
    expect(formatCostUsd(1.23, "unknown")).toBe("n/a");
    expect(formatCostUsd(0, "known")).toBe("$0.0000");
    expect(formatCostUsd(0.0031, "known")).toBe("$0.0031");
    expect(formatCostUsd(0.42, "known")).toBe("$0.42");
    expect(formatCostUsd(0.42, "partial")).toBe("$0.42+");
  });

  it("spells out a bucket's tokens, cached input included", () => {
    expect(formatTokenFlow({ inputTokens: 12_345, outputTokens: 2_100 })).toBe(
      "12.3k in / 2.1k out",
    );
    expect(
      formatTokenFlow({
        inputTokens: 12_345,
        outputTokens: 2_100,
        cachedInputTokens: 4_000,
      }),
    ).toBe("12.3k in (4.0k cached) / 2.1k out");
  });

  it("counts only real tasks in a rollup line", () => {
    expect(usageBreakdownLine(entry(), { countTasks: true })).toBe(
      "claude-opus-5: 1 task · 12.3k in / 2.1k out · $0.42",
    );
    expect(
      usageBreakdownLine(entry({ tasks: ["T01", "T02", "T03"] }), {
        countTasks: true,
      }),
    ).toBe("claude-opus-5: 3 tasks · 12.3k in / 2.1k out · $0.42");
    // Planning is attributed to a model but to no task.
    expect(
      usageBreakdownLine(entry({ tasks: [UNATTRIBUTED] }), {
        countTasks: true,
      }),
    ).toBe("claude-opus-5: 0 tasks · 12.3k in / 2.1k out · $0.42");
    expect(usageBreakdownLine(entry())).toBe(
      "claude-opus-5: 12.3k in / 2.1k out · $0.42",
    );
  });

  it("orders the rollup by spend, then by tokens", () => {
    const breakdown = new Map<string, UsageBreakdown>([
      [
        "claude-haiku-4-5",
        entry({
          key: "claude-haiku-4-5",
          usage: { inputTokens: 30_000, outputTokens: 6_000 },
          costUsd: 0.03,
          tasks: ["T01", "T02", "T03"],
        }),
      ],
      ["claude-opus-5", entry()],
      [
        "gpt-5.1",
        entry({
          key: "gpt-5.1",
          usage: { inputTokens: 900, outputTokens: 100 },
          costUsd: 0,
          pricing: "unknown",
          tasks: ["T04"],
        }),
      ],
    ]);

    expect(usageRollupLines(breakdown, { countTasks: true })).toEqual([
      "claude-opus-5: 1 task · 12.3k in / 2.1k out · $0.42",
      "claude-haiku-4-5: 3 tasks · 30.0k in / 6.0k out · $0.03",
      "gpt-5.1: 1 task · 900 in / 100 out · n/a",
    ]);
  });
});

// --- typing into the running turn -------------------------------------------

/**
 * A renderer over a fake TTY whose status block can be told what the user is
 * typing, the way `runInteractive` wires the `InputManager` into it.
 */
function steerableRenderer(pending: { row: string | undefined }): {
  renderer: TextRenderer;
  stream: TtyStream;
} {
  const stream = new TtyStream();
  const status = new StatusLine({
    output: stream as unknown as NodeJS.WritableStream & { isTTY?: boolean },
    tty: true,
    now: () => 0,
    ticker: () => () => undefined,
    pending: () => pending.row,
  });
  return {
    renderer: new TextRenderer(stream as unknown as NodeJS.WritableStream, {
      status,
      pending: () => pending.row,
    }),
    stream,
  };
}

describe("TextRenderer — typing into the running turn", () => {
  it("interjects a notice without taking the turn's status down", () => {
    const pending = { row: undefined as string | undefined };
    const { renderer: r, stream } = steerableRenderer(pending);
    r.emit(loopEvent("chat.turn.started", { turn: 1 }));

    stream.chunks.length = 0;
    r.interject("→ queued — runs after this turn");

    const text = stream.chunks.join("");
    expect(text).toContain("→ queued — runs after this turn");
    // Repainted afterwards: the turn is still running, and the spinner is
    // still the thing showing that it is.
    expect(text.indexOf("thinking")).toBeGreaterThan(text.indexOf("→ queued"));
  });

  it("holds streamed text while a line is being typed, and releases it when the line is sent", () => {
    const pending = { row: "> wait" as string | undefined };
    const { renderer: r, stream } = steerableRenderer(pending);
    r.emit(loopEvent("chat.turn.started", { turn: 1 }));

    stream.chunks.length = 0;
    r.emit(delta("Hello, "));
    r.emit(delta("world."));
    expect(stream.chunks.join("")).not.toContain("Hello");

    pending.row = undefined;
    r.pendingChanged();
    expect(stream.chunks.join("")).toContain("Hello, world.");
  });

  it("lets held text through once it has grown past the bound", () => {
    const pending = { row: "> wait" as string | undefined };
    const { renderer: r, stream } = steerableRenderer(pending);
    r.emit(loopEvent("chat.turn.started", { turn: 1 }));

    stream.chunks.length = 0;
    r.emit(delta("x".repeat(4001)));
    expect(stream.chunks.join("")).not.toContain("x");
    r.emit(delta("y"));
    expect(stream.chunks.join("")).toContain(`${"x".repeat(4001)}y`);
  });

  it("does not hold anything for a turn nobody is typing into", () => {
    const pending = { row: undefined as string | undefined };
    const { renderer: r, stream } = steerableRenderer(pending);
    r.emit(loopEvent("chat.turn.started", { turn: 1 }));

    stream.chunks.length = 0;
    r.emit(delta("Hello."));
    expect(stream.chunks.join("")).toContain("Hello.");
  });

  it("prints whatever was held when the turn ends", () => {
    const pending = { row: "> wait" as string | undefined };
    const { renderer: r, stream } = steerableRenderer(pending);
    r.emit(loopEvent("chat.turn.started", { turn: 1 }));
    r.emit(delta("Hello."));

    stream.chunks.length = 0;
    r.emit(loopEvent("chat.turn.completed", { turn: 1, status: "success" }));
    expect(stream.chunks.join("")).toContain("Hello.");
  });

  it("ignores a keystroke outside a turn", () => {
    const pending = { row: "> typing" as string | undefined };
    const { renderer: r, stream } = steerableRenderer(pending);

    r.pendingChanged();
    expect(stream.chunks).toEqual([]);
  });
});
