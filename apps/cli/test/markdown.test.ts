import { describe, expect, it } from "vitest";
import { createMarkdownStream, renderMarkdown } from "../src/markdown.js";
import { createStyles } from "../src/styles.js";

/** A palette with colour on, pinned to the basic tier so codes are stable. */
const STYLES = createStyles(true, { COLORTERM: "", TERM: "xterm" });
const PLAIN = createStyles(false);

const RESET = "[0m";
const BOLD = "[1m";
/** The basic-tier accent — see `ACCENT_BASIC` in styles.ts. */
const CODE = `[${STYLES.sgr.accent}m`;
const DIM = "[2m";

describe("renderMarkdown", () => {
  it("renders **bold** as bold, markers swallowed", () => {
    expect(renderMarkdown("a **b** c", STYLES)).toBe(
      `a ${RESET}${BOLD}b${RESET} c`,
    );
  });

  it("renders __bold__ the same way", () => {
    expect(renderMarkdown("a __b__ c", STYLES)).toBe(
      `a ${RESET}${BOLD}b${RESET} c`,
    );
  });

  it("renders `code` in the accent, markers swallowed", () => {
    expect(renderMarkdown("run `ls` now", STYLES)).toBe(
      `run ${RESET}${CODE}ls${RESET} now`,
    );
  });

  it("renders a # heading line bold, marker swallowed", () => {
    expect(renderMarkdown("## Title\nbody", STYLES)).toBe(
      `${RESET}${BOLD}Title${RESET}\nbody`,
    );
  });

  it("leaves seven or more hashes alone — markdown stops at six", () => {
    expect(renderMarkdown("####### nope", STYLES)).toBe("####### nope");
  });

  it("leaves single *stars* and snake_case untouched", () => {
    expect(renderMarkdown("2*3 and snake_case *word*", STYLES)).toBe(
      "2*3 and snake_case *word*",
    );
  });

  it("treats markers inside a `code` span as literal", () => {
    expect(renderMarkdown("`a ** b`", STYLES)).toBe(
      `${RESET}${CODE}a ** b${RESET}`,
    );
  });

  it("dims fence lines and leaves fenced content verbatim", () => {
    const text = "```ts\nconst a = 1; // **not bold**\n```\ndone";
    expect(renderMarkdown(text, STYLES)).toBe(
      `${DIM}\`\`\`ts${RESET}\nconst a = 1; // **not bold**\n${DIM}\`\`\`${RESET}\ndone`,
    );
  });

  it("closes an unmatched marker at the newline — no style bleeds on", () => {
    expect(renderMarkdown("**oops\nplain", STYLES)).toBe(
      `${RESET}${BOLD}oops${RESET}\nplain`,
    );
  });

  it("is the identity with colour off", () => {
    const text = "# H\n**b** `c`";
    expect(renderMarkdown(text, PLAIN)).toBe(text);
  });
});

describe("createMarkdownStream", () => {
  it("renders a ** split across two deltas", () => {
    const stream = createMarkdownStream(STYLES);
    const out =
      stream.push("a *") +
      stream.push("*b*") +
      stream.push("* c") +
      stream.flush();
    expect(out).toBe(`a ${RESET}${BOLD}b${RESET} c`);
  });

  it("holds a line-start hash run until the heading is decided", () => {
    const stream = createMarkdownStream(STYLES);
    const out = stream.push("##") + stream.push(" Two\n") + stream.flush();
    expect(out).toBe(`${RESET}${BOLD}Two${RESET}\n`);
  });

  it("emits a held half-marker literally on flush", () => {
    const stream = createMarkdownStream(STYLES);
    const out = stream.push("dangling *") + stream.flush();
    expect(out).toBe("dangling *");
  });

  it("resets its state on flush, ready for the next turn", () => {
    const stream = createMarkdownStream(STYLES);
    stream.push("**open");
    stream.flush();
    expect(stream.push("plain") + stream.flush()).toBe("plain");
  });

  it("passes chunks through untouched with colour off", () => {
    const stream = createMarkdownStream(PLAIN);
    expect(stream.push("**b** `c`")).toBe("**b** `c`");
    expect(stream.flush()).toBe("");
  });
});
