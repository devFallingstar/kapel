import { describe, expect, it } from "vitest";
import {
  diffLines,
  formatToolPreview,
  PREVIEW_MAX_LINES,
  previewBash,
  previewEdit,
  previewInput,
  previewWrite,
  renderDiff,
} from "../src/preview.js";

// --- diffLines ----------------------------------------------------------------

describe("diffLines", () => {
  it("marks a single changed line", () => {
    expect(diffLines("a - b", "a + b")).toEqual([
      { marker: "-", text: "a - b" },
      { marker: "+", text: "a + b" },
    ]);
  });

  it("keeps common leading and trailing lines as context", () => {
    const lines = diffLines("one\ntwo\nthree", "one\nTWO\nthree");
    expect(lines).toEqual([
      { marker: " ", text: "one" },
      { marker: "-", text: "two" },
      { marker: "+", text: "TWO" },
      { marker: " ", text: "three" },
    ]);
  });

  it("reports a pure insertion as additions only", () => {
    expect(diffLines("a\nb", "a\nx\nb")).toEqual([
      { marker: " ", text: "a" },
      { marker: "+", text: "x" },
      { marker: " ", text: "b" },
    ]);
  });

  it("reports a pure deletion as removals only", () => {
    expect(diffLines("a\nx\nb", "a\nb")).toEqual([
      { marker: " ", text: "a" },
      { marker: "-", text: "x" },
      { marker: " ", text: "b" },
    ]);
  });

  it("finds the common subsequence in an interleaved change", () => {
    const lines = diffLines("a\nb\nc\nd", "a\nc\nd\ne");
    expect(lines.filter((line) => line.marker === "-")).toEqual([
      { marker: "-", text: "b" },
    ]);
    expect(lines.filter((line) => line.marker === "+")).toEqual([
      { marker: "+", text: "e" },
    ]);
  });

  it("is empty of changes for identical text", () => {
    expect(
      diffLines("same\nlines", "same\nlines").every((l) => l.marker === " "),
    ).toBe(true);
  });

  it("degrades to remove-all/add-all for a very large hunk", () => {
    const oldText = Array.from({ length: 400 }, (_, i) => `old ${i}`).join(
      "\n",
    );
    const newText = Array.from({ length: 400 }, (_, i) => `new ${i}`).join(
      "\n",
    );
    const lines = diffLines(oldText, newText);
    expect(lines.length).toBe(800);
    expect(lines[0]).toEqual({ marker: "-", text: "old 0" });
    expect(lines[400]).toEqual({ marker: "+", text: "new 0" });
  });
});

// --- renderDiff ---------------------------------------------------------------

describe("renderDiff", () => {
  it("indents markers and leaves context unmarked", () => {
    expect(renderDiff(diffLines("one\ntwo", "one\nTWO"))).toEqual([
      "    one",
      "  - two",
      "  + TWO",
    ]);
  });

  it("collapses long runs of untouched lines", () => {
    const same = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const oldText = ["head", ...same, "tail"].join("\n");
    const newText = ["HEAD", ...same, "TAIL"].join("\n");
    const rendered = renderDiff(diffLines(oldText, newText));
    expect(rendered.filter((line) => line.trim() === "\u22ee")).toHaveLength(1);
    expect(rendered).toContain("  - head");
    expect(rendered).toContain("  + TAIL");
  });

  it("caps the output and reports how much was dropped", () => {
    const oldText = Array.from({ length: 100 }, (_, i) => `x${i}`).join("\n");
    const rendered = renderDiff(diffLines(oldText, ""));
    expect(rendered).toHaveLength(PREVIEW_MAX_LINES);
    expect(rendered[PREVIEW_MAX_LINES - 1]).toMatch(/^ {2}… \(\+\d+ more\)$/);
  });

  it("colours removals red and additions green only when asked", () => {
    const lines = diffLines("a", "b");
    expect(renderDiff(lines)).toEqual(["  - a", "  + b"]);
    expect(renderDiff(lines, { color: true })).toEqual([
      "\u001b[31m  - a\u001b[0m",
      "\u001b[32m  + b\u001b[0m",
    ]);
  });
});

