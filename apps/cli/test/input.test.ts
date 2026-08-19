import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CompleterResult } from "../src/input.js";
import {
  CONTINUATION_PROMPT,
  createInputManager,
  flushAssembly,
  historyEntryFor,
  INPUT_SIGINT,
  initialAssembly,
  reduceAssemblyLine,
  toReadlineCompleter,
} from "../src/input.js";

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
