import * as readline from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBandDecor } from "../src/band.js";
import type {
  CommandMenuEntry,
  CompleterResult,
  ReverseSearchState,
} from "../src/input.js";
import {
  COMMAND_MENU_MAX_ROWS,
  CONTINUATION_PROMPT,
  commandMenuToken,
  composePendingRow,
  createInputManager,
  filterCommandMenu,
  flushAssembly,
  historyEntryFor,
  INPUT_SIGINT,
  initialAssembly,
  initialReverseSearch,
  localDisplayPos,
  REVERSE_SEARCH_MAX_ROWS,
  reduceAssemblyLine,
  reduceReverseSearch,
  renderCommandMenu,
  renderReverseSearch,
  reverseSearchMatches,
  reverseSearchSelection,
  toReadlineCompleter,
} from "../src/input.js";
import { createStyles, PLAIN_STYLES, ROLE_SGR } from "../src/styles.js";

const ESC = "\u001b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_R = "\x12";

// --- fixtures ----------------------------------------------------------------

/** A duplex stream that claims to be a terminal and records raw-mode flips. */
class FakeTtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }
}

class FakeOutput extends Writable {
  isTTY = false;
  /** Left undefined by default, exactly as a non-terminal stream is. */
  columns: number | undefined = undefined;
  chunks: string[] = [];

  override _write(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function makeIo(): { input: FakeTtyInput; output: FakeOutput } {
  return { input: new FakeTtyInput(), output: new FakeOutput() };
}

/** Both ends a terminal — the only shape the `/` menu draws in. */
function makeTtyIo(columns = 80): { input: FakeTtyInput; output: FakeOutput } {
  const io = makeIo();
  io.output.isTTY = true;
  io.output.columns = columns;
  return io;
}

/** Lets queued microtasks/macrotasks (readline's keypress + line handling) settle. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- pure reducer -------------------------------------------------------------

describe("reduceAssemblyLine", () => {
  it("strips a single trailing backslash and waits for more", () => {
    const action = reduceAssemblyLine(initialAssembly(), "foo\\");
    expect(action).toEqual({
      type: "continue",
      state: { pending: ["foo"] },
    });
  });

  it("treats a line ending in two backslashes as a literal backslash, complete", () => {
    const action = reduceAssemblyLine(initialAssembly(), "foo\\\\");
    expect(action).toEqual({ type: "message", text: "foo\\" });
  });

  it("joins continuation lines with the final line on completion", () => {
    let state = initialAssembly();
    const first = reduceAssemblyLine(state, "foo\\");
    expect(first.type).toBe("continue");
    state = (first as { state: typeof state }).state;
    const second = reduceAssemblyLine(state, "bar");
    expect(second).toEqual({ type: "message", text: "foo\nbar" });
  });

  it("terminates a pending block on a blank line, without including it", () => {
    const pending = { pending: ["a", "b"] };
    const action = reduceAssemblyLine(pending, "");
    expect(action).toEqual({ type: "message", text: "a\nb" });
  });

  it("treats a bare blank line (nothing pending) as an empty message", () => {
    const action = reduceAssemblyLine(initialAssembly(), "");
    expect(action).toEqual({ type: "message", text: "" });
  });

  it("resolves a plain line with nothing pending immediately", () => {
    const action = reduceAssemblyLine(initialAssembly(), "hello");
    expect(action).toEqual({ type: "message", text: "hello" });
  });
});

describe("flushAssembly", () => {
  it("returns undefined when nothing is pending", () => {
    expect(flushAssembly(initialAssembly())).toBeUndefined();
  });

  it("joins pending lines when something is pending", () => {
    expect(flushAssembly({ pending: ["a", "b"] })).toBe("a\nb");
  });
});

describe("historyEntryFor", () => {
  it("collapses newlines to spaces and trims", () => {
    expect(historyEntryFor("foo\nbar\nbaz")).toBe("foo bar baz");
  });

  it("trims surrounding whitespace", () => {
    expect(historyEntryFor("  foo  ")).toBe("foo");
  });

  it("is a no-op for a single-line message", () => {
    expect(historyEntryFor("hello")).toBe("hello");
  });
});

describe("CONTINUATION_PROMPT", () => {
  it("is a distinct, non-empty prompt", () => {
    expect(CONTINUATION_PROMPT).toBe("... ");
  });
});

// --- completion adapter --------------------------------------------------------

/** Calls the callback-form completer and resolves what it handed back. */
function completeThrough(
  completer: ReturnType<typeof toReadlineCompleter>,
  line: string,
): Promise<CompleterResult> {
  return new Promise((resolve) => {
    completer(line, (_error, result) => resolve(result));
  });
}

describe("toReadlineCompleter", () => {
  it("presents itself in the two-argument form readline treats as async", () => {
    expect(toReadlineCompleter(() => [[], ""]).length).toBe(2);
  });

  it("passes a synchronous completer's result straight through", async () => {
    const completer = toReadlineCompleter((line) => [["/help"], line]);
    await expect(completeThrough(completer, "/he")).resolves.toEqual([
      ["/help"],
      "/he",
    ]);
  });

  it("awaits an asynchronous completer", async () => {
    const completer = toReadlineCompleter(async (line) => {
      await tick(5);
      return [["@a.ts"], line] as CompleterResult;
    });
    await expect(completeThrough(completer, "@a")).resolves.toEqual([
      ["@a.ts"],
      "@a",
    ]);
  });

  it("turns a throw or a rejection into 'no completions', never an error", async () => {
    const thrower = toReadlineCompleter(() => {
      throw new Error("listing exploded");
    });
    await expect(completeThrough(thrower, "@a")).resolves.toEqual([[], "@a"]);

    const rejecter = toReadlineCompleter(() =>
      Promise.reject(new Error("git is gone")),
    );
    await expect(completeThrough(rejecter, "@a")).resolves.toEqual([[], "@a"]);
  });
});

// --- InputManager --------------------------------------------------------------

describe("InputManager.readMessage", () => {
  it("resolves a single typed line with its text", async () => {
    const { input, output } = makeIo();
    const appended: string[] = [];
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onHistoryAppend: (entry) => appended.push(entry),
    });

    const result = manager.readMessage("> ");
    input.write("hello\n");
    await expect(result).resolves.toBe("hello");
    expect(appended).toEqual(["hello"]);

    manager.close();
  });

  it("coalesces a multi-line paste written in one chunk into one message", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const result = manager.readMessage("> ");
    input.write("a\nb\nc\n");
    await expect(result).resolves.toBe("a\nb\nc");

    manager.close();
  });