// --- previewBash --------------------------------------------------------------

describe("previewBash", () => {
  it("shows the command in full, indented", () => {
    expect(previewBash({ command: "npm test --run foo" })).toBe(
      "  npm test --run foo",
    );
  });

  it("keeps a multi-line command's own line breaks", () => {
    expect(previewBash({ command: "cd src\nnpm test" })).toBe(
      "  cd src\n  npm test",
    );
  });

  it("truncates an enormous command", () => {
    const command = Array.from({ length: 100 }, (_, i) => `echo ${i}`).join(
      "\n",
    );
    const lines = previewBash({ command })?.split("\n") ?? [];
    expect(lines).toHaveLength(PREVIEW_MAX_LINES);
    expect(lines.at(-1)).toContain("(+61 more)");
  });

  it("declines an input that is not a bash input", () => {
    expect(previewBash({ nope: 1 })).toBeUndefined();
    expect(previewBash("ls")).toBeUndefined();
  });
});

// --- previewEdit --------------------------------------------------------------

describe("previewEdit", () => {
  it("heads the diff with the path", () => {
    expect(
      previewEdit({ path: "calc.js", oldText: "a - b", newText: "a + b" }),
    ).toBe(["  calc.js", "  - a - b", "  + a + b"].join("\n"));
  });

  it("says when every occurrence is being replaced", () => {
    const preview = previewEdit({
      path: "calc.js",
      oldText: "x",
      newText: "y",
      replaceAll: true,
    });
    expect(preview?.split("\n")[0]).toBe("  calc.js (all occurrences)");
  });

  it("declines an input missing the edit fields", () => {
    expect(previewEdit({ path: "calc.js" })).toBeUndefined();
  });
});

// --- previewWrite -------------------------------------------------------------

describe("previewWrite", () => {
  it("shows the path, the line count and the content as additions", () => {
    expect(previewWrite({ path: "a.txt", content: "one\ntwo" })).toBe(
      ["  a.txt (2 lines)", "  + one", "  + two"].join("\n"),
    );
  });

  it("counts a single line in the singular", () => {
    expect(
      previewWrite({ path: "a.txt", content: "one" })?.split("\n")[0],
    ).toBe("  a.txt (1 line)");
  });

  it("shows the first 20 lines and reports the rest", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const lines = previewWrite({ path: "a.txt", content })?.split("\n") ?? [];
    expect(lines).toHaveLength(22);
    expect(lines.at(-1)).toBe("  … (+10 more)");
  });

  it("declines an input missing the content", () => {
    expect(previewWrite({ path: "a.txt" })).toBeUndefined();
  });
});

// --- formatToolPreview --------------------------------------------------------

describe("formatToolPreview", () => {
  it("routes each tool to its own preview", () => {
    expect(formatToolPreview("bash", { command: "ls" })).toBe("  ls");
    expect(
      formatToolPreview("edit_file", { path: "a", oldText: "x", newText: "y" }),
    ).toContain("  - x");
    expect(
      formatToolPreview("write_file", { path: "a", content: "x" }),
    ).toContain("  + x");
  });

  it("has nothing to add for other tools", () => {
    expect(formatToolPreview("grep", { pattern: "add" })).toBeUndefined();
    expect(formatToolPreview("read_file", { path: "a.ts" })).toBeUndefined();
  });

  it("has nothing to add when the input does not match the tool schema", () => {
    expect(formatToolPreview("bash", { command: 12 })).toBeUndefined();
  });
});

// --- previewInput (unchanged behaviour) ---------------------------------------

describe("previewInput", () => {
  it("renders compact JSON", () => {
    expect(previewInput({ pattern: "add" })).toBe('{"pattern":"add"}');
  });

  it("truncates at 120 characters", () => {
    const preview = previewInput({ text: "x".repeat(500) });
    expect(preview).toHaveLength(120);
    expect(preview.endsWith("...")).toBe(true);
  });
});
