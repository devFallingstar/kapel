import { describe, expect, it } from "vitest";
import { createBandDecor } from "../src/band.js";
import {
  clipToEnd,
  formatStatus,
  formatTokenCount,
  StatusLine,
} from "../src/status-line.js";
import { PLAIN_STYLES } from "../src/styles.js";

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
    band?: boolean;
    rows?: (columns: number) => readonly string[];
    pending?: () => string | undefined;
    queued?: () => number;
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
    ...(options.band === undefined ? {} : { styles: PLAIN_STYLES }),
    ...(options.band === true ? { frame: createBandDecor(PLAIN_STYLES) } : {}),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    ...(options.pending === undefined ? {} : { pending: options.pending }),
    ...(options.queued === undefined ? {} : { queued: options.queued }),
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

  it("counts the lines waiting for the turn to end, last", () => {
    expect(formatStatus("thinking", 1000, 2500, 2)).toBe(
      "thinking 1s · 2.5k tokens · 2 queued",
    );
    expect(formatStatus("thinking", 0, undefined, 1)).toBe(
      "thinking 0s · 1 queued",
    );
  });

  it("drops the queue clause when nothing is waiting", () => {
    expect(formatStatus("thinking", 0, undefined, 0)).toBe("thinking 0s");
    expect(formatStatus("thinking", 0, undefined, undefined)).toBe(
      "thinking 0s",
    );
  });
});

