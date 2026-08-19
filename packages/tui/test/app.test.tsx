import type { AgentEvent } from "@agent/protocol";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationApp } from "../src/app.js";
import {
  finishTuiState,
  initialTuiState,
  reduceTuiEvent,
  type TuiState,
} from "../src/model.js";

const RUN_START = 1_700_000_000_000;

let seq = 0;

function event(type: string, data?: unknown, taskId?: string): AgentEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    runId: "run-abcdef123456",
    timestamp: RUN_START,
    type,
    ...(taskId === undefined ? {} : { taskId }),
    ...(data === undefined ? {} : { data }),
  };
}

/** A run with one task done, one retried + escalated and running, one held. */
function midRunState(): TuiState {
  const events: readonly AgentEvent[] = [
    event("task.started", { agent: "coder", attempt: 1 }, "t1"),
    event("worktree.created", { branch: "agent/t1" }, "t1"),
    event(
      "validation.completed",
      { name: "vitest", passed: true, durationMs: 2_400 },
      "t1",
    ),
    event(
      "task.completed",
      {
        final: true,
        attempt: 1,
        result: { status: "success", summary: "pure reducer landed" },
      },
      "t1",
    ),
    event("task.started", { agent: "coder", attempt: 1 }, "t2"),
    event(
      "task.completed",
      {
        final: false,
        attempt: 1,
        result: { status: "failed", summary: "snapshot mismatch" },
      },
      "t2",
    ),
    event("task.escalated", { from: "coder", to: "architect" }, "t2"),
    event("task.started", { agent: "architect", attempt: 2 }, "t2"),
    event("task.held", { taskId: "t3", conflictsWith: "t2" }),
  ];
  return events.reduce(
    reduceTuiEvent,
    initialTuiState({
      objective: "add the ink dashboard",
      taskIds: [
        { id: "t1", title: "reducer" },
        { id: "t2", title: "component" },
        { id: "t3", title: "runner" },
      ],
    }),
  );
}

const rendered: { unmount: () => void }[] = [];

function frameOf(state: TuiState, now: number): string {
  const instance = render(<OrchestrationApp state={state} now={now} />);
  rendered.push(instance);
  return instance.lastFrame() ?? "";
}

afterEach(() => {
  for (const instance of rendered.splice(0)) instance.unmount();
});

describe("OrchestrationApp — mid run", () => {
  it("shows the objective, run id and elapsed clock", () => {
    const frame = frameOf(midRunState(), RUN_START + 83_000);
    expect(frame).toContain("▪ add the ink dashboard");
    expect(frame).toContain("run run-abcd");
    expect(frame).toContain("01:23");
  });

  it("renders one row per task with the right status glyph", () => {
    const frame = frameOf(midRunState(), RUN_START + 1_000);
    expect(frame).toContain("✔ t1");
    expect(frame).toContain("▶ t2");
    expect(frame).toContain("⏸ t3");
  });

  it("shows agents, retry counts and per-row notes", () => {
    const frame = frameOf(midRunState(), RUN_START + 1_000);
    expect(frame).toContain("coder");
    expect(frame).toContain("architect");
    // Only a task past its first attempt is annotated with an attempt count.
    expect(frame).toContain("×2");
    expect(frame).not.toContain("×1");
    expect(frame).toContain("pure reducer landed");
    expect(frame).toContain("held by t2");
  });

  it("shows the tail of the log", () => {
    const frame = frameOf(midRunState(), RUN_START + 1_000);
    expect(frame).toContain("↑ t2 rerouted coder → architect");
    expect(frame).toContain("▶ t2 → architect (attempt 2)");
    // The log window is 8 lines, so the oldest lines have scrolled off.
    expect(frame).not.toContain("▶ t1 → coder (attempt 1)");
  });

  it("counts completed tasks in the footer while running", () => {
    const frame = frameOf(midRunState(), RUN_START + 1_000);
    expect(frame).toContain("1/3 done");
    expect(frame).toContain("⟳ running");
    expect(frame).not.toContain("■ finished");
  });

  it("truncates long detail to the frame width", () => {
    const state = reduceTuiEvent(
      midRunState(),
      event(
        "task.completed",
        {
          final: true,
          attempt: 2,
          result: { status: "success", summary: "x".repeat(400) },
        },
        "t2",
      ),
    );
    const frame = frameOf(state, RUN_START + 1_000);
    for (const line of frame.split("\n"))
      expect(line.length).toBeLessThanOrEqual(80);
    expect(frame).toContain("…");
  });

  it("renders an empty run without tasks or log", () => {
    const frame = frameOf(initialTuiState({ objective: "nothing yet" }), 0);
    expect(frame).toContain("no tasks yet");
    expect(frame).toContain("0/0 done");
  });

  it("falls back to a generic header with no objective", () => {
    const frame = frameOf(initialTuiState(), 0);
    expect(frame).toContain("orchestration run");
    expect(frame).toContain("00:00");
  });
});

describe("OrchestrationApp — finished", () => {
  const finishedState = (): TuiState =>
    finishTuiState(
      reduceTuiEvent(
        midRunState(),
        event("task.cancelled", { reason: "aborted" }, "t3"),
      ),
      "partial: 1/3 tasks completed",
    );

  it("prints the outcome line and final counts", () => {
    const frame = frameOf(finishedState(), RUN_START + 125_000);
    expect(frame).toContain("■ finished");
    expect(frame).toContain("1/3 done, 1 failed");
    expect(frame).toContain("partial: 1/3 tasks completed");
    expect(frame).not.toContain("⟳ running");
  });

  it("keeps the elapsed clock frozen at the time it is given", () => {
    const state = finishedState();
    expect(frameOf(state, RUN_START + 125_000)).toContain("02:05");
    expect(frameOf(state, RUN_START + 3_725_000)).toContain("1:02:05");
  });

  it("shows cancelled rows with their reason", () => {
    const frame = frameOf(finishedState(), RUN_START + 125_000);
    expect(frame).toContain("⊘ t3");
    expect(frame).toContain("aborted");
  });
});
