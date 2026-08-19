import type { AgentEvent } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  finishTuiState,
  formatEventLine,
  initialTuiState,
  MAX_LOG_LINES,
  reduceTuiEvent,
  type TuiState,
} from "../src/model.js";

let seq = 0;

function event(
  type: string,
  data?: unknown,
  extra?: { taskId?: string; timestamp?: number; runId?: string },
): AgentEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    runId: extra?.runId ?? "run-abcdef123456",
    timestamp: extra?.timestamp ?? 1_000,
    type,
    ...(extra?.taskId === undefined ? {} : { taskId: extra.taskId }),
    ...(data === undefined ? {} : { data }),
  };
}

function reduceAll(
  state: TuiState,
  ...events: readonly AgentEvent[]
): TuiState {
  return events.reduce(reduceTuiEvent, state);
}

function taskOf(state: TuiState, id: string) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`no task row for ${id}`);
  return task;
}

function successResult(summary: string) {
  return { status: "success", summary };
}

describe("initialTuiState", () => {
  it("starts empty", () => {
    const state = initialTuiState();
    expect(state).toEqual({ tasks: [], log: [], finished: false });
  });

  it("seeds objective and pending task rows from a plan", () => {
    const state = initialTuiState({
      objective: "ship the dashboard",
      taskIds: [{ id: "t1", title: "write reducer" }, { id: "t2" }],
    });
    expect(state.objective).toBe("ship the dashboard");
    expect(state.tasks).toEqual([
      { id: "t1", status: "pending", attempts: 0, summary: "write reducer" },
      { id: "t2", status: "pending", attempts: 0 },
    ]);
  });
});

describe("reduceTuiEvent — envelope", () => {
  it("adopts runId and startedAt from the first event", () => {
    const state = reduceTuiEvent(
      initialTuiState(),
      event(
        "task.started",
        { agent: "planner" },
        { taskId: "t1", timestamp: 500 },
      ),
    );
    expect(state.runId).toBe("run-abcdef123456");
    expect(state.startedAt).toBe(500);
  });

  it("keeps the first run start, ignoring later timestamps", () => {
    const state = reduceAll(
      initialTuiState(),
      event(
        "task.started",
        { agent: "planner" },
        { taskId: "t1", timestamp: 500 },
      ),
      event(
        "task.started",
        { agent: "coder" },
        { taskId: "t2", timestamp: 9_000 },
      ),
    );
    expect(state.startedAt).toBe(500);
  });

  it("leaves state referentially unchanged for unknown event types", () => {
    const seeded = reduceTuiEvent(
      initialTuiState(),
      event("task.started", { agent: "planner" }, { taskId: "t1" }),
    );
    const after = reduceTuiEvent(seeded, event("mystery.event", { a: 1 }));
    expect(after).toBe(seeded);
  });

  it("ignores task events with no identifiable task", () => {
    const seeded = reduceTuiEvent(
      initialTuiState(),
      event("task.started", { agent: "planner" }, { taskId: "t1" }),
    );
    const after = reduceTuiEvent(
      seeded,
      event("task.cancelled", { reason: "aborted" }),
    );
    expect(after.tasks).toBe(seeded.tasks);
    expect(after.log.at(-1)).toBe("⊘ ? (aborted)");
  });
});

