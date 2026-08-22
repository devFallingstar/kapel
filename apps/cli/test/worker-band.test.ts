import type { AgentEvent } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import { createBandDecor, displayWidth } from "../src/band.js";
import { TextRenderer } from "../src/render.js";
import { createStyles, PLAIN_STYLES } from "../src/styles.js";
import {
  applyWorkerEvent,
  createWorkerBand,
  formatWorkerRow,
  seedWorkerSummaries,
  type WorkerSummary,
} from "../src/worker-band.js";

/** Erase-the-line sequence the status block writes; see `status-line.ts`. */
const ERASE = "\r[2K";
/** Erase-to-bottom, what a block taller than one row is taken off with. */
const ERASE_BLOCK = "\r[0J";

class CapturingStream {
  readonly chunks: string[] = [];
  isTTY = true;
  columns: number | undefined = 80;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }

  asStream(): NodeJS.WritableStream & { isTTY?: boolean; columns?: number } {
    return this as unknown as NodeJS.WritableStream & {
      isTTY?: boolean;
      columns?: number;
    };
  }
}

let nextEventId = 0;

function event(
  type: string,
  taskId: string | undefined,
  data: unknown,
  timestamp = 0,
): AgentEvent {
  nextEventId += 1;
  return {
    id: `evt-${nextEventId}`,
    runId: "run-1",
    timestamp,
    type,
    ...(taskId === undefined ? {} : { taskId }),
    data,
  };
}

function started(
  taskId: string,
  agent: string,
  at: number,
  attempt = 1,
): AgentEvent {
  return event(
    "task.started",
    taskId,
    { agent, attempt, routing: { reason: "capability" } },
    at,
  );
}

function completed(
  taskId: string,
  status: "success" | "failure",
  final: boolean,
  attempt = 1,
): AgentEvent {
  return event("task.completed", taskId, {
    agent: "coder",
    attempt,
    final,
    result: { status, summary: "done" },
  });
}

/** Folds a whole sequence, as the sink does. */
function fold(
  taskIds: readonly string[],
  events: readonly AgentEvent[],
): readonly WorkerSummary[] {
  let summaries = seedWorkerSummaries(taskIds);
  for (const item of events) summaries = applyWorkerEvent(summaries, item);
  return [...summaries.values()];
}

function row(
  summaries: readonly WorkerSummary[],
  options: { columns?: number; now?: number } = {},
): string {
  return formatWorkerRow(summaries, {
    columns: options.columns ?? 80,
    now: options.now ?? 0,
    styles: PLAIN_STYLES,
  });
}

describe("seedWorkerSummaries", () => {
  it("seeds every planned task as pending, in plan order", () => {
    const summaries = [...seedWorkerSummaries(["T01", "T02"]).values()];
    expect(summaries).toEqual([
      { id: "T01", state: "pending" },
      { id: "T02", state: "pending" },
    ]);
  });

  it("keeps one entry per id when a plan repeats one", () => {
    expect(seedWorkerSummaries(["T01", "T01"]).size).toBe(1);
  });
});

describe("applyWorkerEvent", () => {
  it("leaves the map alone for events that say nothing about a task", () => {
    const seeded = seedWorkerSummaries(["T01"]);
    expect(applyWorkerEvent(seeded, event("model.text.delta", "T01", {}))).toBe(
      seeded,
    );
    expect(applyWorkerEvent(seeded, event("task.started", undefined, {}))).toBe(
      seeded,
    );
  });

  it("records the agent, attempt and start of a running task", () => {
    expect(fold(["T01"], [started("T01", "coder", 5_000)])).toEqual([
      {
        id: "T01",
        state: "running",
        agent: "coder",
        attempt: 1,
        startedAt: 5_000,
      },
    ]);
  });

  it("takes a held task out of the running state without losing its agent", () => {
    const summaries = fold(
      ["T01"],
      [
        started("T01", "coder", 0),
        event("task.held", "T01", {
          taskId: "T01",
          conflictsWith: "T02",
        }),
      ],
    );
    expect(summaries[0]?.state).toBe("held");
    expect(summaries[0]?.agent).toBe("coder");
  });

  it("settles a final completion as succeeded or failed", () => {
    expect(fold(["T01"], [completed("T01", "success", true)])[0]?.state).toBe(
      "succeeded",
    );
    expect(fold(["T02"], [completed("T02", "failure", true)])[0]?.state).toBe(
      "failed",
    );
  });

  it("shows a non-final completion as retrying, not as a failure", () => {
    const summaries = fold(["T01"], [completed("T01", "failure", false)]);
    expect(summaries[0]?.state).toBe("retrying");
  });

  it("moves an escalated task onto its new agent, then runs it", () => {
    const summaries = fold(
      ["T01"],
      [
        started("T01", "coder", 0),
        completed("T01", "failure", false),
        event("task.escalated", "T01", {
          from: "coder",
          to: "senior",
          rule: "esc-1",
        }),
      ],
    );
    expect(summaries[0]).toMatchObject({ state: "escalated", agent: "senior" });

    const running = fold(
      ["T01"],
      [
        started("T01", "coder", 0),
        completed("T01", "failure", false),
        event("task.escalated", "T01", { from: "coder", to: "senior" }),
        started("T01", "senior", 9_000, 2),
      ],
    );
    expect(running[0]).toMatchObject({
      state: "running",
      agent: "senior",
      attempt: 2,
      startedAt: 9_000,
    });
  });

  it("marks a cancelled task", () => {
    const summaries = fold(
      ["T01"],
      [event("task.cancelled", "T01", { reason: "dependency-failed" })],
    );
    expect(summaries[0]?.state).toBe("cancelled");
  });

  it("adds a task nobody planned rather than dropping it", () => {
    const summaries = fold(["T01"], [started("T99", "reviewer", 0)]);
    expect(summaries.map((summary) => summary.id)).toEqual(["T01", "T99"]);
  });

  it("reads a task id carried in the payload when the envelope has none", () => {
    const summaries = fold(
      ["T01"],
      [event("task.held", undefined, { taskId: "T01", conflictsWith: "T02" })],
    );
    expect(summaries[0]?.state).toBe("held");
  });
});