  it("joins a backslash continuation split across two writes", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const result = manager.readMessage("> ");
    input.write("foo\\\n");
    await tick(10);
    input.write("bar\n");
    await expect(result).resolves.toBe("foo\nbar");

    manager.close();
  });

  it("resolves INPUT_SIGINT on Ctrl-C while a read is pending", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const result = manager.readMessage("> ");
    input.write(CTRL_C);
    await expect(result).resolves.toBe(INPUT_SIGINT);

    manager.close();
  });

  it("calls onIdleSigint on Ctrl-C when nothing is pending", async () => {
    const { input, output } = makeIo();
    let idleCalls = 0;
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onIdleSigint: () => {
        idleCalls += 1;
      },
    });

    input.write(CTRL_C);
    await tick(10);
    expect(idleCalls).toBe(1);

    manager.close();
  });

  it("resolves undefined on Ctrl-D / stream close", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const result = manager.readMessage("> ");
    input.write(CTRL_D);
    await expect(result).resolves.toBeUndefined();
  });

  it("resolves undefined immediately once the manager is closed", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    manager.close();
    await expect(manager.readMessage("> ")).resolves.toBeUndefined();
  });

  it("throws if a second readMessage overlaps the first", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    void manager.readMessage("> ");
    expect(() => manager.readMessage("> ")).toThrow(/already in progress/);

    manager.close();
  });

  it("shows the continuation prompt while a backslash block is open", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const result = manager.readMessage("> ");
    input.write("foo\\\n");
    await tick(10);
    expect(output.text).toContain(CONTINUATION_PROMPT);

    input.write("bar\n");
    await result;
    manager.close();
  });
});

describe("InputManager tab completion", () => {
  const TAB = "\t";

  it("inserts the remainder of a unique prefix completion", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      completer: (line) => [["/model"], line],
    });

    const result = manager.readMessage("> ");
    input.write("/mo");
    await tick(5);
    input.write(TAB);
    await tick(20);
    input.write("\n");
    await expect(result).resolves.toBe("/model");

    manager.close();
  });

  it("substitutes a fuzzy winner that shares no prefix with what was typed", async () => {
    const { input, output } = makeIo();
    // The `@` case: the completion replaces the token rather than extending
    // it, which is the only way `@clisrc` can become a real path.
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      completer: async (line) => {
        await tick(5);
        const token = line.slice(line.lastIndexOf(" ") + 1);
        return token.startsWith("@")
          ? ([["@apps/cli/src/input.ts"], token] as CompleterResult)
          : ([[], line] as CompleterResult);
      },
    });

    const result = manager.readMessage("> ");
    input.write("look at @clisrc");
    await tick(5);
    input.write(TAB);
    await tick(40);
    input.write("\n");
    await expect(result).resolves.toBe("look at @apps/cli/src/input.ts");

    manager.close();
  });

  it("leaves the line alone when the completer offers nothing", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      completer: (line) => [[], line],
    });

    const result = manager.readMessage("> ");
    input.write("hello wo");
    await tick(5);
    input.write(TAB);
    await tick(20);
    input.write("\n");
    await expect(result).resolves.toBe("hello wo");

    manager.close();
  });
});

describe("InputManager.question", () => {
  it("resolves the typed answer without touching the message path", async () => {
    const { input, output } = makeIo();
    const appended: string[] = [];
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onHistoryAppend: (entry) => appended.push(entry),
    });

    const answer = manager.question("allow? [y/N] ");
    input.write("y\n");
    await expect(answer).resolves.toBe("y");
    // A question answer must never be treated as a REPL message.
    expect(appended).toEqual([]);

    manager.close();
  });

  it("resolves INPUT_SIGINT on Ctrl-C while a question is pending", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const answer = manager.question("allow? [y/N] ");
    input.write(CTRL_C);
    await expect(answer).resolves.toBe(INPUT_SIGINT);

    manager.close();
  });

  it("throws if called while a readMessage is already pending", () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    void manager.readMessage("> ");
    expect(() => manager.question("q? ")).toThrow(/already in progress/);

    manager.close();
  });

  it("scrubs the question's answer out of readline history so it can't recall it", async () => {
    const { input, output } = makeIo();
    const appended: string[] = [];
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onHistoryAppend: (entry) => appended.push(entry),
    });

    // A permission-style question, answered "no" — must not become the most
    // recent recallable history entry.
    const answer = manager.question("allow rm? [y/N] ");
    input.write("no\n");
    await expect(answer).resolves.toBe("no");

    // A real message follows and lands in history in its recall-safe form.
    const message = manager.readMessage("> ");
    input.write("hello world\n");
    await expect(message).resolves.toBe("hello world");
    expect(appended).toEqual(["hello world"]);

    // Pressing Up should recall the message just sent, not the scrubbed
    // question answer — proof the answer never sat in readline's history.
    output.chunks = [];
    const recall = manager.readMessage("> ");
    input.write("\x1b[A"); // Up arrow
    await tick(10);
    expect(output.text).toContain("hello world");
    expect(output.text).not.toContain("no");

    // Clean up the still-pending recall read.
    input.write(CTRL_C);
    await recall;
    manager.close();
  });
});

describe("InputManager.withSuspended", () => {
  it("drops out of raw mode and restores it afterward, re-issuing the prompt", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const pending = manager.readMessage("> ");
    // Creating the interface flips raw mode on; reset the log so the
    // assertion below only sees withSuspended's own toggling.
    input.rawModes.length = 0;
    output.chunks = [];

    let ranInside = false;
    const returned = await manager.withSuspended(async () => {
      ranInside = true;
      await tick(5);
      return "select-prompt result";
    });

    expect(ranInside).toBe(true);
    expect(returned).toBe("select-prompt result");
    // Off for the suspended consumer, then back on for the REPL.
    expect(input.rawModes).toEqual([false, true]);
    // The prompt is re-shown once control returns to the REPL read.
    expect(output.text).toContain("> ");

    input.write("real\n");
    await expect(pending).resolves.toBe("real");
    manager.close();
  });
});

// --- the live slash-command menu ----------------------------------------------

const MENU: readonly CommandMenuEntry[] = [
  { name: "/help", description: "show this list" },
  { name: "/resume", description: "switch to a stored conversation" },
  {
    name: "/resume-run",
    description: "re-execute the unfinished tasks of a recorded run",
  },
  { name: "/runs", description: "list this workspace's recorded runs" },
];