describe("reduceTuiEvent — task rows", () => {
  it("creates a running row for an unseeded task", () => {
    const state = reduceTuiEvent(
      initialTuiState(),
      event("task.started", { agent: "planner", attempt: 1 }, { taskId: "t1" }),
    );
    expect(taskOf(state, "t1")).toEqual({
      id: "t1",
      status: "running",
      agent: "planner",
      attempts: 1,
    });
  });

  it("takes the taskId from the payload when the envelope omits it", () => {
    const state = reduceTuiEvent(
      initialTuiState(),
      event("task.started", { taskId: "t9", agent: "coder", attempt: 1 }),
    );
    expect(taskOf(state, "t9").status).toBe("running");
  });

  it("completes a task with its summary", () => {
    const state = reduceAll(
      initialTuiState({ taskIds: [{ id: "t1" }] }),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event(
        "task.completed",
        {
          agent: "coder",
          attempt: 1,
          final: true,
          result: successResult("wired it up\nmore detail"),
        },
        { taskId: "t1" },
      ),
    );
    expect(taskOf(state, "t1")).toEqual({
      id: "t1",
      status: "completed",
      agent: "coder",
      attempts: 1,
      summary: "wired it up",
    });
  });

  it("keeps a task running with a retry note when the completion is not final", () => {
    const state = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event(
        "task.completed",
        {
          agent: "coder",
          attempt: 1,
          final: false,
          result: { status: "failed", summary: "tests red" },
        },
        { taskId: "t1" },
      ),
    );
    const task = taskOf(state, "t1");
    expect(task.status).toBe("running");
    expect(task.note).toBe("retrying (attempt 1)");
    expect(task.summary).toBe("tests red");
  });

  it("fails a task on a final failed completion and keeps its note", () => {
    const state = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 2 }, { taskId: "t1" }),
      event(
        "validation.completed",
        { name: "vitest", passed: false, exitCode: 1, durationMs: 2_400 },
        { taskId: "t1" },
      ),
      event(
        "task.completed",
        {
          agent: "coder",
          attempt: 2,
          final: true,
          result: { status: "failed", summary: "still red" },
        },
        { taskId: "t1" },
      ),
    );
    expect(taskOf(state, "t1")).toEqual({
      id: "t1",
      status: "failed",
      agent: "coder",
      attempts: 2,
      summary: "still red",
      note: "✗ vitest",
    });
  });

  it("appends each failing validator and drops the note on a clean success", () => {
    const failing = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event(
        "validation.completed",
        { name: "lint", passed: false, exitCode: 2, durationMs: 100 },
        { taskId: "t1" },
      ),
      event(
        "validation.completed",
        { name: "typecheck", passed: true, durationMs: 900 },
        { taskId: "t1" },
      ),
      event(
        "validation.completed",
        { name: "vitest", passed: false, exitCode: 1, durationMs: 900 },
        { taskId: "t1" },
      ),
    );
    expect(taskOf(failing, "t1").note).toBe("✗ lint · ✗ vitest");

    const settled = reduceTuiEvent(
      failing,
      event(
        "task.completed",
        {
          agent: "coder",
          attempt: 1,
          final: true,
          result: successResult("green"),
        },
        { taskId: "t1" },
      ),
    );
    expect(taskOf(settled, "t1").note).toBeUndefined();
  });

  it("records an escalation as a routing note that survives the next start", () => {
    const state = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event(
        "task.completed",
        {
          agent: "coder",
          attempt: 1,
          final: false,
          result: { status: "failed", summary: "nope" },
        },
        { taskId: "t1" },
      ),
      event(
        "task.escalated",
        { from: "coder", to: "architect", rule: "esc-1" },
        { taskId: "t1" },
      ),
      event(
        "task.started",
        { agent: "architect", attempt: 2 },
        { taskId: "t1" },
      ),
    );
    const task = taskOf(state, "t1");
    expect(task.note).toBe("→ architect");
    expect(task.agent).toBe("architect");
    expect(task.attempts).toBe(2);
    expect(task.status).toBe("running");
  });

  it("holds a pending task until it starts", () => {
    const held = reduceTuiEvent(
      initialTuiState({ taskIds: [{ id: "t2" }] }),
      event("task.held", { taskId: "t2", conflictsWith: "t1" }),
    );
    expect(taskOf(held, "t2").status).toBe("held");
    expect(taskOf(held, "t2").note).toBe("held by t1");

    const started = reduceTuiEvent(
      held,
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t2" }),
    );
    expect(taskOf(started, "t2").status).toBe("running");
  });

  it("never walks a running task backwards into held", () => {
    const state = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event("task.held", { taskId: "t1", conflictsWith: "t0" }),
    );
    expect(taskOf(state, "t1").status).toBe("running");
  });

  it("cancels a task with its reason", () => {
    const state = reduceAll(
      initialTuiState({ taskIds: [{ id: "t1" }] }),
      event(
        "task.cancelled",
        { reason: "dependency-failed" },
        { taskId: "t1" },
      ),
    );
    expect(taskOf(state, "t1").status).toBe("cancelled");
    expect(taskOf(state, "t1").note).toBe("dependency-failed");
  });

  it("notes low confidence without changing the status", () => {
    const redoing = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event("task.low_confidence", {
        taskId: "t1",
        confidence: 0.4,
        threshold: 0.7,
      }),
    );
    expect(taskOf(redoing, "t1")).toMatchObject({
      status: "running",
      note: "low confidence 0.40",
    });

    const accepted = reduceTuiEvent(
      redoing,
      event("task.low_confidence", {
        taskId: "t1",
        confidence: 0.4,
        threshold: 0.7,
        accepted: true,
      }),
    );
    expect(taskOf(accepted, "t1").note).toBe("low confidence 0.40 (accepted)");
  });

  it("leaves task rows alone for loop and worktree events", () => {
    const seeded = reduceTuiEvent(
      initialTuiState({ taskIds: [{ id: "t1" }] }),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
    );
    const after = reduceAll(
      seeded,
      event("worktree.created", { branch: "agent/t1" }, { taskId: "t1" }),
      event("tool.execution.started", {
        tool: "read_file",
        input: { path: "a.ts" },
      }),
      event("model.turn.completed", { text: "thinking" }),
    );
    expect(after.tasks).toBe(seeded.tasks);
    expect(after.log.length).toBe(seeded.log.length + 3);
  });
});

