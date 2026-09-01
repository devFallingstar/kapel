import * as readline from "node:readline";
import { ansi, ROLE_SGR } from "./styles.js";

/**
 * A dependency-free arrow-key list picker, split into a pure reducer and a
 * thin TTY shell.
 *
 * The split is what makes it testable: every key semantic lives in
 * {@link reduceSelectKey}, every string in {@link renderSelect}, and
 * {@link runSelectPrompt} only wires raw-mode keypresses to the two of them.
 * It deliberately uses nothing but `node:readline` + raw mode, so it behaves
 * the same in Windows `cmd` as in a POSIX terminal.
 */

export interface SelectChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface SelectState {
  readonly choices: readonly SelectChoice[];
  readonly cursor: number;
  readonly selected: readonly string[];
  readonly multi: boolean;
  /**
   * Multi-select only: whether enter with nothing ticked is refused rather
   * than submitting an empty answer. Off by default — a filter list may
   * legitimately match nothing — and turned on by questions that have no
   * "none" answer, such as the wizard's backend step.
   */
  readonly required: boolean;
}

/** The subset of node's `readline` keypress event this reducer reads. */
export interface KeypressLike {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
}

export type SelectAction =
  | { readonly type: "state"; readonly state: SelectState }
  | { readonly type: "submit"; readonly values: readonly string[] }
  | { readonly type: "cancel" }
  | { readonly type: "noop" };

const NOOP: SelectAction = { type: "noop" };
const CANCEL: SelectAction = { type: "cancel" };

/** The footer shown under the list unless the caller supplies its own. */
export const DEFAULT_SELECT_FOOTER =
  "↑↓ move · space select · enter confirm · esc cancel";

function asArray(initial: string | readonly string[] | undefined): string[] {
  if (initial === undefined) return [];
  return typeof initial === "string" ? [initial] : initial.slice();
}

/**
 * Builds the starting state.
 *
 * Initial values that are not in `choices` are dropped rather than trusted:
 * they usually come from a stored config written by an older version, and a
 * selection the list cannot show is worse than no selection at all. In
 * single-select mode only the first surviving value is kept.
 */