/** The escape only `hideMenu` writes: down past the input, clear, come back. */
const HIDE = "[1B\r[0J";
/** The escape only `dropMenu` writes, from the row Enter's `\r\n` landed on. */
const DROP = "\r[0J";

describe("commandMenuToken", () => {
  it("offers the token as soon as a message starts with a slash", () => {
    expect(commandMenuToken("/", 1)).toBe("/");
    expect(commandMenuToken("/re", 3)).toBe("/re");
  });

  it("says nothing about a line that does not start with one", () => {
    expect(commandMenuToken("", 0)).toBeUndefined();
    expect(commandMenuToken("hello", 5)).toBeUndefined();
    expect(commandMenuToken(" /help", 6)).toBeUndefined();
    expect(commandMenuToken("what about /help", 16)).toBeUndefined();
  });

  it("closes the moment a space ends the command name", () => {
    // The keystroke that completes the command is the keystroke that hides
    // the menu: after the space the cursor is past the token's end.
    expect(commandMenuToken("/model", 6)).toBe("/model");
    expect(commandMenuToken("/model ", 7)).toBeUndefined();
    expect(commandMenuToken("/model opus", 11)).toBeUndefined();
  });

  it("reopens when the cursor moves back into a finished name", () => {
    // The buffer is offering a name again, so the list describing it belongs
    // back on screen — and it describes the whole token, not its left half.
    expect(commandMenuToken("/model opus", 3)).toBe("/model");
    expect(commandMenuToken("/model opus", 6)).toBe("/model");
    expect(commandMenuToken("/model opus", 0)).toBe("/model");
  });
});

describe("filterCommandMenu", () => {
  it("keeps every command under a bare slash, in registration order", () => {
    expect(filterCommandMenu(MENU, "/").map((entry) => entry.name)).toEqual([
      "/help",
      "/resume",
      "/resume-run",
      "/runs",
    ]);
  });

  it("narrows to the commands that start with what has been typed", () => {
    expect(filterCommandMenu(MENU, "/re").map((entry) => entry.name)).toEqual([
      "/resume",
      "/resume-run",
    ]);
    expect(
      filterCommandMenu(MENU, "/resume-").map((entry) => entry.name),
    ).toEqual(["/resume-run"]);
  });

  it("matches case-insensitively", () => {
    expect(filterCommandMenu(MENU, "/HE").map((entry) => entry.name)).toEqual([
      "/help",
    ]);
  });

  it("matches nothing for a name no command has", () => {
    expect(filterCommandMenu(MENU, "/zzz")).toEqual([]);
  });
});

describe("renderCommandMenu", () => {
  const plain = { columns: 80, styles: PLAIN_STYLES };

  it("draws one aligned `name  description` row per match", () => {
    const rows = renderCommandMenu(
      filterCommandMenu(MENU, "/re"),
      "/re",
      plain,
    );
    expect(rows).toEqual([
      "  /resume      switch to a stored conversation",
      "  /resume-run  re-execute the unfinished tasks of a recorded run",
    ]);
  });

  it("renders nothing at all when nothing matches", () => {
    expect(renderCommandMenu([], "/zzz", plain)).toEqual([]);
  });

  it("caps the rows and counts the rest", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      name: `/c${index}`,
      description: `command ${index}`,
    }));
    const rows = renderCommandMenu(many, "/", { ...plain, maxRows: 3 });
    expect(rows).toHaveLength(4);
    expect(rows[3]).toBe("  … and 9 more");
  });

  it("defaults the cap to COMMAND_MENU_MAX_ROWS", () => {
    const many = Array.from({ length: COMMAND_MENU_MAX_ROWS + 2 }, (_, i) => ({
      name: `/c${i}`,
      description: "x",
    }));
    const rows = renderCommandMenu(many, "/", plain);
    expect(rows).toHaveLength(COMMAND_MENU_MAX_ROWS + 1);
    expect(rows[COMMAND_MENU_MAX_ROWS]).toBe("  … and 2 more");
  });

  it("truncates a row to one cell short of the terminal's width", () => {
    // One short, because a row that exactly fills the width is wrapped by the
    // terminal — one more physical line than the redraw arithmetic counted.
    const rows = renderCommandMenu(filterCommandMenu(MENU, "/help"), "/help", {
      columns: 20,
      styles: PLAIN_STYLES,
    });
    expect(rows[0]).toBe("  /help  show this…");
    expect([...(rows[0] ?? "")].length).toBeLessThanOrEqual(19);
  });

  it("lifts the typed prefix out of each row in the user's own colour", () => {
    const rows = renderCommandMenu(filterCommandMenu(MENU, "/re"), "/re", {
      columns: 80,
      styles: createStyles(true),
    });
    const reset = "[0m";
    expect(rows[0]).toBe(
      `  [${ROLE_SGR.user}m/re${reset}[${ROLE_SGR.menu}msume      switch to a stored conversation${reset}`,
    );
  });

  it("marks no row as selected — nothing here is armed to Enter", () => {
    const rows = renderCommandMenu(MENU, "/", plain);
    for (const row of rows) {
      expect(row).not.toContain("❯");
      expect(row.startsWith("  /")).toBe(true);
    }
  });
});

// --- Ctrl+R reverse-i-search --------------------------------------------------

/** Newest first, the same convention `rlHistory` reads readline's own history in. */
const HISTORY: readonly string[] = [
  "look at render.ts",
  "git status",
  "npm test",
];

describe("reduceReverseSearch", () => {
  it("appends a typed character and resets the offset", () => {
    const state: ReverseSearchState = { query: "g", offset: 3 };
    expect(reduceReverseSearch(state, { type: "type", char: "i" })).toEqual({
      query: "gi",
      offset: 0,
    });
  });

  it("drops the last character on backspace and resets the offset", () => {
    const state: ReverseSearchState = { query: "git", offset: 2 };
    expect(reduceReverseSearch(state, { type: "backspace" })).toEqual({
      query: "gi",
      offset: 0,
    });
  });

  it("is a no-op backspacing an empty query", () => {
    const state = initialReverseSearch();
    expect(reduceReverseSearch(state, { type: "backspace" })).toBe(state);
  });

  it("cycle advances the offset and leaves the query alone", () => {
    const state: ReverseSearchState = { query: "git", offset: 0 };
    expect(reduceReverseSearch(state, { type: "cycle" })).toEqual({
      query: "git",
      offset: 1,
    });
  });
});