describe("reduceTuiEvent — log", () => {
  it("appends one line per loggable event", () => {
    const state = reduceAll(
      initialTuiState(),
      event("task.started", { agent: "coder", attempt: 1 }, { taskId: "t1" }),
      event("tool.execution.completed", { ok: true }),
    );
    expect(state.log).toEqual(["▶ t1 → coder (attempt 1)", "  ✓"]);
  });

  it("caps the log at the last 100 lines", () => {
    let state = initialTuiState();
    for (let i = 0; i < MAX_LOG_LINES + 25; i += 1) {
      state = reduceTuiEvent(
        state,
        event("task.cancelled", { reason: `r${i}` }, { taskId: `t${i}` }),
      );
    }
    expect(state.log).toHaveLength(MAX_LOG_LINES);
    expect(state.log[0]).toBe("⊘ t25 (r25)");
    expect(state.log.at(-1)).toBe("⊘ t124 (r124)");
  });
});

describe("finishTuiState", () => {
  it("marks the run finished with an outcome", () => {
    const state = finishTuiState(initialTuiState(), "success: 3/3 tasks");
    expect(state.finished).toBe(true);
    expect(state.outcome).toBe("success: 3/3 tasks");
  });

  it("is idempotent for the same outcome", () => {
    const once = finishTuiState(initialTuiState(), "done");
    expect(finishTuiState(once, "done")).toBe(once);
  });
});

