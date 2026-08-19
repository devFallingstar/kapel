import { describe, expect, it } from "vitest";
import {
  formatStatus,
  formatTokenCount,
  StatusLine,
} from "../src/status-line.js";

/** Erase-the-line sequence the status line writes; see `status-line.ts`. */
const ERASE = "\r[2K";

class CapturingStream {
  readonly chunks: string[] = [];
  isTTY = false;
  columns: number | undefined;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }

  asStream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
}

interface Harness {
  readonly status: StatusLine;
  readonly stream: CapturingStream;
  readonly clock: { ms: number };
  /** Advances the injected ticker by one frame. */
  readonly tick: () => void;
}

function harness(
  options: {
    tty?: boolean;
    tokens?: () => number | undefined;
    suspended?: () => boolean;
    columns?: number;
  } = {},
): Harness {
  const stream = new CapturingStream();
  stream.isTTY = options.tty ?? true;
  stream.columns = options.columns;
  const clock = { ms: 0 };
  let ticking: (() => void) | undefined;

  const status = new StatusLine({
    output: stream as unknown as NodeJS.WritableStream & { isTTY?: boolean },
    now: () => clock.ms,
    ticker: (fn) => {
      ticking = fn;
      return () => {
        ticking = undefined;
      };
    },
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    ...(options.suspended === undefined
      ? {}
      : { suspended: options.suspended }),
  });

  return {
    status,
    stream,
    clock,
    tick: () => ticking?.(),
  };
}

describe("formatTokenCount", () => {
  it("keeps small counts exact and abbreviates thousands", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(12345)).toBe("12.3k");
  });
});

describe("formatStatus", () => {
  it("reads as label, elapsed seconds and (when known) tokens", () => {
    expect(formatStatus("thinking", 0)).toBe("thinking 0s");
    expect(formatStatus("thinking", 4999)).toBe("thinking 4s");
    expect(formatStatus("bash", 1000, 2500)).toBe("bash 1s · 2.5k tokens");
  });

  it("drops the token clause rather than claiming zero", () => {
    expect(formatStatus("thinking", 0, 0)).toBe("thinking 0s");
    expect(formatStatus("thinking", 0, undefined)).toBe("thinking 0s");
  });
});

describe("StatusLine", () => {
  it("writes nothing at all when the stream is not a TTY", () => {
    const { status, stream, tick } = harness({ tty: false });
    expect(status.enabled).toBe(false);
    status.start("thinking");
    tick();
    status.refresh();
    status.erase();
    status.stop();
    expect(stream.chunks).toEqual([]);
  });

  it("paints spinner, label and elapsed time on a TTY", () => {
    const { status, stream, clock } = harness();
    status.start("thinking");
    clock.ms = 2400;
    status.refresh();

    expect(stream.chunks[0]).toContain("thinking 0s");
    expect(stream.chunks.at(-1)).toContain("thinking 2s");
    expect(stream.chunks.at(-1)?.startsWith(ERASE)).toBe(true);
  });

  it("advances the spinner glyph on each tick", () => {
    const { status, stream, tick } = harness();
    status.start("thinking");
    const first = stream.chunks.at(-1) ?? "";
    tick();
    const second = stream.chunks.at(-1) ?? "";
    expect(second).not.toBe(first);
  });

  it("keeps one elapsed clock across a relabel", () => {
    const { status, stream, clock } = harness();
    status.start("thinking");
    clock.ms = 5000;
    status.start("bash");
    expect(stream.chunks.at(-1)).toContain("bash 5s");
  });

  it("restarts the clock after a stop", () => {
    const { status, stream, clock } = harness();
    status.start("thinking");
    clock.ms = 5000;
    status.stop();
    status.start("bash");
    expect(stream.chunks.at(-1)).toContain("bash 0s");
  });

  it("erases once, and does not write an erase for a line it never painted", () => {
    const { status, stream } = harness();
    status.erase();
    expect(stream.chunks).toEqual([]);

    status.start("thinking");
    status.erase();
    status.erase();
    expect(stream.chunks.filter((chunk) => chunk === ERASE)).toHaveLength(1);
  });

  it("repaints on refresh after an erase", () => {
    const { status, stream } = harness();
    status.start("thinking");
    status.erase();
    status.refresh();
    expect(stream.chunks.at(-1)).toContain("thinking");
  });

  it("stops painting, and leaves the line erased, after stop", () => {
    const { status, stream, tick } = harness();
    status.start("thinking");
    status.stop();
    expect(status.running).toBe(false);
    expect(stream.chunks.at(-1)).toBe(ERASE);

    const painted = stream.chunks.length;
    tick();
    status.refresh();
    expect(stream.chunks).toHaveLength(painted);
  });

  it("stays erased while something else owns the screen", () => {
    let asking = false;
    const { status, stream, tick } = harness({ suspended: () => asking });
    status.start("thinking");
    asking = true;
    tick();
    expect(stream.chunks.at(-1)).toBe(ERASE);

    const painted = stream.chunks.length;
    tick();
    expect(stream.chunks).toHaveLength(painted);

    asking = false;
    tick();
    expect(stream.chunks.at(-1)).toContain("thinking");
  });

  it("never fills the terminal's last column, so `\\r` can still erase it", () => {
    const { status, stream } = harness({
      columns: 20,
      tokens: () => 987654,
    });
    status.start("a-very-long-label-indeed");
    const painted = stream.chunks.at(-1) ?? "";
    const visible = painted.replaceAll("[2m", "").replaceAll("[0m", "");
    expect(visible.replace(ERASE, "").length).toBeLessThanOrEqual(19);
  });
});