describe("reverseSearchMatches", () => {
  it("keeps only entries containing the query, newest first", () => {
    expect(reverseSearchMatches(HISTORY, "git")).toEqual(["git status"]);
  });

  it("matches case-insensitively", () => {
    expect(reverseSearchMatches(HISTORY, "GIT")).toEqual(["git status"]);
  });

  it("matches anywhere in the entry, not just a prefix", () => {
    expect(reverseSearchMatches(HISTORY, "render")).toEqual([
      "look at render.ts",
    ]);
  });

  it("an empty query matches everything, in history order", () => {
    expect(reverseSearchMatches(HISTORY, "")).toEqual(HISTORY);
  });

  it("matches nothing that isn't there", () => {
    expect(reverseSearchMatches(HISTORY, "zzz")).toEqual([]);
  });
});

describe("reverseSearchSelection", () => {
  const matches = ["fix bug", "fix typo"];

  it("is undefined with no matches", () => {
    expect(reverseSearchSelection(initialReverseSearch(), [])).toBeUndefined();
  });

  it("picks the match at the offset", () => {
    expect(reverseSearchSelection({ query: "fix", offset: 0 }, matches)).toBe(
      "fix bug",
    );
    expect(reverseSearchSelection({ query: "fix", offset: 1 }, matches)).toBe(
      "fix typo",
    );
  });

  it("wraps back around to the newest once every match has been seen", () => {
    expect(reverseSearchSelection({ query: "fix", offset: 2 }, matches)).toBe(
      "fix bug",
    );
  });
});

describe("renderReverseSearch", () => {
  const plain = { columns: 80, styles: PLAIN_STYLES };

  it("draws the indicator and the matches, newest first, best one marked", () => {
    const rows = renderReverseSearch(
      { query: "git", offset: 0 },
      HISTORY,
      plain,
    );
    expect(rows).toEqual(["(reverse-i-search) git", "❯ git status"]);
  });

  it("renders a dim failed indicator and nothing else when nothing matches", () => {
    const rows = renderReverseSearch(
      { query: "zzz", offset: 0 },
      HISTORY,
      plain,
    );
    expect(rows).toEqual(["(reverse-i-search) zzz — no match"]);
  });

  it("the window starts at the current selection, not at the newest match", () => {
    const history = ["fix bug", "chore", "fix typo"];
    const rows = renderReverseSearch({ query: "fix", offset: 1 }, history, {
      ...plain,
      maxRows: 4,
    });
    // "chore" doesn't match "fix" and is filtered out before the window is
    // even considered; "fix bug" is newer than the selection and scrolled
    // past rather than shown above it.
    expect(rows).toEqual(["(reverse-i-search) fix", "❯ fix typo"]);
  });

  it("caps match rows and counts the rest", () => {
    const many = Array.from({ length: 5 }, (_, i) => `cmd ${i}`);
    const rows = renderReverseSearch({ query: "cmd", offset: 0 }, many, {
      ...plain,
      maxRows: 2,
    });
    expect(rows).toEqual([
      "(reverse-i-search) cmd",
      "❯ cmd 0",
      "  cmd 1",
      "  … and 3 more",
    ]);
  });

  it("defaults the cap to REVERSE_SEARCH_MAX_ROWS", () => {
    const many = Array.from(
      { length: REVERSE_SEARCH_MAX_ROWS + 2 },
      (_, i) => `cmd ${i}`,
    );
    const rows = renderReverseSearch({ query: "cmd", offset: 0 }, many, plain);
    expect(rows).toHaveLength(REVERSE_SEARCH_MAX_ROWS + 2);
    expect(rows.at(-1)).toBe("  … and 2 more");
  });

  it("flattens a multiline history entry to one row", () => {
    const rows = renderReverseSearch(
      { query: "foo", offset: 0 },
      ["foo\nbar\nbaz"],
      plain,
    );
    expect(rows).toEqual(["(reverse-i-search) foo", "❯ foo bar baz"]);
  });

  it("truncates a row to one cell short of the terminal's width", () => {
    const rows = renderReverseSearch(
      { query: "git", offset: 0 },
      ["git commit -m a much longer message than fits"],
      { columns: 20, styles: PLAIN_STYLES },
    );
    expect([...(rows[1] ?? "")].length).toBeLessThanOrEqual(19);
    expect(rows[1]).toBe("❯ git commit -m a …");
  });

  it("styles the indicator's query and the marked match in the user's colour", () => {
    const styles = createStyles(true);
    const rows = renderReverseSearch(
      { query: "git", offset: 0 },
      ["git status"],
      { columns: 80, styles },
    );
    const reset = "\x1b[0m";
    expect(rows[0]).toBe(
      `\x1b[${ROLE_SGR.menu}m(reverse-i-search) ${reset}\x1b[${ROLE_SGR.user}mgit${reset}`,
    );
    expect(rows[1]).toBe(`\x1b[${ROLE_SGR.user}m❯ git status${reset}`);
  });
});

describe("InputManager Ctrl-C", () => {
  it("throws the abandoned line away instead of carrying it into the next read", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    // Half a command, then a change of mind.
    const abandoned = manager.readMessage("kapel> ");
    input.write("/res");
    await tick(10);
    input.write(CTRL_C);
    await expect(abandoned).resolves.toBe(INPUT_SIGINT);

    // The next thing typed is the whole of the next message. Before the fix
    // readline still held `/res`, and `prompt()` put the caret at 0 in front
    // of it: this dispatched `/exit/res`.
    const next = manager.readMessage("kapel> ");
    input.write("/exit\n");
    await expect(next).resolves.toBe("/exit");

    manager.close();
  });

  it("clears the buffer behind a cancelled question too", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const answer = manager.question("allow rm? [y/N] ");
    input.write("ye");
    await tick(10);
    input.write(CTRL_C);
    await expect(answer).resolves.toBe(INPUT_SIGINT);

    const next = manager.readMessage("kapel> ");
    input.write("hello\n");
    await expect(next).resolves.toBe("hello");

    manager.close();
  });

  it("ends the abandoned row, so what the REPL says next gets one of its own", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const pending = manager.readMessage("kapel> ");
    input.write("/res");
    await tick(10);
    output.chunks = [];
    input.write(CTRL_C);
    await pending;
    expect(output.text.endsWith("\r\n")).toBe(true);

    manager.close();
  });

  it("writes no newline for a Ctrl-C that reached an idle manager", async () => {
    // Mid-turn: nothing was typed, nothing was echoed, and a blank line here
    // would land in the middle of the assistant's output.
    const { input, output } = makeTtyIo();
    let idle = 0;
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onIdleSigint: () => {
        idle += 1;
      },
    });

    output.chunks = [];
    input.write(CTRL_C);
    await tick(10);
    expect(idle).toBe(1);
    expect(output.text).toBe("");

    manager.close();
  });
});