describe("formatEventLine", () => {
  const lines: readonly [string, AgentEvent, string | undefined][] = [
    [
      "task.started",
      event("task.started", { agent: "coder", attempt: 2 }, { taskId: "t1" }),
      "▶ t1 → coder (attempt 2)",
    ],
    [
      "task.completed success",
      event(
        "task.completed",
        { final: true, result: successResult("did the thing") },
        { taskId: "t1" },
      ),
      "✔ t1 — did the thing",
    ],
    [
      "task.completed retrying",
      event(
        "task.completed",
        { final: false, result: { status: "failed", summary: "boom" } },
        { taskId: "t1" },
      ),
      "✖ t1 — boom (retrying)",
    ],
    [
      "task.completed without a summary",
      event(
        "task.completed",
        { final: true, result: { status: "failed" } },
        { taskId: "t1" },
      ),
      "✖ t1 — (no summary)",
    ],
    [
      "task.escalated",
      event(
        "task.escalated",
        { from: "coder", to: "architect" },
        { taskId: "t1" },
      ),
      "↑ t1 rerouted coder → architect",
    ],
    [
      "task.escalated unassigned",
      event("task.escalated", { to: "architect" }, { taskId: "t1" }),
      "↑ t1 rerouted (unassigned) → architect",
    ],
    [
      "task.cancelled",
      event("task.cancelled", { reason: "aborted" }, { taskId: "t1" }),
      "⊘ t1 (aborted)",
    ],
    [
      "task.held",
      event("task.held", { taskId: "t2", conflictsWith: "t1" }),
      "⏸ t2 held (conflicts with t1)",
    ],
    [
      "task.low_confidence",
      event("task.low_confidence", {
        taskId: "t1",
        confidence: 0.42,
        threshold: 0.7,
      }),
      "↻ t1 low confidence 0.42 < 0.70 — redoing",
    ],
    [
      "task.low_confidence accepted",
      event("task.low_confidence", {
        taskId: "t1",
        confidence: 0.42,
        threshold: 0.7,
        accepted: true,
      }),
      "↻ t1 low confidence 0.42 < 0.70 — accepted (attempts exhausted)",
    ],
    [
      "worktree.created",
      event("worktree.created", { branch: "agent/t1" }, { taskId: "t1" }),
      "⎇ t1 worktree created (agent/t1)",
    ],
    [
      "worktree.integrated merged",
      event(
        "worktree.integrated",
        { merged: true, commit: "0123456789ab" },
        { taskId: "t1" },
      ),
      "⇡ t1 merged → 01234567",
    ],
    [
      "worktree.integrated conflict",
      event(
        "worktree.integrated",
        { merged: false, conflictFiles: ["a.ts", "b.ts"] },
        { taskId: "t1" },
      ),
      "⚠ t1 merge conflict: a.ts, b.ts",
    ],
    [
      "worktree.integrated refused",
      event(
        "worktree.integrated",
        { merged: false, reason: "dirty tree" },
        { taskId: "t1" },
      ),
      "⚠ t1 not merged (dirty tree)",
    ],
    [
      "worktree.removed kept",
      event(
        "worktree.removed",
        { keptBranch: true, branch: "agent/t1" },
        { taskId: "t1" },
      ),
      "⎇ t1 branch kept: agent/t1",
    ],
    [
      "worktree.removed clean",
      event("worktree.removed", { keptBranch: false }, { taskId: "t1" }),
      undefined,
    ],
    [
      "validation.started",
      event("validation.started", { name: "vitest" }, { taskId: "t1" }),
      "⚙ t1 validator vitest…",
    ],
    [
      "validation.completed pass",
      event(
        "validation.completed",
        { name: "vitest", passed: true, durationMs: 2_450 },
        { taskId: "t1" },
      ),
      "  ✓ vitest (2.5s)",
    ],
    [
      "validation.completed fail",
      event(
        "validation.completed",
        { name: "vitest", passed: false, exitCode: 1, durationMs: 900 },
        { taskId: "t1" },
      ),
      "  ✗ vitest (exit 1, 0.9s)",
    ],
    [
      "tool.execution.started",
      event("tool.execution.started", {
        tool: "read_file",
        input: { path: "a.ts" },
      }),
      '→ read_file {"path":"a.ts"}',
    ],
    [
      "tool.execution.completed ok",
      event("tool.execution.completed", { ok: true }),
      "  ✓",
    ],
    [
      "tool.execution.completed denied",
      event("tool.execution.completed", { ok: false, denied: true }),
      "  ✗ (denied)",
    ],
    [
      "tool.execution.completed error",
      event("tool.execution.completed", { ok: false }),
      "  ✗ (error)",
    ],
    [
      "model.turn.completed",
      event("model.turn.completed", { text: "hello\n  world" }),
      "hello world",
    ],
    [
      "model.turn.completed empty",
      event("model.turn.completed", { text: "" }),
      undefined,
    ],
    [
      "codex agent_message",
      event("codex.item.completed", {
        item: { type: "agent_message", text: "codex says hi" },
      }),
      "codex says hi",
    ],
    [
      "codex command via msg envelope",
      event("codex.item.started", {
        msg: { item: { type: "command_execution", argv: ["npm", "test"] } },
      }),
      "→ codex: npm test",
    ],
    [
      "codex file_change",
      event("codex.item.completed", {
        item: {
          type: "file_change",
          changes: [{ path: "src/a.ts" }, "src/b.ts"],
        },
      }),
      "✎ src/a.ts, src/b.ts",
    ],
    [
      "codex turn rollup",
      event("codex.turn.completed", { usage: { inputTokens: 1 } }),
      undefined,
    ],
    ["unknown type", event("something.else", { a: 1 }), undefined],
    ["no data at all", event("task.started"), "▶ ? → ? (attempt 1)"],
  ];

  for (const [name, input, expected] of lines) {
    it(`renders ${name}`, () => {
      expect(formatEventLine(input)).toBe(expected);
    });
  }

  it("truncates a long model turn", () => {
    const line = formatEventLine(
      event("model.turn.completed", { text: "x".repeat(400) }),
    );
    expect(line).toHaveLength(160);
    expect(line?.endsWith("…")).toBe(true);
  });
});
