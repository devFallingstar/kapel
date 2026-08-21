import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CommandMenuEntry, CompleterResult } from "../src/input.js";
import {
  COMMAND_MENU_MAX_ROWS,
  CONTINUATION_PROMPT,
  commandMenuToken,
  createInputManager,
  filterCommandMenu,
  flushAssembly,
  historyEntryFor,
  INPUT_SIGINT,
  initialAssembly,
  reduceAssemblyLine,
  renderCommandMenu,
  toReadlineCompleter,
} from "../src/input.js";
import { createStyles, PLAIN_STYLES, ROLE_SGR } from "../src/styles.js";

const CTRL_C = "\x03";
const CTRL_D = "\x04";

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
