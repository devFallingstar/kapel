import { describe, expect, it } from "vitest";
import {
  bandDecorFor,
  charWidth,
  createBandDecor,
  displayWidth,
  ECHO_MARKER,
  echoRows,
  foldToWidth,
  stripEscapes,
} from "../src/band.js";
import { createStyles, ECHO_256, PLAIN_STYLES } from "../src/styles.js";

const ESC = "";
const RESET = `${ESC}[0m`;
const TRUECOLOR = { COLORTERM: "truecolor" } as const;

describe("stripEscapes", () => {
  it("removes the SGR sequences a styled string carries", () => {
    expect(stripEscapes(`${ESC}[1;36mhi${RESET}`)).toBe("hi");
  });

  it("removes an OSC hyperlink, terminated either way", () => {
    expect(stripEscapes(`${ESC}]8;;https://x${ESC}\\link`)).toBe("link");
    expect(stripEscapes(`${ESC}]0;titlerest`)).toBe("rest");
  });

  it("leaves text that merely looks like an escape alone", () => {
    expect(stripEscapes("[1m is not an escape")).toBe("[1m is not an escape");
  });
});

describe("charWidth", () => {
  it("is 2 for the ranges terminals draw double-wide", () => {
    expect(charWidth("日".codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth("🙂".codePointAt(0) ?? 0)).toBe(2);
  });

  it("is 0 for combining marks, joiners and control characters", () => {
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0xfe0f)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
  });

  it("is 1 for everything ordinary", () => {
    expect(charWidth("a".codePointAt(0) ?? 0)).toBe(1);
    expect(charWidth("é".codePointAt(0) ?? 0)).toBe(1);
  });
});

describe("displayWidth", () => {
  it("counts cells, not characters, and ignores escapes", () => {
    expect(displayWidth(`${ESC}[1mabc${RESET}`)).toBe(3);
    expect(displayWidth("日本語")).toBe(6);
    // An astral codepoint is one character, not two halves of a surrogate.
    expect(displayWidth("🙂")).toBe(2);
  });
});

describe("foldToWidth", () => {
  it("breaks at a space when one is near enough to the edge", () => {
    expect(foldToWidth("hello world this is a long line", 12)).toEqual([
      "hello world",
      "this is a",
      "long line",
    ]);
  });

  it("breaks mid-word rather than leave a gap the eye reads as a break", () => {
    expect(foldToWidth("a supercalifragilistic word", 10)).toEqual([
      "a supercal",
      "ifragilist",
      "ic word",
    ]);
  });

  it("never puts a double-width character half off the edge", () => {
    const rows = foldToWidth("日本語日本語", 5);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(5);
    expect(rows.join("")).toBe("日本語日本語");
  });

  it("folds an empty string to one empty row, not to none", () => {
    // A blank line inside a pasted message is part of the message.
    expect(foldToWidth("", 10)).toEqual([""]);
  });
});

describe("echoRows", () => {
  it("is the plain `> message` form with colour off", () => {
    expect(echoRows("hello", 40, PLAIN_STYLES)).toEqual(["> hello"]);
  });

  it("marks only the first row of a multi-line message", () => {
    expect(echoRows("first\nsecond", 40, PLAIN_STYLES)).toEqual([
      "> first",
      "  second",
    ]);
  });

  it("pads each bar to one cell short of the width, so none can wrap", () => {
    const styled = createStyles(true, TRUECOLOR);
    const rows = echoRows("hi", 20, styled);
    expect(rows).toEqual([`${ESC}[${ECHO_256}m> hi${" ".repeat(15)}${RESET}`]);
    expect(displayWidth(rows[0] ?? "")).toBe(19);
  });

  it("gives a long message one bar per folded row, all the same width", () => {
    const styled = createStyles(true, TRUECOLOR);
    const rows = echoRows("word ".repeat(20).trim(), 30, styled);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBe(29);
    expect(stripEscapes(rows[0] ?? "").startsWith(ECHO_MARKER)).toBe(true);
    expect(stripEscapes(rows[1] ?? "").startsWith("  ")).toBe(true);
  });

  it("pads a message of wide characters to the same width as any other", () => {
    const styled = createStyles(true, TRUECOLOR);
    for (const row of echoRows("日本語のメッセージ", 24, styled)) {
      expect(displayWidth(row)).toBe(23);
    }
  });

  it("puts a message's own escapes on screen unchanged, measuring around them", () => {
    // The text may contain anything: it is styled, never interpreted, and
    // never rewritten. Only the *measurement* looks through the escapes.
    const styled = createStyles(true, TRUECOLOR);
    const message = `${ESC}[31mred${RESET}`;
    const row = echoRows(message, 20, styled)[0] ?? "";
    expect(row).toContain(message);
    expect(displayWidth(row)).toBe(19);
  });
});

describe("createBandDecor", () => {
  it("takes both the rule and the bar from one palette", () => {
    const decor = createBandDecor(createStyles(true, TRUECOLOR));
    expect(decor.rule(10)).toBe(createStyles(true, TRUECOLOR).rule(10));
    expect(decor.echo("x", 10)).toEqual(
      echoRows("x", 10, createStyles(true, TRUECOLOR)),
    );
  });

  it("follows the stream's own verdict about colour", () => {
    const piped = bandDecorFor({ isTTY: false }, {});
    expect(piped.echo("hi", 40)).toEqual(["> hi"]);
    const tty = bandDecorFor({ isTTY: true }, { COLORTERM: "truecolor" });
    expect(tty.echo("hi", 40)[0]).toContain(ECHO_256);
  });
});