describe("InputManager command menu", () => {
  it("opens on `/`, narrows as the name is typed, and erases on submit", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const result = manager.readMessage("> ");

    // A bare slash lists everything the session has registered.
    output.chunks = [];
    input.write("/");
    await tick(10);
    const opened = output.text;
    expect(opened).toContain("/help");
    expect(opened).toContain("show this list");
    expect(opened).toContain("/resume-run");

    // One letter in, `/runs` is still a candidate…
    output.chunks = [];
    input.write("r");
    await tick(10);
    expect(output.text).toContain("recorded runs");

    // …and one more leaves only the two `/re…` commands.
    output.chunks = [];
    input.write("e");
    await tick(10);
    const narrowed = output.text;
    expect(narrowed).toContain("/resume");
    expect(narrowed).toContain("/resume-run");
    expect(narrowed).not.toContain("show this list");
    expect(narrowed).not.toContain("recorded runs");

    // Enter sends what was typed — not the one command the menu was down to.
    output.chunks = [];
    input.write("\n");
    await expect(result).resolves.toBe("/re");
    const submitted = output.text;
    expect(submitted).toContain(DROP);
    expect(submitted).not.toContain("resume");

    manager.close();
  });

  it("erases the menu the moment a space completes the command", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const result = manager.readMessage("> ");
    input.write("/resume");
    await tick(10);
    expect(output.text).toContain("switch to a stored conversation");

    output.chunks = [];
    input.write(" ");
    await tick(10);
    expect(output.text).toContain(HIDE);
    expect(output.text).not.toContain("switch to a stored conversation");

    input.write("abc\n");
    await expect(result).resolves.toBe("/resume abc");
    manager.close();
  });

  it("erases it when the line stops being a command at all", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const result = manager.readMessage("> ");
    input.write("/h");
    await tick(10);
    expect(output.text).toContain("show this list");

    // Backspace over the slash: no first token, no menu.
    input.write("\x7f");
    await tick(10);
    output.chunks = [];
    input.write("\x7f");
    await tick(10);
    expect(output.text).toContain(HIDE);
    expect(output.text).not.toContain("show this list");

    input.write("hello\n");
    await expect(result).resolves.toBe("hello");
    manager.close();
  });

  it("shows nothing for a name no command has", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const result = manager.readMessage("> ");
    input.write("/");
    await tick(10);
    output.chunks = [];
    input.write("zzz");
    await tick(10);
    // A list of no commands is worse than no list: the first `z` takes it
    // down and nothing after it puts anything back.
    expect(output.text).toContain(HIDE);
    expect(output.text).not.toContain("/help");
    expect(output.text).not.toContain("… and");

    input.write("\n");
    await expect(result).resolves.toBe("/zzz");
    manager.close();
  });

  it("erases the menu on Ctrl-C", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const result = manager.readMessage("> ");
    input.write("/re");
    await tick(10);
    expect(output.text).toContain("/resume-run");

    output.chunks = [];
    input.write(CTRL_C);
    await expect(result).resolves.toBe(INPUT_SIGINT);
    expect(output.text).toContain(HIDE);

    manager.close();
  });

  it("hides the menu while the terminal belongs to someone else", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const pending = manager.readMessage("> ");
    input.write("/re");
    await tick(10);

    output.chunks = [];
    await manager.withSuspended(async () => {
      await tick(5);
      // Whatever a select prompt writes here finds a clear screen below the
      // prompt: the menu came down before this ran.
      expect(output.text).toContain(HIDE);
      expect(output.text).not.toContain("/resume-run");
    });

    // …and it is back under the re-issued prompt once control returns.
    expect(output.text).toContain("/resume-run");

    input.write("\n");
    await expect(pending).resolves.toBe("/re");
    manager.close();
  });

  it("draws nothing at all when either end is not a terminal", async () => {
    for (const [inputTty, outputTty] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const { input, output } = makeTtyIo();
      input.isTTY = inputTty;
      output.isTTY = outputTty;
      const manager = createInputManager({
        input,
        output,
        pasteWindowMs: 5,
        commandMenu: () => MENU,
      });

      const result = manager.readMessage("> ");
      input.write("/re\n");
      await expect(result).resolves.toBe("/re");
      expect(output.text).not.toContain("/resume-run");
      expect(output.text).not.toContain(HIDE);
      manager.close();
    }
  });

  it("draws nothing when no command list was handed in", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const result = manager.readMessage("> ");
    input.write("/re\n");
    await expect(result).resolves.toBe("/re");
    expect(output.text).not.toContain(HIDE);
    manager.close();
  });

  it("never opens over a question — that prompt composes no message", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => MENU,
    });

    const answer = manager.question("allow? [y/N] ");
    output.chunks = [];
    input.write("/");
    await tick(10);
    expect(output.text).not.toContain("show this list");

    input.write("\n");
    await expect(answer).resolves.toBe("/");
    manager.close();
  });

  it("reads the command list afresh on every keystroke", async () => {
    const { input, output } = makeTtyIo();
    let entries: readonly CommandMenuEntry[] = MENU;
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      commandMenu: () => entries,
    });

    const result = manager.readMessage("> ");
    input.write("/");
    await tick(10);
    expect(output.text).not.toContain("/ship-it");

    // What `/help` rescanning `.agent/commands/` looks like from here.
    entries = [...MENU, { name: "/ship-it", description: "cut a release" }];
    output.chunks = [];
    input.write("s");
    await tick(10);
    expect(output.text).toContain("/ship-it");
    expect(output.text).toContain("cut a release");

    input.write("\n");
    await expect(result).resolves.toBe("/s");
    manager.close();
  });
});

// --- the input band -----------------------------------------------------------

/** The soft-white rules, plain, so the assertions read as rows and not escapes. */
const BAND = createBandDecor(PLAIN_STYLES);

/** A terminal wide enough to type in and short enough to reason about. */
function bandIo(
  columns = 20,
  rows = 10,
): {
  input: FakeTtyInput;
  output: FakeOutput;
} {
  const io = makeTtyIo(columns);
  (io.output as FakeOutput & { rows?: number }).rows = rows;
  return io;
}

