import * as readline from "node:readline";
import { PLAIN_STYLES, type Styles } from "./styles.js";

/**
 * The input-editor core: one long-lived `readline` interface owning stdin
 * for the whole life of the interactive REPL, instead of the previous
 * per-prompt throwaway interfaces in `interactive.ts`.
 *
 * A single interface is what makes ↑-history, multiline continuation, and
 * paste coalescing possible at all — each of those needs state (readline's
 * own history buffer, a partially-typed multiline block, a run of lines that
 * arrived together) to survive across individual `line` events, which a
 * fresh interface per prompt cannot offer.
 *
 * This module is split into a pure line-assembly reducer (fully
 * unit-testable, no I/O) and a thin `InputManager` shell that drives one
 * `readline.Interface` with that reducer. The wiring task (a separate step)
 * adapts `InputManager` to `interactive.ts`'s `LineSource` shape.
 */

// --- Pure line assembly ------------------------------------------------------

/** Continuation lines collected so far, for a multiline block in progress. */
export interface AssemblyState {
  readonly pending: readonly string[];
}

export type AssemblyAction =
  | { readonly type: "continue"; readonly state: AssemblyState }
  | { readonly type: "message"; readonly text: string };

export function initialAssembly(): AssemblyState {
  return { pending: [] };
}

/** Shown in place of the normal prompt while a multiline block is open. */
export const CONTINUATION_PROMPT = "... ";

/**
 * Feeds one raw line into the assembly state machine.
 *
 * - A line ending in exactly one `\` (not `\\`) means "more is coming":
 *   the trailing backslash is stripped and assembly continues.
 * - A line ending in `\\` is a literal backslash at end-of-line: one `\` is
 *   stripped, the line is otherwise complete.
 * - An empty line while a block is pending terminates the block (blank line
 *   ends a multiline paste/continuation) *without* contributing itself to
 *   the message.
 */
export function reduceAssemblyLine(
  state: AssemblyState,
  line: string,
): AssemblyAction {
  if (line === "" && state.pending.length > 0) {
    return { type: "message", text: state.pending.join("\n") };
  }

  const endsInBackslash = line.endsWith("\\");
  const endsInEscapedBackslash = line.endsWith("\\\\");

  if (endsInBackslash && !endsInEscapedBackslash) {
    const stripped = line.slice(0, -1);
    return {
      type: "continue",
      state: { pending: [...state.pending, stripped] },
    };
  }

  const finalLine = endsInEscapedBackslash ? line.slice(0, -1) : line;
  const lines = [...state.pending, finalLine];
  return { type: "message", text: lines.join("\n") };
}

/**
 * What to do with whatever was pending when input is abandoned (Ctrl-C or
 * close) mid-block: returns the joined text so the *caller* decides whether
 * to discard it or surface it, or `undefined` when nothing was pending.
 */
export function flushAssembly(state: AssemblyState): string | undefined {
  return state.pending.length === 0 ? undefined : state.pending.join("\n");
}

/** A recall-safe single-line form of a (possibly multiline) message. */
export function historyEntryFor(message: string): string {
  return message.replace(/\n/g, " ").trim();
}

// --- The live slash-command menu ---------------------------------------------

/**
 * The `/` menu, as three pure functions — which token the buffer is offering
 * (below), which commands that token still matches, and what the rows look
 * like — plus the redraw shell further down in {@link createInputManager}.
 *
 * The menu *shows*; it never *decides*. Tab still completes (readline owns
 * that, unchanged), and Enter sends exactly the characters in the buffer even
 * when only one command is left on screen. Anything else would mean the list
 * that appeared to help you type could quietly retype your line for you.
 */

/** One row: a command name with its leading `/`, and what it does. */
export interface CommandMenuEntry {
  readonly name: string;
  readonly description: string;
}

/** Rows shown before the list gives up and counts the rest. */
export const COMMAND_MENU_MAX_ROWS = 8;

