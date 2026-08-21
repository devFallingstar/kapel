import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  KeypressLike,
  SelectChoice,
  SelectPromptIo,
  SelectState,
} from "../src/select-prompt.js";
import {
  DEFAULT_SELECT_FOOTER,
  initialSelectState,
  reduceSelectKey,
  renderSelect,
  runSelectPrompt,
} from "../src/select-prompt.js";
import { ROLE_SGR } from "../src/styles.js";

// --- fixtures ---------------------------------------------------------------

const CHOICES: readonly SelectChoice[] = [
  { value: "a", label: "Alpha", hint: "first" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

function state(
  overrides: Partial<SelectState> = {},
  options?: {
    readonly initial?: string;
    readonly multi?: boolean;
    readonly required?: boolean;
  },
): SelectState {
  return { ...initialSelectState(CHOICES, options), ...overrides };
}

function key(name: string, extra: Partial<KeypressLike> = {}): KeypressLike {
  return { name, ...extra };
}

/** A duplex stream that claims to be a terminal and records raw-mode flips. */
class FakeTtyInput extends PassThrough {
  isTTY = true;
  readonly rawModes: boolean[] = [];

  setRawMode(value: boolean): this {
    this.rawModes.push(value);
    return this;
  }
}

class FakeOutput {
  isTTY = false;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

function makeIo(input: PassThrough & { isTTY?: boolean }): {
  io: SelectPromptIo;
  output: FakeOutput;
} {
  const output = new FakeOutput();
  return {
    io: {
      input: input as unknown as SelectPromptIo["input"],
      output: output as unknown as SelectPromptIo["output"],
    },
    output,
  };
}

// --- initialSelectState -----------------------------------------------------

describe("initialSelectState", () => {
  it("starts on the first choice with nothing selected", () => {
    const initial = initialSelectState(CHOICES);
    expect(initial.cursor).toBe(0);
    expect(initial.selected).toEqual([]);
    expect(initial.multi).toBe(false);
  });

  it("selects the initial value and parks the cursor on it", () => {
    const initial = initialSelectState(CHOICES, { initial: "c" });
    expect(initial.selected).toEqual(["c"]);
    expect(initial.cursor).toBe(2);
  });

  it("drops initial values the list does not offer", () => {
    const initial = initialSelectState(CHOICES, { initial: "nope" });
    expect(initial.selected).toEqual([]);
    expect(initial.cursor).toBe(0);
  });

  it("keeps every initial value in multi mode", () => {
    const initial = initialSelectState(CHOICES, {
      initial: ["a", "c"],
      multi: true,
    });
    expect(initial.selected).toEqual(["a", "c"]);
    expect(initial.cursor).toBe(0);
  });

  it("keeps only the first initial value in single mode", () => {
    const initial = initialSelectState(CHOICES, { initial: ["b", "c"] });
    expect(initial.selected).toEqual(["b"]);
    expect(initial.cursor).toBe(1);
  });
});

// --- navigation -------------------------------------------------------------

describe("reduceSelectKey navigation", () => {
  it("moves up and wraps around to the last choice", () => {
    const action = reduceSelectKey(state(), key("up"));
    expect(action).toEqual({ type: "state", state: state({ cursor: 2 }) });
  });

  it("moves down and wraps around to the first choice", () => {
    const action = reduceSelectKey(state({ cursor: 2 }), key("down"));
    expect(action).toEqual({ type: "state", state: state({ cursor: 0 }) });
  });

  it("accepts k and j as up and down", () => {
    expect(reduceSelectKey(state({ cursor: 1 }), key("k"))).toEqual({
      type: "state",
      state: state({ cursor: 0 }),
    });
    expect(reduceSelectKey(state({ cursor: 1 }), key("j"))).toEqual({
      type: "state",
      state: state({ cursor: 2 }),
    });
  });

  it("jumps to the ends with home and end", () => {
    expect(reduceSelectKey(state({ cursor: 1 }), key("home"))).toEqual({
      type: "state",
      state: state({ cursor: 0 }),
    });
    expect(reduceSelectKey(state({ cursor: 0 }), key("end"))).toEqual({
      type: "state",
      state: state({ cursor: 2 }),
    });
  });

  it("jumps to a choice by its 1-based digit", () => {
    expect(reduceSelectKey(state(), key("3"))).toEqual({
      type: "state",
      state: state({ cursor: 2 }),
    });
  });

  it("reads a digit off the raw sequence when the key has no name", () => {
    expect(reduceSelectKey(state(), { sequence: "2" })).toEqual({
      type: "state",
      state: state({ cursor: 1 }),
    });
  });

  it("ignores digits past the end of the list", () => {
    expect(reduceSelectKey(state(), key("9"))).toEqual({ type: "noop" });
  });

  it("ignores navigation on an empty list", () => {
    const empty = initialSelectState([]);
    expect(reduceSelectKey(empty, key("down"))).toEqual({ type: "noop" });
    expect(reduceSelectKey(empty, key("end"))).toEqual({ type: "noop" });
  });

  it("returns the very same state object when the cursor does not move", () => {
    const single = initialSelectState([{ value: "a", label: "Alpha" }]);
    const action = reduceSelectKey(single, key("up"));
    expect(action.type).toBe("state");
    if (action.type !== "state") throw new Error("expected a state action");
    expect(action.state).toBe(single);
  });

  it("treats an unknown key as a no-op", () => {
    expect(reduceSelectKey(state(), key("f5"))).toEqual({ type: "noop" });
    expect(reduceSelectKey(state(), { sequence: "z" })).toEqual({
      type: "noop",
    });
  });

  // Regression: every real single-select question in the wizard seeds
  // `initial` with the current or suggested model, so `selected` is never
  // empty going in. Before this fix, moving the cursor away from that
  // pre-selection left `selected` pointing at the old item — the ❯ marker
  // moved, the ◉ marker did not, and enter submitted the stale answer.
  // A bare `space` press synced the two, which is exactly the "arrow keys do
  // nothing until you press space once" bug report.
  it("keeps a pre-selected value in lockstep with the cursor on the very first arrow press", () => {
    const before = state({}, { initial: "a" });
    expect(before.selected).toEqual(["a"]);
    expect(before.cursor).toBe(0);

    const action = reduceSelectKey(before, key("down"));
    expect(action).toEqual({
      type: "state",
      state: state({ cursor: 1, selected: ["b"] }, { initial: "a" }),
    });
  });

  it("submits the item the cursor lands on, not the original pre-selection", () => {
    const moved = reduceSelectKey(state({}, { initial: "a" }), key("down"));
    if (moved.type !== "state") throw new Error("expected a state action");
    expect(reduceSelectKey(moved.state, key("return"))).toEqual({
      type: "submit",
      values: ["b"],
    });
  });

  it("stays in sync over several consecutive moves, including wrap-around", () => {
    let action = reduceSelectKey(state({}, { initial: "a" }), key("down"));
    if (action.type !== "state") throw new Error("expected a state action");
    action = reduceSelectKey(action.state, key("down"));
    if (action.type !== "state") throw new Error("expected a state action");
    expect(action.state.cursor).toBe(2);
    expect(action.state.selected).toEqual(["c"]);

    action = reduceSelectKey(action.state, key("down"));
    if (action.type !== "state") throw new Error("expected a state action");
    expect(action.state.cursor).toBe(0);
    expect(action.state.selected).toEqual(["a"]);
  });

  it("multi-select is untouched: moving the cursor never edits the ticks", () => {
    const multi = initialSelectState(CHOICES, {
      multi: true,
      initial: ["a"],
    });
    const action = reduceSelectKey(multi, key("down"));
    expect(action).toEqual({
      type: "state",
      state: { ...multi, cursor: 1 },
    });
  });
});

// --- selection --------------------------------------------------------------

describe("reduceSelectKey selection", () => {
  it("space replaces the selection in single mode", () => {
    const action = reduceSelectKey(
      state({ cursor: 1 }, { initial: "a" }),
      key("space"),
    );
    expect(action).toEqual({
      type: "state",
      state: state({ cursor: 1, selected: ["b"] }, { initial: "a" }),
    });
  });

  it("space on the already-selected item leaves it selected", () => {
    const before = state({ cursor: 0 }, { initial: "a" });
    const action = reduceSelectKey(before, key("space"));
    expect(action.type).toBe("state");
    if (action.type !== "state") throw new Error("expected a state action");
    expect(action.state).toBe(before);
    expect(action.state.selected).toEqual(["a"]);
  });

  it("space toggles a value on in multi mode", () => {
    const before = initialSelectState(CHOICES, { multi: true });
    const action = reduceSelectKey({ ...before, cursor: 1 }, key("space"));
    expect(action).toEqual({
      type: "state",
      state: { ...before, cursor: 1, selected: ["b"] },
    });
  });

  it("space toggles a value back off in multi mode", () => {
    const before = initialSelectState(CHOICES, {
      multi: true,
      initial: ["a", "b"],
    });
    const action = reduceSelectKey({ ...before, cursor: 0 }, key("space"));
    expect(action).toEqual({
      type: "state",
      state: { ...before, cursor: 0, selected: ["b"] },
    });
  });

  it("recognises space from the raw sequence too", () => {
    const action = reduceSelectKey(state({ cursor: 2 }), { sequence: " " });
    expect(action).toEqual({
      type: "state",
      state: state({ cursor: 2, selected: ["c"] }),
    });
  });

  it("ignores space on an empty list", () => {
    expect(reduceSelectKey(initialSelectState([]), key("space"))).toEqual({
      type: "noop",
    });
  });
});

// --- submit and cancel ------------------------------------------------------

describe("reduceSelectKey submit and cancel", () => {
  it("submits the highlighted item when nothing is selected yet", () => {
    expect(reduceSelectKey(state({ cursor: 2 }), key("return"))).toEqual({
      type: "submit",
      values: ["c"],
    });
  });

  it("submits the selection when there is one", () => {
    expect(
      reduceSelectKey(state({ cursor: 2 }, { initial: "a" }), key("return")),
    ).toEqual({ type: "submit", values: ["a"] });
  });

  it("accepts enter as well as return", () => {
    expect(reduceSelectKey(state(), key("enter"))).toEqual({
      type: "submit",
      values: ["a"],
    });
  });

  it("submits an empty multi-select without inventing an answer", () => {
    const multi = initialSelectState(CHOICES, { multi: true });
    expect(reduceSelectKey(multi, key("return"))).toEqual({
      type: "submit",
      values: [],
    });
  });

  it("refuses to submit a required multi-select with nothing ticked", () => {
    const multi = initialSelectState(CHOICES, {
      multi: true,
      required: true,
    });
    // Not a submit of the highlighted item either: an answer nobody chose is
    // exactly what `required` exists to prevent.
    expect(reduceSelectKey(multi, key("return"))).toEqual({ type: "noop" });
  });

  it("submits a required multi-select as soon as one value is ticked", () => {
    const multi = initialSelectState(CHOICES, {
      multi: true,
      required: true,
      initial: ["b"],
    });
    expect(reduceSelectKey(multi, key("return"))).toEqual({
      type: "submit",
      values: ["b"],
    });
  });

  it("submits every checked value in multi mode", () => {
    const multi = initialSelectState(CHOICES, {
      multi: true,
      initial: ["a", "c"],
    });
    expect(reduceSelectKey(multi, key("return"))).toEqual({
      type: "submit",
      values: ["a", "c"],
    });
  });

  it("cancels on escape, ctrl+c and ctrl+d", () => {
    expect(reduceSelectKey(state(), key("escape"))).toEqual({ type: "cancel" });
    expect(reduceSelectKey(state(), key("c", { ctrl: true }))).toEqual({
      type: "cancel",
    });
    expect(reduceSelectKey(state(), key("d", { ctrl: true }))).toEqual({
      type: "cancel",
    });
  });

  it("ignores other control chords", () => {
    expect(reduceSelectKey(state(), key("a", { ctrl: true }))).toEqual({
      type: "noop",
    });
  });
});

// --- rendering --------------------------------------------------------------

describe("renderSelect", () => {
  it("renders title, choices and the default footer without colour", () => {
    const lines = renderSelect(state({ cursor: 1 }, { initial: "a" }), {
      title: "Pick one",
      color: false,
    });
    expect(lines).toEqual([
      "Pick one",
      "  ◉ Alpha (first)",
      "❯ ◯ Beta",
      "  ◯ Gamma",
      DEFAULT_SELECT_FOOTER,
    ]);
  });

  it("marks the cursor row and only the cursor row", () => {
    const lines = renderSelect(state({ cursor: 2 }), {
      title: "t",
      color: false,
    });
    expect(lines.filter((line) => line.startsWith("❯ "))).toHaveLength(1);
    expect(lines[3]).toBe("❯ ◯ Gamma");
  });

  it("uses checkbox glyphs in multi mode", () => {
    const multi = initialSelectState(CHOICES, {
      multi: true,
      initial: ["b"],
    });
    const lines = renderSelect(multi, { title: "t", color: false });
    expect(lines[1]).toBe("  ☐ Alpha (first)");
    expect(lines[2]).toBe("❯ ☑ Beta");
  });

  it("emits ANSI dim and bold only when colour is on", () => {
    const plain = renderSelect(state(), { title: "Pick", color: false });
    expect(plain.join("\n")).not.toContain("[");

    const colored = renderSelect(state(), { title: "Pick", color: true });
    expect(colored[0]).toBe("[1mPick[0m");
    // The caret is chrome, and wears the accent the rest of the shell's
    // furniture does; the row's own text keeps its bold and its dim.
    expect(colored[1]).toBe(
      `[${ROLE_SGR.accent}m❯[0m ◯ [1mAlpha[0m [2m(first)[0m`,
    );
    expect(colored[4]).toBe(`[2m${DEFAULT_SELECT_FOOTER}[0m`);
  });

  it("uses a caller-supplied footer", () => {
    const lines = renderSelect(state(), {
      title: "t",
      color: false,
      footer: "enter to go",
    });
    expect(lines[lines.length - 1]).toBe("enter to go");
  });
});

// --- the TTY shell ----------------------------------------------------------

describe("runSelectPrompt", () => {
  it("resolves the initial value without reading when stdin is not a TTY", async () => {
    const input = new PassThrough();
    const { io, output } = makeIo(input);
    const values = await runSelectPrompt(io, {
      title: "Pick",
      choices: CHOICES,
      initial: "b",
    });
    expect(values).toEqual(["b"]);
    expect(output.chunks).toEqual([]);
  });

  it("falls back to the first choice on a non-TTY with no initial", async () => {
    const input = new PassThrough();
    const { io } = makeIo(input);
    expect(
      await runSelectPrompt(io, { title: "Pick", choices: CHOICES }),
    ).toEqual(["a"]);
  });

  it("reads arrow keys, space and enter from a TTY", async () => {
    const input = new FakeTtyInput();
    const { io, output } = makeIo(input);
    const pending = runSelectPrompt(io, { title: "Pick", choices: CHOICES });
    input.write("[B \r");
    expect(await pending).toEqual(["b"]);
    expect(output.text).toContain("Pick");
    expect(output.text).toContain("Beta");
  });

  it("restores raw mode and drops its listener when it finishes", async () => {
    const input = new FakeTtyInput();
    const { io } = makeIo(input);
    const pending = runSelectPrompt(io, { title: "Pick", choices: CHOICES });
    expect(input.rawModes).toEqual([true]);
    input.write("\r");
    await pending;
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.isPaused()).toBe(false);
  });

  it("redraws in place by moving the cursor up and clearing", async () => {
    const input = new FakeTtyInput();
    const { io, output } = makeIo(input);
    const pending = runSelectPrompt(io, { title: "Pick", choices: CHOICES });
    input.write("[B");
    await new Promise((resolve) => setImmediate(resolve));
    expect(output.text).toContain("[5A");
    input.write("\r");
    await pending;
  });

  it("returns undefined and says so when the user cancels", async () => {
    const input = new FakeTtyInput();
    const { io, output } = makeIo(input);
    const pending = runSelectPrompt(io, { title: "Pick", choices: CHOICES });
    input.write("");
    expect(await pending).toBeUndefined();
    expect(output.text).toContain("cancelled");
    expect(input.rawModes).toEqual([true, false]);
  });

  it("collects several values in multi mode", async () => {
    const input = new FakeTtyInput();
    const { io } = makeIo(input);
    const pending = runSelectPrompt(io, {
      title: "Pick",
      choices: CHOICES,
      multi: true,
    });
    input.write(" [B[B \r");
    expect(await pending).toEqual(["a", "c"]);
  });

  it("summarizes the chosen labels on the line it leaves behind", async () => {
    const input = new FakeTtyInput();
    const { io, output } = makeIo(input);
    const pending = runSelectPrompt(io, {
      title: "Pick",
      choices: CHOICES,
      initial: "c",
    });
    input.write("\r");
    await pending;
    expect(output.text.trimEnd().endsWith("Pick › Gamma")).toBe(true);
  });

  // Regression coverage for the arrow-key bug (absorbed from the throwaway
  // `zzrepro-arrowbug.test.ts` repro, then deleted): a down arrow as the very
  // first keypress must move the selection, whether it arrives in one write
  // (a paste, or a fast terminal) or split across two (a real keypress).
  it("moves the cursor on a bare down arrow with no space, in one write", async () => {
    const input = new FakeTtyInput();
    const { io } = makeIo(input);
    const pending = runSelectPrompt(io, { title: "Pick", choices: CHOICES });
    input.write("\x1B[B\r");
    expect(await pending).toEqual(["b"]);
  });

  it("moves the cursor on a bare down arrow with no space, split across writes", async () => {
    const input = new FakeTtyInput();
    const { io } = makeIo(input);
    const pending = runSelectPrompt(io, { title: "Pick", choices: CHOICES });
    input.write("\x1B[B");
    await new Promise((resolve) => setImmediate(resolve));
    input.write("\r");
    expect(await pending).toEqual(["b"]);
  });

  // The bug proper: every real single-select question seeds `initial` with
  // the current or suggested model, so `selected` is never empty going in —
  // this is the shape that actually shipped, not the empty-selection case
  // above (which happened to work even before the fix).
  it("moves off a pre-selected initial value on the very first arrow press, no space needed", async () => {
    const input = new FakeTtyInput();
    const { io } = makeIo(input);
    const pending = runSelectPrompt(io, {
      title: "Pick",
      choices: CHOICES,
      initial: "a",
    });
    input.write("\x1B[B\r");
    expect(await pending).toEqual(["b"]);
  });
});