export function initialSelectState(
  choices: readonly SelectChoice[],
  options?: {
    readonly initial?: string | readonly string[];
    readonly multi?: boolean;
    readonly required?: boolean;
  },
): SelectState {
  const multi = options?.multi ?? false;
  const known = new Set(choices.map((choice) => choice.value));
  const wanted = asArray(options?.initial).filter((value) => known.has(value));
  const selected = multi ? wanted : wanted.slice(0, 1);
  const first = selected[0];
  const cursorFrom =
    first === undefined
      ? -1
      : choices.findIndex((choice) => choice.value === first);
  return {
    choices,
    cursor: cursorFrom === -1 ? 0 : cursorFrom,
    selected,
    multi,
    required: options?.required ?? false,
  };
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function moveTo(state: SelectState, cursor: number): SelectAction {
  // A move that does not move keeps the very same object, so a shell can use
  // reference equality to decide whether a redraw is needed.
  if (cursor === state.cursor) return { type: "state", state };
  // Single-select only, and only once something is already selected (an
  // `initial` value, typically): keep the selection in lockstep with the
  // cursor. Without this, the highlighted row (❯) and the ticked row (◉)
  // drift apart the moment the arrow keys move away from the pre-selected
  // item, and submit() below hands back the *old* selection until a `space`
  // press resyncs it — from the user's seat, arrow keys do nothing until
  // they press space once. Before anything is selected there is nothing to
  // keep in sync; submit() already falls back to the highlighted item then.
  if (!state.multi && state.selected.length > 0) {
    const next = state.choices[cursor];
    const selected = next === undefined ? state.selected : [next.value];
    return { type: "state", state: { ...state, cursor, selected } };
  }
  return { type: "state", state: { ...state, cursor } };
}

function toggle(state: SelectState): SelectAction {
  const current = state.choices[state.cursor];
  if (current === undefined) return NOOP;

  if (!state.multi) {
    // Radio behaviour: space *replaces* the selection. Toggling the item that
    // is already selected leaves it selected — a single-select prompt should
    // never be talked into having no answer.
    if (state.selected.length === 1 && state.selected[0] === current.value) {
      return { type: "state", state };
    }
    return { type: "state", state: { ...state, selected: [current.value] } };
  }

  const selected = state.selected.includes(current.value)
    ? state.selected.filter((value) => value !== current.value)
    : [...state.selected, current.value];
  return { type: "state", state: { ...state, selected } };
}

function submit(state: SelectState): SelectAction {
  if (state.multi) {
    // A required multi-select simply does not answer to enter until something
    // is ticked. Taking the highlighted item instead would put an answer
    // nobody chose into a config file.
    if (state.required && state.selected.length === 0) return NOOP;
    return { type: "submit", values: state.selected };
  }
  if (state.selected.length > 0) {
    return { type: "submit", values: state.selected };
  }
  // Single-select with nothing chosen yet: enter takes the highlighted item,
  // which is what someone who only pressed the arrow keys expects.
  const current = state.choices[state.cursor];
  return {
    type: "submit",
    values: current === undefined ? [] : [current.value],
  };
}

function digitOf(key: KeypressLike): number | undefined {
  const raw = key.name ?? key.sequence;
  if (raw === undefined || !/^[1-9]$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * The whole key vocabulary of the prompt, as a pure function.
 *
 * | key                    | action                                    |
 * | ---------------------- | ----------------------------------------- |
 * | up, k                  | cursor − 1, wrapping to the last item     |
 * | down, j                | cursor + 1, wrapping to the first item    |
 * | home / end             | jump to the first / last item             |
 * | 1–9                    | jump to that item when it exists          |
 * | space                  | toggle (single-select: replace)           |
 * | return / enter         | submit                                    |
 * | escape, ctrl+c, ctrl+d | cancel                                    |
 * | anything else          | noop                                      |
 */
export function reduceSelectKey(
  state: SelectState,
  key: KeypressLike,
): SelectAction {
  const name = key.name;
  const length = state.choices.length;

  if (key.ctrl === true) {
    return name === "c" || name === "d" ? CANCEL : NOOP;
  }
  if (name === "escape") return CANCEL;
  if (name === "return" || name === "enter") return submit(state);
  if (name === "space" || key.sequence === " ") return toggle(state);

  if (length === 0) return NOOP;

  if (name === "up" || name === "k") {
    return moveTo(state, wrap(state.cursor - 1, length));
  }
  if (name === "down" || name === "j") {
    return moveTo(state, wrap(state.cursor + 1, length));
  }
  if (name === "home") return moveTo(state, 0);
  if (name === "end") return moveTo(state, length - 1);

  const digit = digitOf(key);
  if (digit !== undefined && digit <= length) return moveTo(state, digit - 1);

  return NOOP;
}

// --- Rendering --------------------------------------------------------------

function glyph(state: SelectState, selected: boolean): string {
  if (state.multi) return selected ? "☑" : "☐";
  return selected ? "◉" : "◯";
}

/** The prompt as lines: title, one line per choice, footer. */
export function renderSelect(
  state: SelectState,
  options: {
    readonly title: string;
    readonly color: boolean;
    readonly footer?: string;
  },
): readonly string[] {
  const color = options.color;
  const lines: string[] = [ansi(ROLE_SGR.heading, options.title, color)];

  state.choices.forEach((choice, index) => {
    // The caret wears the accent every other piece of chrome does — the box,
    // the rule over the prompt, the bar beside a notice — so "where am I" is
    // the same colour wherever the shell asks it.
    const marker =
      index === state.cursor ? `${ansi(ROLE_SGR.accent, "❯", color)} ` : "  ";
    const box = glyph(state, state.selected.includes(choice.value));
    const label =
      index === state.cursor
        ? ansi(ROLE_SGR.heading, choice.label, color)
        : choice.label;
    const hint =
      choice.hint === undefined
        ? ""
        : ` ${ansi(ROLE_SGR.tool, `(${choice.hint})`, color)}`;
    lines.push(`${marker}${box} ${label}${hint}`);
  });

  lines.push(
    ansi(ROLE_SGR.tool, options.footer ?? DEFAULT_SELECT_FOOTER, color),
  );
  return lines;
}

/** `label` for a value, falling back to the raw value for unknown ones. */
function labelFor(choices: readonly SelectChoice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

/** The one line left behind once the prompt is answered. */
export function summarizeSelection(
  choices: readonly SelectChoice[],
  values: readonly string[] | undefined,
  options: { readonly title: string; readonly color: boolean },
): string {
  const answer =
    values === undefined
      ? "cancelled"
      : values.length === 0
        ? "(none)"
        : values.map((value) => labelFor(choices, value)).join(", ");
  return `${ansi(ROLE_SGR.heading, options.title, options.color)} ${ansi(ROLE_SGR.tool, "›", options.color)} ${answer}`;
}

// --- The TTY shell ----------------------------------------------------------

export interface SelectPromptIo {
  readonly input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (v: boolean) => void;
  };
  readonly output: NodeJS.WritableStream & {
    isTTY?: boolean;
    columns?: number;
  };
}

export interface SelectPromptOptions {
  readonly title: string;
  readonly choices: readonly SelectChoice[];
  readonly multi?: boolean;
  /** See {@link SelectState.required}. Multi-select only. */
  readonly required?: boolean;
  readonly initial?: string | readonly string[];
  readonly footer?: string;
  /**
   * Whether the answered prompt leaves its one-line summary behind (see
   * {@link summarizeSelection}). `false` erases the question entirely once it
   * is answered — for flows that clean their whole output up afterwards, like
   * the REPL's `/config`, where every line left on screen is one it would
   * have to count and erase again. Defaults to `true`.
   */
  readonly summarize?: boolean;
}

/**
 * Shows the picker and resolves with the chosen values, or `undefined` when
 * the user cancels.
 *
 * Non-TTY input resolves immediately with the initial selection (or the first
 * choice) **without reading a byte**: the wizard is a TTY-only experience and
 * the caller is expected to guard on `process.stdin.isTTY`; resolving rather
 * than throwing keeps a piped `kapel` from deadlocking on a prompt nobody can
 * see.
 */
export function runSelectPrompt(
  io: SelectPromptIo,
  options: SelectPromptOptions,
): Promise<readonly string[] | undefined> {
  const stateOptions = {
    ...(options.initial === undefined ? {} : { initial: options.initial }),
    ...(options.multi === undefined ? {} : { multi: options.multi }),
    ...(options.required === undefined ? {} : { required: options.required }),
  };
  let state = initialSelectState(options.choices, stateOptions);

  if (io.input.isTTY !== true) {
    if (state.selected.length > 0) return Promise.resolve(state.selected);
    const first = options.choices[0];
    return Promise.resolve(first === undefined ? [] : [first.value]);
  }

  const color = io.output.isTTY === true;
  const renderOptions = {
    title: options.title,
    color,
    ...(options.footer === undefined ? {} : { footer: options.footer }),
  };

  return new Promise<readonly string[] | undefined>((resolve) => {
    let drawn = 0;

    const erase = (): void => {
      if (drawn > 0) io.output.write(`[${drawn}A\r[0J`);
      drawn = 0;
    };

    const draw = (): void => {
      const lines = renderSelect(state, renderOptions);
      erase();
      io.output.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };

    const onKeypress = (
      _chunk: string | undefined,
      key: KeypressLike | undefined,
    ): void => {
      const action = reduceSelectKey(state, key ?? {});
      if (action.type === "noop") return;
      if (action.type === "state") {
        if (action.state === state) return;
        state = action.state;
        draw();
        return;
      }
      finish(action.type === "submit" ? action.values : undefined);
    };

    let settled = false;
    const finish = (values: readonly string[] | undefined): void => {
      if (settled) return;
      settled = true;
      io.input.removeListener("keypress", onKeypress);
      // Raw mode belongs to the prompt, not to the process: hand the terminal
      // back exactly as it was found, or every later readline breaks.
      io.input.setRawMode?.(false);
      erase();
      if (options.summarize !== false) {
        io.output.write(
          `${summarizeSelection(options.choices, values, { title: options.title, color })}\n`,
        );
      }
      resolve(values);
    };

    readline.emitKeypressEvents(io.input);
    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("keypress", onKeypress);
    draw();
  });
}

// --- Free-text answers ------------------------------------------------------

export interface TextPromptOptions {
  readonly title: string;
  /** Pre-filled answer, shown after the prompt and returned when enter is hit. */
  readonly initial?: string;
  /** One line under the title. Defaults to naming the escape hatches. */
  readonly footer?: string;
}

const DEFAULT_TEXT_FOOTER =
  "enter confirm · clear the line to leave it unchanged";

/**
 * A one-line free-text question, for the answers a list cannot hold: a rule's
 * id, a comma-separated list of task types, a number outside the offered few.
 *
 * `undefined` means cancelled — an empty answer, a `^C`, or a closed stream —
 * which every caller here treats as "leave this field alone". A non-TTY input
 * resolves with the initial value without reading a byte, for the same reason
 * {@link runSelectPrompt} does: a piped `kapel` must never block on a
 * question nobody can see.
 */
export function runTextPrompt(
  io: SelectPromptIo,
  options: TextPromptOptions,
): Promise<string | undefined> {
  const initial = options.initial ?? "";
  if (io.input.isTTY !== true) {
    return Promise.resolve(initial === "" ? undefined : initial);
  }

  const color = io.output.isTTY === true;

  // `heading`, the same role the picker paints its own title in — the two
  // questions sit in one flow and must not look like different programs.
  io.output.write(`${ansi(ROLE_SGR.heading, options.title, color)}\n`);
  io.output.write(
    `${ansi(ROLE_SGR.tool, options.footer ?? DEFAULT_TEXT_FOOTER, color)}\n`,
  );

  const rl = readline.createInterface({
    input: io.input,
    output: io.output,
    terminal: true,
  });

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value === undefined || value.trim() === "" ? undefined : value);
    };

    rl.on("SIGINT", () => finish(undefined));
    rl.question("> ", (answer) => finish(answer));
    // Pre-filling rather than showing a placeholder: the answer being edited
    // is almost always a small change to the one already there, and retyping
    // a rule id to alter one word of it is the kind of friction that sends
    // people back to the text editor this screen exists to replace.
    if (initial !== "") rl.write(initial);
  });
}