/**
 * The command token the buffer is currently offering the menu, or `undefined`
 * when there is none and the menu must not be on screen.
 *
 * The rule is the whole feature in one line: the buffer's **first** token
 * starts with `/` and the cursor is inside it. So the menu opens on the `/`
 * that starts a message, narrows as the name is typed, and closes the moment
 * a space ends the token (the cursor is then past its end) — or the moment
 * the line stops starting with a slash at all. A cursor moved back into a
 * finished command's name reopens it, because the buffer is once again
 * offering a name to complete.
 *
 * The token is the *whole* first word, not the slice before the cursor: what
 * the list has to describe is the command the buffer would send, not the half
 * of it that happens to precede the caret.
 */
export function commandMenuToken(
  line: string,
  cursor: number,
): string | undefined {
  if (!line.startsWith("/")) return undefined;
  const space = line.search(/\s/);
  const end = space === -1 ? line.length : space;
  return cursor > end ? undefined : line.slice(0, end);
}

/**
 * The commands still matching `token`, in the order they were registered —
 * built-ins first, then `.agent/commands/` — so the list never reshuffles
 * itself under a typing hand. Matching is case-insensitive on a prefix,
 * exactly what {@link commandMenuToken}'s caller would eventually dispatch.
 */
export function filterCommandMenu(
  entries: readonly CommandMenuEntry[],
  token: string,
): readonly CommandMenuEntry[] {
  const prefix = token.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(prefix));
}

export interface CommandMenuRenderOptions {
  /** The terminal's width; rows are truncated to fit inside it. */
  readonly columns: number;
  readonly styles: Styles;
  /** Defaults to {@link COMMAND_MENU_MAX_ROWS}. */
  readonly maxRows?: number;
}

const MENU_INDENT = "  ";
const MENU_GAP = "  ";