describe("localDisplayPos", () => {
  /**
   * The fallback has to answer exactly what `readline` would, or the band and
   * the editor inside it would be counting rows by two different rules. These
   * are the cases where a wrong rule shows: the empty string, an exact row
   * boundary (where readline reports the *next* row at column 0), a
   * double-width character that will not fit in the last cell, and a string
   * carrying escapes that occupy no cells at all.
   */
  it("agrees with readline's own model, boundaries included", () => {
    const output = new FakeOutput();
    output.isTTY = true;
    output.columns = 10;
    const rl = readline.createInterface({
      input: new FakeTtyInput(),
      output,
      terminal: true,
    });
    const theirs = (
      rl as unknown as {
        _getDisplayPos: (value: string) => { rows: number; cols: number };
      }
    )._getDisplayPos;

    for (const sample of [
      "",
      "a",
      "abcdefghij",
      "abcdefghijk",
      "abcdefghijabcdefghij",
      "日本語abcd",
      "日本語abcde",
      "日本語日本語",
      `${ESC}[1mabcdefghij${ESC}[0m`,
      "abc\ndef",
    ]) {
      expect({ sample, ...localDisplayPos(sample, 10) }).toEqual({
        sample,
        ...theirs.call(rl, sample),
      });
    }
    rl.close();
  });
});

describe("InputManager band", () => {
  it("opens with a rule above the prompt and one below it", async () => {
    const { input, output } = bandIo();
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    const rule = PLAIN_STYLES.rule(20);
    // Two of them: one printed above, one painted below. The rules are what
    // say where the band is now that no `kapel>` does.
    expect(output.text.split(rule).length - 1).toBeGreaterThanOrEqual(2);
    expect(output.text.startsWith(`${rule}\r\n`)).toBe(true);

    input.write("hi\n");
    await expect(pending).resolves.toBe("hi");
    manager.close();
  });

  it("prints the sent message back as its own row, and takes the band down", async () => {
    const { input, output } = bandIo();
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    input.write("hello");
    await tick(10);
    output.chunks = [];
    input.write("\n");
    await expect(pending).resolves.toBe("hello");

    const submitted = output.text;
    // Up over the input row and the rule above it, then clear to the bottom:
    // the band, and the terminal's own echo of the keystrokes with it.
    expect(submitted).toContain(`${ESC}[2A\r${ESC}[0J`);
    // …and the message reappears as a row of the transcript instead.
    expect(submitted).toContain("> hello\r\n");
    expect(submitted.indexOf(`${ESC}[0J`)).toBeLessThan(
      submitted.indexOf("> hello"),
    );

    manager.close();
  });

  it("echoes a multiline message as one row per line", async () => {
    const { input, output } = bandIo();
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    output.chunks = [];
    input.write("first\\\n");
    await tick(10);
    input.write("second\n");
    await expect(pending).resolves.toBe("first\nsecond");

    expect(output.text).toContain("> first\r\n");
    expect(output.text).toContain("  second\r\n");
    manager.close();
  });

  it("leaves nothing behind for a line thrown away with Ctrl-C", async () => {
    const { input, output } = bandIo();
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    input.write("half a thought");
    await tick(10);
    output.chunks = [];
    input.write(CTRL_C);
    await expect(pending).resolves.toBe(INPUT_SIGINT);

    // The band closes over the abandoned line: it was never sent, so it gets
    // no bar, and half a message above the transcript would only be litter.
    expect(output.text).toContain(`${ESC}[2A\r${ESC}[0J`);
    expect(output.text).not.toContain(">");
    manager.close();
  });

  it("keeps the lower rule under the whole block when the line wraps", async () => {
    const { input, output } = bandIo(20);
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    // 25 cells on a 20-column terminal: two rows of input, and the rule has
    // to be drawn under the second one.
    input.write("x".repeat(25));
    await tick(10);
    output.chunks = [];
    input.write("y");
    await tick(10);

    const rule = PLAIN_STYLES.rule(20);
    const painted = output.text;
    expect(painted).toContain(rule);
    // One row below the caret's own row (the block's last), and back up by
    // the same one: the caret ends where readline left it, every time.
    expect(painted).toContain(`\r\n${ESC}[0J${rule}${ESC}[1A\r`);

    input.write("\n");
    await expect(pending).resolves.toBe(`${"x".repeat(25)}y`);
    manager.close();
  });

  it("materializes the phantom row at an exact wrap boundary", async () => {
    const { input, output } = bandIo(20);
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    output.chunks = [];
    // Exactly one row's worth. The terminal is now holding a deferred wrap —
    // caret at the last column of row 0 — while readline reports row 1,
    // column 0. Node resolves that with a space of its own, but only on the
    // code path a paste does not take, so the band writes one itself.
    input.write("x".repeat(20));
    await tick(10);
    expect(output.text).toContain(` \r${ESC}[0K`);

    input.write("\n");
    await expect(pending).resolves.toBe("x".repeat(20));
    manager.close();
  });

  it("erases the band from the top of a multiline block, however tall", async () => {
    const { input, output } = bandIo(20);
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    input.write("one\\\n");
    await tick(10);
    input.write("two\\\n");
    await tick(10);
    output.chunks = [];
    input.write("three\n");
    await expect(pending).resolves.toBe("one\ntwo\nthree");

    // Upper rule, then three echoed rows: the climb is four, not two.
    expect(output.text).toContain(`${ESC}[4A\r${ESC}[0J`);
    manager.close();
  });

  it("refuses to climb past the top of a screen the band has outgrown", async () => {
    // A band taller than the terminal would have its erase stop at row 0 and
    // take the transcript with it. Leaving it on screen is the better of the
    // two failures, so that is what happens.
    const { input, output } = bandIo(20, 4);
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    input.write("x".repeat(70));
    await tick(10);
    output.chunks = [];
    input.write("\n");
    await expect(pending).resolves.toBe("x".repeat(70));

    // Nothing climbs, and no bar: the rows the band is still sitting on are
    // showing the message as the terminal echoed it, and a second copy of it
    // underneath would read as two messages.
    expect(output.text).not.toContain(`${ESC}[4A`);
    expect(output.text).not.toContain("> x");
    manager.close();
  });

  it("draws the menu under the band, not inside it", async () => {
    const { input, output } = bandIo(60);
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      commandMenu: () => MENU,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    output.chunks = [];
    input.write("/re");
    await tick(10);

    const rule = PLAIN_STYLES.rule(60);
    const painted = output.text;
    // The rules bound what you are typing; a list of what you might be typing
    // is a suggestion about it, and belongs outside the frame.
    expect(painted.indexOf(rule)).toBeLessThan(painted.indexOf("/resume"));

    input.write("\n");
    await expect(pending).resolves.toBe("/re");
    manager.close();
  });

  it("takes the band down for another consumer and puts it back after", async () => {
    const { input, output } = bandIo();
    const manager = createInputManager({
      input,
      output,
      band: BAND,
      pasteWindowMs: 5,
    });

    const pending = manager.readMessage("");
    await tick(10);
    output.chunks = [];
    await manager.withSuspended(async () => {
      await tick(5);
      // A select prompt drawing here finds a clear screen: the band came down
      // before it ran, rules and all.
      expect(output.text).toContain(`${ESC}[0J`);
      expect(output.text).not.toContain(PLAIN_STYLES.rule(20));
    });
    // …and is drawn again, from scratch, wherever the child left the cursor.
    expect(output.text).toContain(PLAIN_STYLES.rule(20));

    input.write("\n");
    await expect(pending).resolves.toBe("");
    manager.close();
  });

  it("writes not one byte of it when either end is not a terminal", async () => {
    for (const [inputTty, outputTty] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const io = makeIo();
      io.input.isTTY = inputTty;
      io.output.isTTY = outputTty;
      io.output.columns = 20;
      const manager = createInputManager({
        input: io.input,
        output: io.output,
        band: BAND,
        pasteWindowMs: 5,
      });
      const pending = manager.readMessage("kapel> ");
      io.input.write("hello\n");
      await expect(pending).resolves.toBe("hello");
      expect(io.output.text).not.toContain("─");
      expect(io.output.text).not.toContain("> hello");
      manager.close();
    }
  });
});

