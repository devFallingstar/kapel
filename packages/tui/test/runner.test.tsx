import { EventEmitter } from "node:events";
import type { AgentEvent } from "@agent/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOrchestrationTui } from "../src/runner.js";

const RUN_START = 1_700_000_000_000;

/**
 * The smallest thing ink will render into: it needs `columns`, a `write`, and
 * the resize listener hooks an `EventEmitter` already provides.
 */
class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly chunks: string[] = [];

  write = (chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  };

  /** Everything written so far, with ANSI control sequences stripped. */
  get output(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
    return this.chunks.join("").replace(/\[[0-9;?]*[A-Za-z]/g, "");
  }
}

function asStdout(stdout: FakeStdout): NodeJS.WriteStream {
  return stdout as unknown as NodeJS.WriteStream;
}

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

/** Lets our 50ms window and then ink's own 30fps render throttle elapse. */
function settle(ms = 250): void {
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  // `setImmediate` stays real: ink resolves its exit promise through it, so
  // faking it would make `unmount()` un-awaitable.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startOrchestrationTui", () => {
  it("paints the seeded plan on mount", async () => {
    const stdout = new FakeStdout();
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => RUN_START,
      objective: "add the ink dashboard",
      taskIds: [{ id: "t1" }, { id: "t2" }],
    });

    expect(stdout.output).toContain("add the ink dashboard");
    expect(stdout.output).toContain("▷ t1");
    expect(stdout.output).toContain("0/2 done");

    await tui.unmount();
  });

  it("renders task progress emitted through the sink", async () => {
    const stdout = new FakeStdout();
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => RUN_START,
      taskIds: [{ id: "t1" }],
    });
    stdout.chunks.length = 0;

    tui.sink.emit(event("task.started", { agent: "coder", attempt: 1 }, "t1"));
    settle();

    expect(stdout.output).toContain("▶ t1");
    expect(stdout.output).toContain("coder");
    expect(tui.state.tasks[0]?.status).toBe("running");

    await tui.unmount();
  });

  it("coalesces a burst of events into a single frame", async () => {
    const stdout = new FakeStdout();
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => RUN_START,
    });

    // The mount frame is already out; only repaints are under test here.
    stdout.chunks.length = 0;

    for (let i = 0; i < 20; i += 1) {
      tui.sink.emit(
        event("task.started", { agent: "coder", attempt: 1 }, `t${i}`),
      );
    }
    // Inside the 50ms window nothing has been repainted yet…
    expect(stdout.chunks.length).toBe(0);
    settle();
    // …and afterwards a single trailing frame carries all 20 rows.
    expect(stdout.output).toContain("▶ t0");
    expect(stdout.output).toContain("▶ t19");
    expect(tui.state.tasks).toHaveLength(20);

    await tui.unmount();
  });

  it("advances the elapsed clock on the one-second tick with no events", async () => {
    const stdout = new FakeStdout();
    let now = RUN_START;
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => now,
    });
    tui.sink.emit(event("task.started", { agent: "coder", attempt: 1 }, "t1"));
    settle();
    stdout.chunks.length = 0;

    now = RUN_START + 65_000;
    settle(1_100);

    expect(stdout.output).toContain("01:05");

    await tui.unmount();
  });

  it("paints the outcome immediately on finish()", async () => {
    const stdout = new FakeStdout();
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => RUN_START,
      taskIds: [{ id: "t1" }],
    });
    tui.sink.emit(
      event(
        "task.completed",
        {
          final: true,
          attempt: 1,
          result: { status: "success", summary: "done" },
        },
        "t1",
      ),
    );
    stdout.chunks.length = 0;

    // finish() repaints outside our 50ms window and cancels the repaint the
    // emit above had scheduled, so the outcome shows up before that window is
    // over (only ink's own ~34ms frame throttle is waited out here).
    tui.finish("success: 1/1 tasks completed");
    vi.advanceTimersByTime(40);

    expect(stdout.output).toContain("■ finished");
    expect(stdout.output).toContain("success: 1/1 tasks completed");
    expect(tui.state.finished).toBe(true);

    await tui.unmount();
  });

  it("flushes a final frame and clears every timer on unmount", async () => {
    const stdout = new FakeStdout();
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => RUN_START,
    });
    tui.sink.emit(event("task.started", { agent: "coder", attempt: 1 }, "t1"));
    // A repaint is still pending when the teardown starts.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await expect(tui.unmount()).resolves.toBeUndefined();
    expect(stdout.output).toContain("▶ t1");

    // Neither the pending repaint nor the 1s elapsed tick survives teardown:
    // ten seconds of timers later, nothing else has been written.
    const written = stdout.chunks.length;
    vi.advanceTimersByTime(10_000);
    expect(stdout.chunks.length).toBe(written);
  });

  it("is safe to unmount twice", async () => {
    const tui = startOrchestrationTui({
      stdout: asStdout(new FakeStdout()),
      clock: () => RUN_START,
    });
    await tui.unmount();
    await expect(tui.unmount()).resolves.toBeUndefined();
  });

  it("ignores events emitted after unmount instead of throwing", async () => {
    const stdout = new FakeStdout();
    const tui = startOrchestrationTui({
      stdout: asStdout(stdout),
      clock: () => RUN_START,
    });
    await tui.unmount();

    const before = stdout.chunks.length;
    expect(() => {
      tui.sink.emit(
        event("task.started", { agent: "coder", attempt: 1 }, "t1"),
      );
    }).not.toThrow();
    settle();
    expect(stdout.chunks.length).toBe(before);
  });

  it("never throws out of the sink, whatever the event carries", async () => {
    const tui = startOrchestrationTui({
      stdout: asStdout(new FakeStdout()),
      clock: () => RUN_START,
    });
    const hostile = {
      id: "x",
      runId: "r",
      timestamp: 0,
      type: "tool.execution.started",
      data: {
        tool: "loop",
        get input(): unknown {
          throw new Error("payload exploded");
        },
      },
    } as unknown as AgentEvent;

    expect(() => {
      tui.sink.emit(hostile);
    }).not.toThrow();
    settle();

    await tui.unmount();
  });
});
