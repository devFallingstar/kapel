import { describe, expect, it } from "vitest";
import {
  extractQuotedFragments,
  formatSourceLocation,
  locateIssue,
  locateIssues,
  locateSourceText,
} from "../src/index.js";

const MARKDOWN = `# Orchestration

The lead plans everything. Coder handles implementation work.

Reviewers must approve auth changes before they land.
Try to keep things simple as needed.

Escalate to lead after two failed attempts.
`;

describe("extractQuotedFragments", () => {
  it("extracts double-quoted phrases in source order, longest first", () => {
    const text =
      'Cannot map "as needed" cadence and also "two failed attempts".';
    expect(extractQuotedFragments(text)).toEqual([
      "two failed attempts",
      "as needed",
    ]);
  });

  it("extracts single-quoted and backtick-quoted phrases too", () => {
    expect(extractQuotedFragments("saw 'auth changes' noted")).toEqual([
      "auth changes",
    ]);
    expect(extractQuotedFragments("saw `auth changes` noted")).toEqual([
      "auth changes",
    ]);
  });

  it("drops fragments shorter than the minimum length", () => {
    expect(extractQuotedFragments('the word "id" is too short')).toEqual([]);
  });

  it("returns an empty list when there is nothing quoted", () => {
    expect(extractQuotedFragments("no quotes here at all")).toEqual([]);
  });
});

describe("locateSourceText", () => {
  it("finds an exact quoted phrase and reports its line", () => {
    const location = locateSourceText(
      MARKDOWN,
      'Ambiguous: "Reviewers must approve auth changes before they land."',
    );
    expect(location).toEqual({ file: "orchestration.md", line: 5 });
  });

  it("finds a shorter exact phrase on a single line", () => {
    const location = locateSourceText(
      MARKDOWN,
      'unclear scope for "lead plans"',
    );
    expect(location).toEqual({ file: "orchestration.md", line: 3 });
  });

  it("falls back to a case/whitespace-insensitive match", () => {
    // Different case and collapsed whitespace vs. the source line.
    const location = locateSourceText(
      MARKDOWN,
      'assumption: "CODER   handles Implementation work"',
    );
    expect(location).toEqual({ file: "orchestration.md", line: 3 });
  });

  it("resolves a multi-line quoted phrase and reports the line range", () => {
    const wrapped = [
      "# Title",
      "",
      "This policy always routes payments work to the",
      "senior reviewer before it merges.",
      "",
    ].join("\n");
    const location = locateSourceText(
      wrapped,
      'hard requirement: "routes payments work to the senior reviewer"',
    );
    expect(location).toEqual({ file: "orchestration.md", line: 3, endLine: 4 });
  });

  it("tries every quoted fragment, not just the first", () => {
    const text =
      'Cannot map "nonexistent phrase entirely" but did map "two failed attempts"';
    const location = locateSourceText(MARKDOWN, text);
    expect(location).toEqual({ file: "orchestration.md", line: 8 });
  });

  it("returns undefined when nothing in the source matches", () => {
    const location = locateSourceText(
      MARKDOWN,
      'no idea what "some phrase not in the document" means',
    );
    expect(location).toBeUndefined();
  });

  it("returns undefined when the message quotes nothing at all", () => {
    expect(
      locateSourceText(MARKDOWN, "vague judgement call, no quote"),
    ).toBeUndefined();
  });
});

describe("locateIssue / locateIssues", () => {
  it("pairs a message with its resolved location", () => {
    const located = locateIssue(
      '"Escalate to lead after two failed attempts."',
      MARKDOWN,
    );
    expect(located.message).toBe(
      '"Escalate to lead after two failed attempts."',
    );
    expect(located.location).toEqual({ file: "orchestration.md", line: 8 });
  });

  it("omits location when the message doesn't resolve", () => {
    const located = locateIssue("no location possible here", MARKDOWN);
    expect(located.location).toBeUndefined();
  });

  it("maps a whole list, one entry per message, in order", () => {
    const located = locateIssues(
      [
        '"Coder handles implementation work." routing is implicit',
        "an unrelated warning with no quote",
      ],
      MARKDOWN,
    );
    expect(located).toHaveLength(2);
    expect(located[0]?.location).toEqual({ file: "orchestration.md", line: 3 });
    expect(located[1]?.location).toBeUndefined();
  });
});

describe("formatSourceLocation", () => {
  it("formats a single-line location as file:line", () => {
    expect(formatSourceLocation({ file: "orchestration.md", line: 12 })).toBe(
      "orchestration.md:12",
    );
  });

  it("formats a multi-line location as file:line-endLine", () => {
    expect(
      formatSourceLocation({ file: "orchestration.md", line: 12, endLine: 13 }),
    ).toBe("orchestration.md:12-13");
  });
});