// --- typing while a turn runs ------------------------------------------------

describe("composePendingRow", () => {
  it("marks the cursor's position inside the line", () => {
    expect(composePendingRow("abcd", 2)).toBe("> ab▏cd");
  });

  it("puts the caret at the end when the cursor is past it", () => {
    expect(composePendingRow("abcd", 99)).toBe("> abcd▏");
  });

  it("wears the same marker a sent message wears in the transcript", () => {
    expect(composePendingRow("hi", 0).startsWith("> ")).toBe(true);
  });
});

describe("InputManager.captureWhileBusy", () => {
  it("catches a line typed mid-turn instead of dropping it", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const caught: string[] = [];

    const end = manager.captureWhileBusy((line) => caught.push(line));
    input.write("check the tests too\n");
    await tick(10);

    expect(caught).toEqual(["check the tests too"]);
    end();
    manager.close();
  });

  it("drops the line as before when no capture is open", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const caught: string[] = [];
    manager.captureWhileBusy((line) => caught.push(line))();

    input.write("nobody is listening\n");
    await tick(10);

    expect(caught).toEqual([]);
    manager.close();
  });

  it("catches every line of a burst, in order", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const caught: string[] = [];

    manager.captureWhileBusy((line) => caught.push(line));
    input.write("first\nsecond\n");
    await tick(10);

    expect(caught).toEqual(["first", "second"]);
    manager.close();
  });

  it("skips a bare Enter", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const caught: string[] = [];

    manager.captureWhileBusy((line) => caught.push(line));
    input.write("\n   \n");
    await tick(10);

    expect(caught).toEqual([]);
    manager.close();
  });

  it("records a captured line in the session's history", async () => {
    const { input, output } = makeIo();
    const appended: string[] = [];
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onHistoryAppend: (entry) => appended.push(entry),
    });

    manager.captureWhileBusy(() => undefined);
    input.write("and the docs\n");
    await tick(10);

    expect(appended).toEqual(["and the docs"]);
    manager.close();
  });

  it("echoes nothing while the capture is open", async () => {
    const io = makeTtyIo();
    const manager = createInputManager({
      input: io.input,
      output: io.output,
      pasteWindowMs: 5,
      band: createBandDecor(createStyles(true)),
    });

    manager.captureWhileBusy(() => undefined);
    io.output.chunks.length = 0;
    io.input.write("secret");
    await tick(10);

    expect(io.output.text).toBe("");
    manager.close();
  });

  it("offers the line being typed as a row to paint, and takes it back on Enter", async () => {
    const { input, output } = makeIo();
    const changes: string[] = [];
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onPendingChange: () => {
        changes.push(manager.pendingRow() ?? "(none)");
      },
    });

    manager.captureWhileBusy(() => undefined);
    expect(manager.pendingRow()).toBeUndefined();
    input.write("ab");
    await tick(10);
    expect(manager.pendingRow()).toBe("> ab▏");

    input.write("\n");
    await tick(10);
    expect(manager.pendingRow()).toBeUndefined();
    expect(changes.at(-1)).toBe("(none)");

    manager.close();
  });

  it("shows no pending row once the capture is closed", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const end = manager.captureWhileBusy(() => undefined);
    input.write("half a thought");
    await tick(10);
    expect(manager.pendingRow()).toBe("> half a thought▏");

    end();
    expect(manager.pendingRow()).toBeUndefined();
    manager.close();
  });

  it("leaves a half-typed line in the editor for the next prompt", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const end = manager.captureWhileBusy(() => undefined);
    input.write("half a thought");
    await tick(10);
    end();

    const result = manager.readMessage("> ");
    input.write(", finished\n");
    await expect(result).resolves.toBe("half a thought, finished");

    manager.close();
  });

  it("throws to open a second capture over the first", () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    manager.captureWhileBusy(() => undefined);
    expect(() => manager.captureWhileBusy(() => undefined)).toThrow(
      /already open/,
    );

    manager.close();
  });

  it("abandons the half-typed line on Ctrl-C, and still cancels the turn", async () => {
    const { input, output } = makeIo();
    let idleCalls = 0;
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      onIdleSigint: () => {
        idleCalls += 1;
      },
    });

    manager.captureWhileBusy(() => undefined);
    input.write("never mind");
    await tick(10);
    input.write(CTRL_C);
    await tick(10);

    expect(idleCalls).toBe(1);
    expect(manager.pendingRow()).toBeUndefined();
    manager.close();
  });

  it("hands the editor to a permission question opened during the same turn", async () => {
    const { input, output } = makeIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const caught: string[] = [];

    manager.captureWhileBusy((line) => caught.push(line));
    input.write("steering this");
    await tick(10);

    const answer = manager.question("allow? [y/n] ");
    // The fragment goes with the question: one editor, and the question is
    // the thing with a turn waiting on it.
    expect(manager.pendingRow()).toBeUndefined();
    output.chunks.length = 0;
    input.write("y\n");
    await expect(answer).resolves.toBe("y");
    // Echo is back on for the answer — a question nobody can see is worse
    // than no question at all.
    expect(output.text).toContain("y");
    expect(caught).toEqual([]);

    manager.close();
  });
});