describe("formatWorkerRow", () => {
  it("reads as one cell per task, in plan order", () => {
    const summaries = fold(
      ["T01", "T02", "T03", "T04"],
      [
        started("T01", "coder", 0),
        completed("T01", "success", true),
        started("T02", "coder", 0),
        event("task.held", "T03", { taskId: "T03", conflictsWith: "T02" }),
      ],
    );
    expect(row(summaries, { now: 12_000 })).toBe(
      "[T01 ✔] [T02 ▶ coder 12s] [T03 ⏸ held] [T04 ·]",
    );
  });

  it("ticks the elapsed seconds of a running task with the clock alone", () => {
    const summaries = fold(["T01"], [started("T01", "coder", 1_000)]);
    expect(row(summaries, { now: 1_000 })).toBe("[T01 ▶ coder 0s]");
    expect(row(summaries, { now: 8_400 })).toBe("[T01 ▶ coder 7s]");
  });

  it("names the attempt only from the second one onwards", () => {
    const first = fold(["T01"], [started("T01", "coder", 0)]);
    expect(row(first)).toBe("[T01 ▶ coder 0s]");
    const second = fold(["T01"], [started("T01", "senior", 0, 2)]);
    expect(row(second)).toBe("[T01 ▶ senior 0s #2]");
  });

  it("shows a retry as ↻ with the attempt that failed", () => {
    const summaries = fold(["T01"], [completed("T01", "failure", false, 2)]);
    expect(row(summaries)).toBe("[T01 ↻ #2]");
  });

  it("says nothing at all for a run with no tasks", () => {
    expect(row([])).toBe("");
  });

  it("drops the least interesting tasks and tallies them with +N", () => {
    const summaries = fold(
      ["T01", "T02", "T03", "T04", "T05"],
      [
        completed("T01", "success", true),
        completed("T02", "success", true),
        started("T03", "coder", 0),
        completed("T04", "failure", true),
      ],
    );
    const narrow = row(summaries, { columns: 34, now: 3_000 });
    // The running task and the failed one survive; the two finished ones and
    // the one that has not begun are counted instead of shown.
    expect(narrow).toBe("[T03 ▶ coder 3s] [T04 ✖] +3");
    expect(displayWidth(narrow)).toBeLessThanOrEqual(33);
  });

  it("keeps the tally alone when not even one cell fits", () => {
    const summaries = fold(["T01", "T02"], [started("T01", "coder", 0)]);
    expect(row(summaries, { columns: 6 })).toBe("+2");
  });

  it("never reaches the terminal's last column, escapes and all", () => {
    const styles = createStyles(true, { COLORTERM: "truecolor" });
    const summaries = fold(
      ["T01", "T02", "T03", "T04", "T05", "T06"],
      [started("T01", "a-rather-long-agent-name", 0)],
    );
    for (const columns of [12, 20, 40, 61, 80]) {
      const painted = formatWorkerRow(summaries, {
        columns,
        now: 30_000,
        styles,
      });
      expect(displayWidth(painted)).toBeLessThanOrEqual(columns - 1);
    }
  });
});

interface BandHarness {
  readonly stream: CapturingStream;
  readonly band: ReturnType<typeof createWorkerBand>;
  readonly clock: { ms: number };
  readonly tick: () => void;
}