/** `text` cut to `max` display cells, with `…` standing in for what was cut. */
function truncateTo(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 0) return "";
  if (max === 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The menu's rows, ready to be written one per line under the input.
 *
 * Empty when nothing matches: a list of no commands is worse than no list,
 * and the shell reads the empty array as "erase". Rows are dim (`menu`) with
 * the typed prefix lifted out in `user` — the point of the highlight is to
 * show *your* keystrokes inside each candidate, so the eye can see at a glance
 * how much of each name it has already pinned down.
 *
 * No row is marked as selected, because none is: nothing here is armed to
 * Enter, so a `❯` would be a promise the menu does not keep.
 *
 * Rows are truncated to one cell short of the terminal's width. That last
 * cell is not politeness — a row that exactly fills the width makes the
 * terminal wrap it, which would put one more physical line on screen than the
 * shell counted, and the redraw arithmetic below is all relative.
 */
export function renderCommandMenu(
  matches: readonly CommandMenuEntry[],
  token: string,
  options: CommandMenuRenderOptions,
): readonly string[] {
  if (matches.length === 0) return [];

  const maxRows = Math.max(1, options.maxRows ?? COMMAND_MENU_MAX_ROWS);
  const visible = matches.slice(0, maxRows);
  const hidden = matches.length - visible.length;
  const limit = Math.max(1, options.columns - 1);
  const width = Math.max(...visible.map((entry) => entry.name.length));
  const styles = options.styles;
  const typed = [...token].length;

  const rows = visible.map((entry) => {
    const plain = `${MENU_INDENT}${entry.name.padEnd(width)}${MENU_GAP}${entry.description}`;
    const chars = [...truncateTo(plain, limit)];
    const start = Math.min(MENU_INDENT.length, chars.length);
    const end = Math.min(start + typed, chars.length);
    const indent = chars.slice(0, start).join("");
    const prefix = chars.slice(start, end).join("");
    const rest = chars.slice(end).join("");
    return `${indent}${styles.user(prefix)}${styles.menu(rest)}`;
  });

  if (hidden > 0) {
    rows.push(
      styles.menu(truncateTo(`${MENU_INDENT}… and ${hidden} more`, limit)),
    );
  }
  return rows;
}

// --- InputManager -------------------------------------------------------------

export const INPUT_SIGINT: unique symbol = Symbol("input-sigint");

export type InputReadResult = string | undefined | typeof INPUT_SIGINT;

/** `readline`'s completer contract: the candidates, and the span they replace. */
export type CompleterResult = [string[], string];

/**
 * A Tab completer for the editor, synchronous or not.
 *
 * The async half is what `@` file mentions need: listing a workspace means
 * spawning `git ls-files` or walking directories, neither of which can be done
 * from a synchronous completer without blocking the event loop the prompt is
 * running on. `readline` supports both — it dispatches on the completer's
 * arity — so {@link toReadlineCompleter} always hands it the callback form and
 * lets a promise resolve into that callback.
 */
export type InputCompleter = (
  line: string,
) => CompleterResult | Promise<CompleterResult>;

type ReadlineCompleter = (
  line: string,
  callback: (error: null | Error, result: CompleterResult) => void,
) => void;

function isPromise(value: unknown): value is Promise<CompleterResult> {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

/**
 * Adapts an {@link InputCompleter} to the two-argument form `readline` treats
 * as asynchronous.
 *
 * A completer that throws or rejects yields "no completions" rather than an
 * error: Tab is a convenience, and a transiently unreadable workspace should
 * cost the user their completion, not their prompt — node would otherwise
 * print `Tab completion error: …` straight over the line being typed.
 */
export function toReadlineCompleter(
  completer: InputCompleter,
): ReadlineCompleter {
  return (line, callback) => {
    const empty: CompleterResult = [[], line];
    try {
      const result = completer(line);
      if (isPromise(result)) {
        result.then(
          (value) => callback(null, value),
          () => callback(null, empty),
        );
        return;
      }
      callback(null, result);
    } catch {
      callback(null, empty);
    }
  };
}

export interface InputManagerOptions {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output: NodeJS.WritableStream & {
    isTTY?: boolean;
    columns?: number;
  };
  /** Newest-first, matching `readline`'s own history convention. */
  readonly history?: readonly string[];
  /** Called once per accepted top-level message, with its recall-safe form. */
  readonly onHistoryAppend?: (entry: string) => void;
  /** Tab completion; may be async — see {@link InputCompleter}. */
  readonly completer?: InputCompleter;
  /** Ctrl-C while no read is pending — e.g. a turn is running. */
  readonly onIdleSigint?: () => void;
  /**
   * What to show in place of the prompt while a multiline block is open.
   * Defaults to the plain {@link CONTINUATION_PROMPT}; the REPL passes a
   * styled one so a continued line still reads as the user's own (see
   * `promptMarker` in `interactive.ts`).
   */
  readonly continuationPrompt?: string;
  /** How long to wait for more lines before resolving a paste as one message. */
  readonly pasteWindowMs?: number;
  /**
   * The session's slash commands, for the live menu drawn under the input
   * while a `/` name is being typed (see {@link commandMenuToken}).
   *
   * A getter, read afresh on every keystroke, for the same reason the Tab
   * completer takes one: this manager is built before the controller that
   * owns the command list exists, and that list grows a `.agent/commands/`
   * entry on every `/help`. Omitting it turns the menu off entirely.
   */
  readonly commandMenu?: () => readonly CommandMenuEntry[];
  /** The palette the menu is painted with. Plain (no escapes) by default. */
  readonly styles?: Styles;
  /** Menu rows before the `… and N more` tail. */
  readonly commandMenuRows?: number;
}

export interface InputManager {
  /** The main REPL read: multiline continuation + paste coalescing. */
  readMessage(promptText: string): Promise<InputReadResult>;
  /** One-line sub-question (e.g. a permission y/N). Not coalesced or stored. */
  question(query: string): Promise<string | typeof INPUT_SIGINT | undefined>;
  /** Pause the interface and hand raw stdin to another consumer, then restore. */
  withSuspended<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

const DEFAULT_PASTE_WINDOW_MS = 15;

type RawModeCapable = {
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
};

/** Reaches into `readline`'s private-but-stable `.history` array, if present. */
function rlHistory(rl: readline.Interface): string[] | undefined {
  const history = (rl as unknown as { history?: unknown }).history;
  return Array.isArray(history) ? (history as string[]) : undefined;
}

export function createInputManager(options: InputManagerOptions): InputManager {
  const pasteWindowMs = options.pasteWindowMs ?? DEFAULT_PASTE_WINDOW_MS;
  const continuationPrompt = options.continuationPrompt ?? CONTINUATION_PROMPT;

  const rl = readline.createInterface({
    input: options.input,
    output: options.output,
    terminal: true,
    history: options.history ? [...options.history] : [],
    historySize: 200,
    ...(options.completer
      ? { completer: toReadlineCompleter(options.completer) }
      : {}),
  });

  let closed = false;

  // readMessage state
  let readPending:
    | {
        readonly resolve: (value: InputReadResult) => void;
        assembly: AssemblyState;
        promptText: string;
        coalesceTimer: ReturnType<typeof setTimeout> | undefined;
        coalesced: string | undefined;
      }
    | undefined;

  // question state
  let questionPending:
    | {
        readonly resolve: (
          value: string | typeof INPUT_SIGINT | undefined,
        ) => void;
        /** Takes the question back off `readline` — see the SIGINT handler. */
        readonly cancel: () => void;
      }
    | undefined;

  // --- the live slash-command menu ------------------------------------------
  //
  // Drawn *below* the input line, per keystroke, with the same relative-cursor
  // moves the select prompt uses (`ESC[nA/B`, `ESC[0J`) — nothing here ever
  // addresses an absolute screen position, so a scroll (or an alt-screen) can
  // move the whole block without invalidating a single escape.
  //
  // One keystroke redraws like this: readline's own `_refreshLine` has already
  // run by the time our `keypress` listener is called (it was registered
  // first), and it clears from the top of the input block downwards — so the
  // previous menu is usually gone before we draw. `drawMenu` re-clears anyway,
  // because the keys that move only the cursor never trigger that refresh.
  //
  // The cursor always ends where it started: on the input line, in the column
  // readline believes it is in. readline's own bookkeeping is therefore never
  // touched, which is what keeps ↑-history, wrapping and Tab intact.
  //
  // Nothing else is ever drawn in this block, and the reason is worth writing
  // down. The input band's *lower* rule would have to live exactly here — and
  // a rule that is on screen for every keystroke of every message reaches a
  // case the menu never does. `readline` and the terminal disagree about where
  // the caret is whenever the text typed so far ends exactly on a row
  // boundary: readline reports "row k, column 0" while the terminal is still
  // on row k-1 holding a deferred wrap. Every move here is relative to the
  // caret, so at that one column the whole block — and the line being typed
  // with it — lands a row out. A `/command` is short and never reaches a
  // boundary, so the menu never meets this; an ordinary message crosses one
  // every terminal-width characters. The band therefore has a top rule (drawn
  // by the REPL above the prompt, see `interactive.ts`) and no bottom one,
  // which is a missing line rather than a corrupted input area.

  const CSI = "[";
  const menuEntries = options.commandMenu;
  const menuStyles = options.styles ?? PLAIN_STYLES;
  const menuMaxRows = options.commandMenuRows ?? COMMAND_MENU_MAX_ROWS;
  /**
   * Both ends must be a terminal: a piped stdin has no keystrokes to react to
   * and a redirected stdout must never receive a cursor escape. A run without
   * a menu writes exactly the bytes it wrote before this existed.
   */
  const menuEnabled =
    menuEntries !== undefined &&
    options.input.isTTY === true &&
    options.output.isTTY === true;
  /** Physical rows the menu currently occupies below the input block. */
  let menuRows = 0;
  /** True while another consumer owns the terminal (see `withSuspended`). */
  let menuSuspended = false;

  const write = (text: string): void => {
    options.output.write(text);
  };

  const columns = (): number => {
    const value = options.output.columns;
    return typeof value === "number" && value > 0 ? value : 80;
  };

  /** Where readline believes the cursor is, relative to the prompt's start. */
  const cursorPos = (): { readonly rows: number; readonly cols: number } => {
    const get = (
      rl as unknown as {
        getCursorPos?: () => { rows: number; cols: number };
      }
    ).getCursorPos;
    if (typeof get !== "function") return { rows: 0, cols: 0 };
    try {
      return get.call(rl);
    } catch {
      return { rows: 0, cols: 0 };
    }
  };

  /**
   * How many rows of the input block sit *below* the cursor's own row — the
   * tail of a wrapped line the user has arrowed back into. The menu goes under
   * the whole block, not under the caret.
   */
  const rowsBelowCursor = (cols: number): number => {
    const tail = [...rl.line.slice(rl.cursor)].length;
    return Math.floor((cols + tail) / columns());
  };

  /** Climb `down` rows back to the caret's column. */
  const backToCursor = (down: number, cols: number): string =>
    `${down > 0 ? `${CSI}${down}A` : ""}\r${cols > 0 ? `${CSI}${cols}C` : ""}`;

  /** Erase the menu with the caret still sitting in the input line. */
  const hideMenu = (): void => {
    if (menuRows === 0) return;
    menuRows = 0;
    const { cols } = cursorPos();
    // `ESC[nB` rather than newlines: the rows are known to exist (a menu is on
    // them), so moving down cannot scroll, and nothing below is ever created.
    const down = rowsBelowCursor(cols) + 1;
    write(`${CSI}${down}B\r${CSI}0J${backToCursor(down, cols)}`);
  };

  /**
   * Erase it from where readline's own `\r\n` has already left the caret: the
   * menu's first row. This is the Enter path — by the time the `line` event
   * fires, the caret has left the input line, so {@link hideMenu}'s arithmetic
   * no longer applies and a plain clear-to-end-of-screen is both correct and
   * cheaper.
   */
  const dropMenu = (): void => {
    if (menuRows === 0) return;
    menuRows = 0;
    write(`\r${CSI}0J`);
  };

  const drawMenu = (lines: readonly string[]): void => {
    const { cols } = cursorPos();
    const below = rowsBelowCursor(cols);
    // `\r\n` (not `ESC[B`) for the step onto the first menu row: that row may
    // not exist yet, and a newline is the one thing that makes the terminal
    // scroll one into being.
    const down = below + lines.length;
    write(
      `${below > 0 ? `${CSI}${below}B` : ""}\r\n${CSI}0J${lines.join("\r\n")}${backToCursor(down, cols)}`,
    );
    menuRows = lines.length;
  };

  /** Recompute the menu from the buffer and put the screen in that state. */
  const renderMenu = (): void => {
    if (!menuEnabled || menuSuspended) return;
    // Only ever under a message being composed: a `question()` answer and an
    // idle prompt-less terminal are not places to offer commands.
    if (readPending === undefined) {
      hideMenu();
      return;
    }
    const token = commandMenuToken(rl.line, rl.cursor);
    if (token === undefined) {
      hideMenu();
      return;
    }
    const matches = filterCommandMenu(menuEntries?.() ?? [], token);
    const lines = renderCommandMenu(matches, token, {
      columns: columns(),
      styles: menuStyles,
      maxRows: menuMaxRows,
    });
    if (lines.length === 0) {
      hideMenu();
      return;
    }
    drawMenu(lines);
  };

  /**
   * Throws away the line being typed, the way Ctrl-C is universally understood
   * to, and ends the row it was on.
   *
   * `readline` does not do this for us. Its Ctrl-C branch emits `SIGINT` and
   * returns without touching the buffer, on the theory that whoever listens
   * for the signal will decide what happens to the line — so a REPL that
   * catches `SIGINT` and simply prompts again gets the *old* buffer back, with
   * the cursor reset to 0 by `prompt()`. Typing `/exit` after a Ctrl-C on
   * `/res` then dispatched `/exit/res`, which is not a command anyone typed.
   *
   * `Interface.clearLine` is what readline itself uses to abandon a line (it
   * is how a cancelled `question()` gets cleaned up), and it moves the caret
   * past the end of a wrapped line, writes the `\r\n` that closes the row, and
   * resets the three pieces of state a redraw would otherwise climb back
   * through — buffer, cursor, and the row count `prevRows`. Doing any of that
   * by hand and leaving the rest is how the *next* prompt ends up erasing the
   * abandoned line the user is entitled to still see. It is private-but-stable
   * in the same way `.history` above is; a runtime without it still gets the
   * buffer cleared, which is the half that corrupts commands.
   */
  const abandonLine = (): void => {
    const clear = (rl as unknown as { clearLine?: () => void }).clearLine;
    if (typeof clear === "function") {
      clear.call(rl);
      return;
    }
    const state = rl as unknown as { line?: string; cursor?: number };
    if (typeof state.line !== "string") return;
    state.line = "";
    state.cursor = 0;
  };

  const onKeypress = (): void => {
    renderMenu();
  };
  /**
   * A resize invalidates every row already on screen (the terminal reflows
   * them itself, by rules that differ between emulators). Re-rendering is the
   * defensive move: `drawMenu` clears from the input line down before it
   * writes, so whatever the reflow left behind goes with it.
   */
  const onResize = (): void => {
    renderMenu();
  };

  if (menuEnabled) {
    // `readline` already turned this stream into a keypress emitter; our
    // listener is simply the second one, so it sees the buffer *after*
    // readline has applied the key.
    options.input.on("keypress", onKeypress);
    options.output.on("resize", onResize);
  }

  function clearCoalesceTimer(): void {
    if (readPending?.coalesceTimer !== undefined) {
      clearTimeout(readPending.coalesceTimer);
      readPending.coalesceTimer = undefined;
    }
  }

  /** Replace whatever partial lines readline auto-recorded with one entry. */
  function fixupHistoryFor(message: string): void {
    const entry = historyEntryFor(message);
    if (entry === "") return;
    options.onHistoryAppend?.(entry);

    const history = rlHistory(rl);
    if (history === undefined) return;

    // Drop the partial/continuation lines this block's `line` events pushed
    // onto readline's own history (one per line typed), then record the
    // single recall-safe form instead.
    const linesTyped = message.split("\n").length;
    history.splice(0, Math.min(linesTyped, history.length));
    if (history[0] !== entry) {
      history.unshift(entry);
    }
  }

  function resolveRead(value: InputReadResult): void {
    if (readPending === undefined) return;
    clearCoalesceTimer();
    const { resolve } = readPending;
    readPending = undefined;
    resolve(value);
  }

  function scheduleCoalesceFlush(): void {
    if (readPending === undefined) return;
    clearCoalesceTimer();
    readPending.coalesceTimer = setTimeout(() => {
      if (readPending === undefined) return;
      const message = readPending.coalesced ?? "";
      readPending.assembly = initialAssembly();
      fixupHistoryFor(message);
      resolveRead(message);
    }, pasteWindowMs);
  }

  rl.on("line", (line: string) => {
    // readline has already written the `\r\n` that ends the echoed line, so
    // the caret is standing on the menu's first row: wipe it there, before
    // anything the REPL prints next lands on top of a stale list.
    dropMenu();
    if (questionPending !== undefined) {
      // readline routes lines to the question callback while a question is
      // pending, not to this listener — nothing to do here in that case.
      return;
    }
    if (readPending === undefined) return;

    const action = reduceAssemblyLine(readPending.assembly, line);
    if (action.type === "continue") {
      readPending.assembly = action.state;
      rl.setPrompt(continuationPrompt);
      rl.prompt();
      return;
    }

    // A complete message landed. Rather than resolve immediately, fold it
    // into whatever's already been coalesced this read and (re)start the
    // paste window: another `line` arriving before it fires means more of
    // the same pasted block, joined with "\n".
    readPending.assembly = initialAssembly();
    readPending.coalesced =
      readPending.coalesced === undefined
        ? action.text
        : `${readPending.coalesced}\n${action.text}`;
    scheduleCoalesceFlush();
  });

  rl.on("SIGINT", () => {
    // Ctrl-C leaves the caret exactly where it was — readline neither echoes
    // nor refreshes — so the ordinary erase applies, and it has to happen
    // here: this handler runs *before* the keypress listener, and by the time
    // that one fires the read it would have rendered for is already resolved.
    hideMenu();
    if (questionPending !== undefined) {
      const { resolve, cancel } = questionPending;
      questionPending = undefined;
      // Cancelling is what takes readline's question callback back *off* the
      // interface — without it the callback outlives the question, and the
      // next line the user types is swallowed by a handler nobody is waiting
      // on. It clears the abandoned answer on its way out, which is the same
      // thing `abandonLine` does for a message.
      cancel();
      resolve(INPUT_SIGINT);
      return;
    }
    if (readPending !== undefined) {
      abandonLine();
      readPending.assembly = initialAssembly();
      resolveRead(INPUT_SIGINT);
      return;
    }
    // Nothing was being typed (a turn is running, and this Ctrl-C is meant for
    // it): no buffer to throw away, and no row to end — a newline here would
    // be a blank line in the middle of the assistant's output.
    options.onIdleSigint?.();
  });

  rl.on("close", () => {
    closed = true;
    hideMenu();
    if (menuEnabled) {
      options.input.removeListener("keypress", onKeypress);
      options.output.removeListener("resize", onResize);
    }
    if (questionPending !== undefined) {
      const { resolve } = questionPending;
      questionPending = undefined;
      resolve(undefined);
    }
    resolveRead(undefined);
  });

  return {
    readMessage(promptText: string): Promise<InputReadResult> {
      if (closed) return Promise.resolve(undefined);
      if (readPending !== undefined || questionPending !== undefined) {
        throw new Error(
          "InputManager.readMessage: a read is already in progress",
        );
      }
      return new Promise<InputReadResult>((resolve) => {
        readPending = {
          resolve,
          assembly: initialAssembly(),
          promptText,
          coalesceTimer: undefined,
          coalesced: undefined,
        };
        rl.setPrompt(promptText);
        rl.prompt();
        // A fresh prompt starts on an empty buffer, but `/help` may have just
        // grown the command list: render so the state on screen is this
        // read's, not the last one's.
        renderMenu();
      });
    },

    question(query: string): Promise<string | typeof INPUT_SIGINT | undefined> {
      if (closed) return Promise.resolve(undefined);
      if (readPending !== undefined || questionPending !== undefined) {
        throw new Error("InputManager.question: a read is already in progress");
      }
      return new Promise<string | typeof INPUT_SIGINT | undefined>(
        (resolve) => {
          // `readline` cancels a question through an `AbortSignal` and no
          // other way: there is no "never mind" method to call.
          const aborter = new AbortController();
          questionPending = { resolve, cancel: () => aborter.abort() };
          rl.question(query, { signal: aborter.signal }, (answer) => {
            if (questionPending === undefined) return;
            questionPending = undefined;

            // readline records question answers into its own history;
            // scrub the answer back out so it never pollutes ↑-recall.
            const history = rlHistory(rl);
            if (history !== undefined && history[0] === answer) {
              history.shift();
            }

            resolve(answer);
          });
        },
      );
    },

    async withSuspended<T>(fn: () => Promise<T>): Promise<T> {
      const input = options.input as unknown as RawModeCapable;
      const wasRaw = input.isRaw === true;
      // The terminal is about to belong to someone else (a select prompt, a
      // browser login): take the menu off the screen first, and stay quiet
      // even though our keypress listener still hears their keystrokes.
      hideMenu();
      menuSuspended = true;
      rl.pause();
      input.setRawMode?.(false);
      try {
        return await fn();
      } finally {
        const isTty = (options.input as unknown as { isTTY?: boolean }).isTTY;
        input.setRawMode?.(wasRaw || isTty === true);
        rl.resume();
        menuSuspended = false;
        if (readPending !== undefined) {
          rl.setPrompt(readPending.promptText);
          rl.prompt();
          // The prompt was just redrawn wherever the other consumer left the
          // screen; the menu belongs under it again.
          renderMenu();
        }
      }
    },

    close(): void {
      if (closed) return;
      rl.close();
    },
  };
}