// --- Ctrl+R reverse-i-search, end to end --------------------------------------

describe("InputManager reverse-i-search", () => {
  it("opens on Ctrl+R and narrows the match as the query is typed", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["look at render.ts", "git status", "npm test"],
    });

    manager.readMessage("> ");
    output.chunks = [];
    input.write(CTRL_R);
    await tick(10);
    // Nothing typed yet: the newest entry, whatever it is.
    expect(output.text).toContain("(reverse-i-search)");
    expect(output.text).toContain("❯ look at render.ts");

    output.chunks = [];
    input.write("git");
    await tick(10);
    expect(output.text).toContain("(reverse-i-search) git");
    expect(output.text).toContain("❯ git status");
    expect(output.text).not.toContain("look at render.ts");
    expect(output.text).not.toContain("npm test");

    manager.close();
  });

  it("cycles to the next older match on repeated Ctrl+R, wrapping back around", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["fix bug", "list files", "fix typo"],
    });

    manager.readMessage("> ");
    input.write(CTRL_R);
    await tick(10);
    input.write("fix");
    await tick(10);
    expect(output.text).toContain("❯ fix bug");
    expect(output.text).toContain("fix typo");

    output.chunks = [];
    input.write(CTRL_R);
    await tick(10);
    expect(output.text).toContain("❯ fix typo");
    expect(output.text).not.toContain("fix bug");

    // A third Ctrl+R has cycled past every match there is; it wraps back to
    // the newest one instead of running off the end.
    output.chunks = [];
    input.write(CTRL_R);
    await tick(10);
    expect(output.text).toContain("❯ fix bug");

    manager.close();
  });

  it("accepts into the buffer on Enter, caret at the end, without sending it", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["run the deploy script"],
    });

    const result = manager.readMessage("> ");
    input.write(CTRL_R);
    await tick(10);
    input.write("deploy");
    await tick(10);
    expect(output.text).toContain("run the deploy script");

    output.chunks = [];
    input.write("\n"); // Enter: accept the match, not submit the line.
    await tick(10);
    // The search UI came down; the line was not sent.
    expect(output.text).toContain(HIDE);

    // Editing continues from the end of the accepted entry, and only the
    // *real* Enter that follows actually sends it.
    input.write(" for prod\n");
    await expect(result).resolves.toBe("run the deploy script for prod");
    manager.close();
  });

  it("accepts on Tab as well as Enter", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["git status"],
    });

    const result = manager.readMessage("> ");
    input.write(CTRL_R);
    await tick(10);
    input.write("git");
    await tick(10);
    input.write("\t");
    await tick(10);

    input.write("\n");
    await expect(result).resolves.toBe("git status");
    manager.close();
  });

  it("cancels on Escape and restores exactly what was typed before Ctrl+R", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["git status"],
    });

    const result = manager.readMessage("> ");
    input.write("hello wo");
    await tick(10);
    input.write(CTRL_R);
    await tick(10);
    input.write("git");
    await tick(10);
    expect(output.text).toContain("git status");

    output.chunks = [];
    input.write(ESC);
    // A bare Escape is ambiguous with the start of an Alt-combo or a CSI
    // sequence until `readline`'s own escape-code timeout (~500ms) lapses
    // with nothing following it — the keypress itself does not fire, and
    // search does not close, until this elapses.
    await tick(600);
    expect(output.text).toContain(HIDE);
    expect(output.text).not.toContain("git status");

    input.write("\n");
    await expect(result).resolves.toBe("hello wo");
    manager.close();
  });

  it("Ctrl-C in search mode cancels the search, not the line being typed", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["deploy prod"],
    });

    const result = manager.readMessage("> ");
    input.write("keep this");
    await tick(10);
    input.write(CTRL_R);
    await tick(10);
    input.write("deploy");
    await tick(10);
    expect(output.text).toContain("(reverse-i-search) deploy");

    input.write(CTRL_C);
    await tick(10);
    // Still open: the abort-the-line Ctrl-C never ran, because `readline`
    // never saw this keystroke at all while search had its listener off.
    input.write(", finished\n");
    await expect(result).resolves.toBe("keep this, finished");
    manager.close();
  });

  it("shows a failed indicator with no match; backspace recovers it", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["alpha"],
    });

    manager.readMessage("> ");
    input.write(CTRL_R);
    await tick(10);
    input.write("alpha");
    await tick(10);
    expect(output.text).toContain("❯ alpha");

    output.chunks = [];
    input.write("z");
    await tick(10);
    expect(output.text).toContain("(reverse-i-search) alphaz — no match");
    expect(output.text).not.toContain("❯");

    output.chunks = [];
    input.write("\x7f");
    await tick(10);
    expect(output.text).toContain("❯ alpha");
    expect(output.text).not.toContain("no match");

    manager.close();
  });

  it("does not activate during a mid-turn capture", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });
    const caught: string[] = [];

    manager.captureWhileBusy((line) => caught.push(line));
    output.chunks = [];
    input.write(CTRL_R);
    await tick(10);
    expect(output.text).not.toContain("(reverse-i-search)");

    input.write("abc\n");
    await tick(10);
    expect(caught).toEqual(["abc"]);
    manager.close();
  });

  it("does not activate while a permission question is open", async () => {
    const { input, output } = makeTtyIo();
    const manager = createInputManager({ input, output, pasteWindowMs: 5 });

    const answer = manager.question("allow? [y/N] ");
    output.chunks = [];
    input.write(CTRL_R);
    await tick(10);
    expect(output.text).not.toContain("(reverse-i-search)");

    input.write("y\n");
    await expect(answer).resolves.toBe("y");
    manager.close();
  });

  it("is inert on a non-TTY session", async () => {
    const { input, output } = makeTtyIo();
    input.isTTY = false;
    const manager = createInputManager({
      input,
      output,
      pasteWindowMs: 5,
      history: ["git status"],
    });

    const result = manager.readMessage("> ");
    input.write(`${CTRL_R}git\n`);
    await expect(result).resolves.toBe("git");
    expect(output.text).not.toContain("(reverse-i-search)");
    manager.close();
  });
});