function harness(
  options: {
    tty?: boolean;
    columns?: number;
    frame?: boolean;
    suspended?: () => boolean;
    taskIds?: readonly string[];
  } = {},
): BandHarness {
  const stream = new CapturingStream();
  stream.isTTY = options.tty ?? true;
  stream.columns = options.columns ?? 80;
  const clock = { ms: 0 };
  let ticking: (() => void) | undefined;

  const band = createWorkerBand({
    taskIds: options.taskIds ?? ["T01", "T02"],
    output: stream.asStream(),
    styles: PLAIN_STYLES,
    now: () => clock.ms,
    ticker: (fn) => {
      ticking = fn;
      return () => {
        ticking = undefined;
      };
    },
    ...(options.frame === true ? { frame: createBandDecor(PLAIN_STYLES) } : {}),
    ...(options.suspended === undefined
      ? {}
      : { suspended: options.suspended }),
  });

  return { stream, band, clock, tick: () => ticking?.() };
}

describe("createWorkerBand", () => {
  it("paints every planned task as pending as soon as it opens", () => {
    const { stream, band } = harness();
    band.open();
    expect(stream.text).toBe(`${ERASE}[T01 ·] [T02 ·]`);
  });

  it("repaints the row on the event that changed it", () => {
    const { stream, band, clock } = harness();
    band.open();
    stream.chunks.length = 0;
    clock.ms = 4_000;
    void band.sink.emit(started("T01", "coder", 1_000));
    expect(stream.text).toBe(`${ERASE}[T01 ▶ coder 3s] [T02 ·]`);
  });

  it("ignores events that say nothing about a task", () => {
    const { stream, band } = harness();
    band.open();
    stream.chunks.length = 0;
    void band.sink.emit(event("model.text.delta", "T01", { text: "hi" }));
    expect(stream.text).toBe("");
  });

  it("keeps painting the seconds forward with no event at all", () => {
    const { stream, band, clock, tick } = harness();
    void band.sink.emit(started("T01", "coder", 0));
    band.open();
    stream.chunks.length = 0;
    clock.ms = 11_000;
    tick();
    expect(stream.text).toBe(`${ERASE}[T01 ▶ coder 11s] [T02 ·]`);
  });

  it("bounds the row with the caller's band when given one", () => {
    const { stream, band } = harness({ frame: true, columns: 20 });
    band.open();
    const rule = createBandDecor(PLAIN_STYLES).rule(20);
    expect(stream.text).toBe(
      `${ERASE_BLOCK}${[rule, "[T01 ·] [T02 ·]", rule].join("\r\n")}[2A\r`,
    );
  });

  it("erases the row for good when the run ends", () => {
    const { stream, band } = harness();
    band.open();
    stream.chunks.length = 0;
    band.stop();
    expect(stream.text).toBe(ERASE);
  });

  it("stays off the screen entirely when the output is not a terminal", () => {
    const { stream, band } = harness({ tty: false });
    band.open();
    void band.sink.emit(started("T01", "coder", 0));
    band.stop();
    expect(stream.text).toBe("");
  });

  it("keeps the row erased while something else owns the screen", () => {
    const asking = { active: false };
    const { stream, band } = harness({ suspended: () => asking.active });
    band.open();
    asking.active = true;
    stream.chunks.length = 0;
    void band.sink.emit(started("T01", "coder", 0));
    expect(stream.text).toBe(ERASE);
  });

  it("shows no row at all for a run with no tasks", () => {
    const { stream, band } = harness({ taskIds: [] });
    band.open();
    expect(stream.text).toBe("");
  });
});

describe("TextRenderer with a worker band", () => {
  it("erases the row before a task line and repaints it underneath", () => {
    const { stream, band } = harness();
    const renderer = new TextRenderer(stream.asStream(), {
      styles: PLAIN_STYLES,
      status: band.status,
    });
    band.open();
    stream.chunks.length = 0;

    const item = started("T01", "coder", 0);
    void band.sink.emit(item);
    renderer.emit(item);

    // The row moves first, then the line is printed between an erase and a
    // repaint of the same block — the discipline every printed line goes
    // through, now carrying the run's live state.
    expect(stream.text).toBe(
      [
        `${ERASE}[T01 ▶ coder 0s] [T02 ·]`,
        ERASE,
        "▶ T01 → coder (attempt 1)\n",
        `${ERASE}[T01 ▶ coder 0s] [T02 ·]`,
      ].join(""),
    );
  });

  it("leaves the row up to date as tasks finish", () => {
    const { stream, band } = harness();
    const renderer = new TextRenderer(stream.asStream(), {
      styles: PLAIN_STYLES,
      status: band.status,
    });
    band.open();

    for (const item of [
      started("T01", "coder", 0),
      started("T02", "coder", 0),
      completed("T01", "success", true),
    ]) {
      void band.sink.emit(item);
      renderer.emit(item);
    }
    band.stop();

    const painted = stream.chunks.filter((chunk) => chunk.startsWith(ERASE));
    expect(painted.at(-2)).toBe(`${ERASE}[T01 ✔] [T02 ▶ coder 0s]`);
    expect(painted.at(-1)).toBe(ERASE);
  });
});