describe("clipToEnd", () => {
  it("leaves a row that fits alone", () => {
    expect(clipToEnd("> hello", 20)).toBe("> hello");
  });

  it("keeps the end of a row that has outgrown the terminal", () => {
    expect(clipToEnd("> abcdefgh", 5)).toBe("…efgh");
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

describe("StatusLine as the turn's band", () => {
  const ERASE_BLOCK = "\r\u001b[0J";

  it("paints the spinner between the same two rules the prompt sits between", () => {
    const { status, stream } = harness({ band: true, columns: 20 });
    status.start("thinking");
    const rule = PLAIN_STYLES.rule(20);
    // Three rows in one write, and the cursor walked back up to the first of
    // them: the next erase starts where this paint did.
    expect(stream.text).toBe(
      `${ERASE_BLOCK}${rule}\r\n⠋ thinking 0s\r\n${rule}\u001b[2A\r`,
    );
  });

  it("takes all three rows off with one clear-to-bottom", () => {
    const { status, stream } = harness({ band: true, columns: 20 });
    status.start("thinking");
    stream.chunks.length = 0;
    status.erase();
    // `ESC[0J`, not `ESC[2K`: a block taller than one row needs the rows
    // under the cursor gone too, and this leaves the cursor where the
    // caller's next line of output belongs.
    expect(stream.text).toBe(ERASE_BLOCK);
  });

  it("erases, lets output through, and repaints under it", () => {
    const { status, stream } = harness({ band: true, columns: 20 });
    status.start("thinking");
    stream.chunks.length = 0;
    status.erase();
    stream.write("a line of output\n");
    status.refresh();
    const text = stream.text;
    expect(text.indexOf("a line of output")).toBeGreaterThan(
      text.indexOf(ERASE_BLOCK),
    );
    expect(text.lastIndexOf(PLAIN_STYLES.rule(20))).toBeGreaterThan(
      text.indexOf("a line of output"),
    );
  });

  it("is the one-row line it always was without a frame", () => {
    const { status, stream } = harness({ columns: 20, band: false });
    status.start("thinking");
    expect(stream.text).toBe("\r\u001b[2K⠋ thinking 0s");
    stream.chunks.length = 0;
    status.erase();
    expect(stream.text).toBe("\r\u001b[2K");
  });

  it("still writes nothing at all off a terminal", () => {
    const { status, stream } = harness({ band: true, tty: false });
    status.start("thinking");
    status.refresh();
    status.stop();
    expect(stream.chunks).toEqual([]);
  });
});

describe("StatusLine with rows the caller owns", () => {
  const ERASE_BLOCK = "\r[0J";

  it("paints the caller's rows in place of the spinner", () => {
    const { status, stream } = harness({ rows: () => ["[T01 x] [T02 .]"] });
    status.open();
    expect(stream.text).toBe(`${ERASE}[T01 x] [T02 .]`);
  });

  it("hands the rows the width they have to fit into", () => {
    const widths: number[] = [];
    const { status } = harness({
      columns: 42,
      rows: (columns) => {
        widths.push(columns);
        return ["row"];
      },
    });
    status.open();
    expect(widths).toEqual([42]);
  });

  it("re-asks for the rows on every tick, so they can move on their own", () => {
    const frames = { count: 0 };
    const { status, stream, tick } = harness({
      rows: () => [`frame ${frames.count++}`],
    });
    status.open();
    tick();
    expect(stream.chunks.at(-1)).toBe(`${ERASE}frame 1`);
  });

  it("bounds them with the band when there is one, and erases all of it", () => {
    const { status, stream } = harness({
      band: true,
      columns: 20,
      rows: () => ["[T01 x]"],
    });
    status.open();
    const rule = PLAIN_STYLES.rule(20);
    expect(stream.text).toBe(
      `${ERASE_BLOCK}${rule}\r\n[T01 x]\r\n${rule}[2A\r`,
    );
    stream.chunks.length = 0;
    status.erase();
    expect(stream.text).toBe(ERASE_BLOCK);
  });

  it("leaves a clean screen while the rows have nothing to say", () => {
    const rows: string[] = [];
    const { status, stream, tick } = harness({ rows: () => rows });
    status.open();
    expect(stream.chunks).toEqual([]);

    rows.push("[T01 x]");
    tick();
    expect(stream.text).toBe(`${ERASE}[T01 x]`);

    rows.length = 0;
    tick();
    expect(stream.chunks.at(-1)).toBe(ERASE);
  });

  it("writes nothing at all off a terminal", () => {
    const { status, stream, tick } = harness({
      tty: false,
      rows: () => ["[T01 x]"],
    });
    status.open();
    tick();
    status.stop();
    expect(stream.chunks).toEqual([]);
  });
});

describe("StatusLine — typing into the running turn", () => {
  it("paints the line being typed as a fourth row inside the band", () => {
    const { status, stream } = harness({
      columns: 40,
      band: true,
      pending: () => "> and the docs▏",
    });

    status.start("thinking");

    expect(stream.text).toContain("> and the docs▏");
    // Between the spinner and the lower rule, so the band still reads as one
    // block with the input at the bottom of it.
    const text = stream.text;
    expect(text.indexOf("> and the docs▏")).toBeGreaterThan(
      text.indexOf("⠋ thinking"),
    );
  });

  it("leaves the three-row band alone when nobody is typing", () => {
    const { status, stream } = harness({
      columns: 40,
      band: true,
      pending: () => undefined,
    });

    status.start("thinking");

    expect(stream.text.split("\r\n")).toHaveLength(3);
  });

  it("counts the queue on the status row", () => {
    const { status, stream } = harness({
      columns: 40,
      band: true,
      queued: () => 3,
    });

    status.start("thinking");

    expect(stream.text).toContain("⠋ thinking 0s · 3 queued");
  });

  it("clips a typed line that has outgrown the terminal, keeping its end", () => {
    const { status, stream } = harness({
      columns: 12,
      band: true,
      pending: () => "> a very long sentence indeed▏",
    });

    status.start("thinking");

    expect(stream.text).toContain("…ce indeed▏");
  });

  it("shows no typed row without a frame to put it in", () => {
    const { status, stream } = harness({
      columns: 40,
      band: false,
      pending: () => "> not here",
    });

    status.start("thinking");

    expect(stream.text).not.toContain("not here");
  });

  it("rides under the rows a caller owns, and comes off with them", () => {
    const ERASE_BLOCK = "\r[0J";
    const { status, stream } = harness({
      columns: 20,
      band: true,
      rows: () => ["[T01 x]"],
      pending: () => "> and this",
    });

    status.open();

    // Four rows now, and the walk back up counts them: the typed row sits
    // under whatever the block is reporting, whether that is the spinner or a
    // caller's own rows.
    const rule = PLAIN_STYLES.rule(20);
    expect(stream.text).toBe(
      `${ERASE_BLOCK}${rule}\r\n[T01 x]\r\n> and this\r\n${rule}[3A\r`,
    );
    stream.chunks.length = 0;
    status.erase();
    expect(stream.text).toBe(ERASE_BLOCK);
  });
});
