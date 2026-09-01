import * as readline from "node:readline";
import {
  type BandDecor,
  charWidth,
  DEFAULT_BAND_COLUMNS,
  ECHO_MARKER,
  stripEscapes,
} from "./band.js";
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
 *
 * The interface is live between prompts as well as during them, which is what
 * `captureWhileBusy` is for: the REPL is inside a turn for most of the time
 * anyone is at the keyboard, and a line typed then used to reach a `line`
 * event with nobody waiting for it and be dropped without a trace. It is now
 * caught, unechoed, and painted by whoever owns the screen during a turn —
 * see {@link gatedOutput} for why that is the arrangement rather than letting
 * `readline` draw it where it stands.
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

// --- Typing while a turn runs ------------------------------------------------

/**
 * The caret drawn into a mid-turn line, because the terminal's own one is not
 * there to do it.
 *
 * A line typed while a turn is running is not echoed by `readline` at all (see
 * {@link gatedOutput}) — it is painted, once per keystroke, as a row of the
 * status band, and the real cursor stays parked where the band's painter left
 * it. So the mark that says "your text goes in here" has to be a character
 * like any other.
 */
const PENDING_CARET = "▏";

/**
 * The mid-turn line as one row of text: the same `> ` marker a sent message
 * wears in the transcript, the buffer, and a caret where the cursor is.
 *
 * Pure, and separate from the painting, because everything worth asserting
 * about the row is here: that the caret follows the cursor through an edit in
 * the middle of the line, and that the marker matches the bar the line will
 * become when it is finally sent.
 */
export function composePendingRow(text: string, cursor: number): string {
  const at = Math.max(0, Math.min(cursor, text.length));
  return `${ECHO_MARKER}${text.slice(0, at)}${PENDING_CARET}${text.slice(at)}`;
}

/**
 * A view of `output` whose `write` can be switched off, for handing to
 * `readline` instead of the real stream.
 *
 * This is how a line typed mid-turn stays out of the way of everything else on
 * screen. `readline` echoes every keystroke straight to its output, at
 * whatever row the cursor happens to be on — and mid-turn that row belongs to
 * the status band, which is being repainted several times a second by an
 * entirely different painter. The two cannot share it, and the fix that keeps
 * one painter in charge is to take `readline`'s pen away: it still receives
 * the keys, still maintains the buffer, the cursor and the history, and simply
 * draws nothing while the band is up. The band draws the buffer instead.
 *
 * Muting is safe precisely because it is total. `readline`'s redraws are
 * relative moves computed from its own model of where it last drew; letting
 * half of them through would leave that model describing a screen that never
 * happened. Muted, every one of them is discarded together, and the model is
 * reconciled on the way out (see `resetLineModel`).
 *
 * Only `write` is intercepted. Every other property — `columns`, `rows`,
 * `isTTY`, the `resize` listener `readline` attaches — is read from and
 * applied to the real stream, so nothing about the terminal is faked; methods
 * are bound to it rather than called through this view, so no code ever runs
 * with a `this` that isn't the stream it was written for.
 */
export function gatedOutput<T extends object>(
  output: T,
  muted: () => boolean,
): T {
  return new Proxy(output, {
    get(target, property) {
      if (property === "write") {
        return (...args: unknown[]): boolean => {
          if (!muted()) {
            return (
              target as unknown as { write: (...a: unknown[]) => boolean }
            ).write(...args);
          }
          // The callback is part of the contract even for a write that never
          // happens: a caller waiting on it would otherwise wait forever.
          const callback = args.find((arg) => typeof arg === "function");
          if (typeof callback === "function") callback();
          return true;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

// --- Ctrl+R reverse-i-search --------------------------------------------------

/**
 * The state of an in-progress reverse-history search: the query typed since
 * Ctrl+R was pressed, and how many times Ctrl+R has been pressed again since
 * the query last changed.
 *
 * `offset` rather than "the match itself" is what this holds on to, on
 * purpose — the match list is never stored; it is recomputed from
 * `readline`'s history and this query every time it is needed (by
 * {@link reverseSearchMatches}), in exactly the spirit of the slash menu
 * above never storing its own filtered list either. An offset is a stable
 * pointer into a list that can be rebuilt at will; a match string copied out
 * of last keystroke's list would not be.
 */
export interface ReverseSearchState {
  readonly query: string;
  readonly offset: number;
}

/** The state Ctrl+R opens into: no query yet, pointing at the newest match. */
export function initialReverseSearch(): ReverseSearchState {
  return { query: "", offset: 0 };
}

export type ReverseSearchAction =
  | { readonly type: "type"; readonly char: string }
  | { readonly type: "backspace" }
  | { readonly type: "cycle" };

/**
 * Advances the search by one keystroke.
 *
 * Typing or backspacing resets `offset` back to 0 — a query that just changed
 * ought to show its *best* match first, not wherever cycling had wandered
 * under the query it replaced. `cycle` (a second Ctrl+R) is the only action
 * that touches the offset, and only ever moves it further from the newest
 * match; wrapping it back around once every match has been seen is
 * {@link reverseSearchSelection}'s job; this function does not know how many
 * matches there are, on purpose, and could not wrap correctly if it tried.
 */
export function reduceReverseSearch(
  state: ReverseSearchState,
  action: ReverseSearchAction,
): ReverseSearchState {
  switch (action.type) {
    case "type":
      return { query: state.query + action.char, offset: 0 };
    case "backspace":
      return state.query === ""
        ? state
        : { query: state.query.slice(0, -1), offset: 0 };
    case "cycle":
      return { query: state.query, offset: state.offset + 1 };
  }
}

/**
 * The history entries `query` matches, in whatever order `history` hands them
 * back — `rlHistory`'s, which is newest-first, same as everywhere else this
 * module reads it. Matching is a plain case-insensitive substring test, and
 * an empty query matches everything: Ctrl+R with nothing typed yet is "start
 * stepping through history", the same thing ↑ does one entry at a time.
 */
export function reverseSearchMatches(
  history: readonly string[],
  query: string,
): readonly string[] {
  const needle = query.toLowerCase();
  return history.filter((entry) => entry.toLowerCase().includes(needle));
}

/**
 * The match Enter or Tab would accept right now, or `undefined` when the
 * query matches nothing.
 *
 * `offset` is taken modulo the match count here, not in
 * {@link reduceReverseSearch}, so that cycling past the oldest match wraps
 * back around to the newest rather than running off the end of a list this
 * function is the only one that ever actually looks at the length of.
 */
export function reverseSearchSelection(
  state: ReverseSearchState,
  matches: readonly string[],
): string | undefined {
  return matches.length === 0
    ? undefined
    : matches[state.offset % matches.length];
}

export interface ReverseSearchRenderOptions {
  readonly columns: number;
  readonly styles: Styles;
  /** Match rows shown under the indicator. Defaults to {@link REVERSE_SEARCH_MAX_ROWS}. */
  readonly maxRows?: number;
}

/** Match rows shown before the list gives up and counts the rest. */
export const REVERSE_SEARCH_MAX_ROWS = 4;

const SEARCH_MARK = "❯ ";
const SEARCH_INDENT = "  ";

/**
 * The reverse-i-search UI, as rows ready for {@link drawBelow} — the same
 * shape {@link renderCommandMenu} hands back, because it is drawn through the
 * exact same pipe: one indicator row, then as many matches as fit, with the
 * one Enter or Tab would accept marked and the rest dim.
 *
 * The indicator never disappears, even when nothing matches — it switches to
 * a dim "no match" reading instead of an empty list, so the query being fixed
 * stays legible rather than vanishing along with the rows under it. And
 * unlike {@link renderCommandMenu}'s window, which always starts at the
 * newest candidate, this one starts at the *current selection*: the row right
 * under the indicator is always "what Enter sends" — the one thing this
 * feature exists to show — and the few rows under that are a preview of where
 * the next Ctrl+R would take you, not a scrollback of everything above it.
 *
 * A history entry spanning multiple lines is flattened with
 * {@link historyEntryFor} before it is measured or drawn, exactly the
 * transformation an entry already goes through on its way *into* history —
 * so a multiline command reads as one row instead of looking cut off after
 * its first line.
 */
export function renderReverseSearch(
  state: ReverseSearchState,
  history: readonly string[],
  options: ReverseSearchRenderOptions,
): readonly string[] {
  const matches = reverseSearchMatches(history, state.query);
  const styles = options.styles;
  const limit = Math.max(1, options.columns - 1);
  const noMatch = matches.length === 0;

  // Built and truncated as one plain string, then re-sliced for styling —
  // the same order `renderCommandMenu` uses above, and for the same reason:
  // truncating text that already carries escape codes counts bytes that were
  // never going to occupy a cell.
  const prefix = "(reverse-i-search) ";
  const suffix = noMatch ? " — no match" : "";
  const plainIndicator = `${prefix}${state.query}${suffix}`;
  const chars = [...truncateTo(plainIndicator, limit)];
  const prefixEnd = Math.min(prefix.length, chars.length);
  const queryEnd = Math.min(prefixEnd + state.query.length, chars.length);
  const head = chars.slice(0, prefixEnd).join("");
  const body = chars.slice(prefixEnd, queryEnd).join("");
  const rest = chars.slice(queryEnd).join("");
  const indicator = noMatch
    ? styles.menu(`${head}${body}${rest}`)
    : `${styles.menu(head)}${styles.user(body)}${styles.menu(rest)}`;

  if (noMatch) return [indicator];

  const maxRows = Math.max(1, options.maxRows ?? REVERSE_SEARCH_MAX_ROWS);
  const selected = state.offset % matches.length;
  const visible = matches.slice(selected, selected + maxRows);
  const hidden = matches.length - selected - visible.length;

  const rows = visible.map((entry, index) => {
    const marker = index === 0 ? SEARCH_MARK : SEARCH_INDENT;
    const plain = truncateTo(`${marker}${historyEntryFor(entry)}`, limit);
    return index === 0 ? styles.user(plain) : styles.menu(plain);
  });
  if (hidden > 0) {
    rows.push(
      styles.menu(truncateTo(`${SEARCH_INDENT}… and ${hidden} more`, limit)),
    );
  }
  return [indicator, ...rows];
}

/**
 * Where `text` leaves the cursor on a terminal `columns` wide, by the same
 * rules `readline` applies — the fallback for a runtime whose `Interface` no
 * longer exposes `_getDisplayPos`.
 *
 * The two details worth copying exactly, because getting either wrong moves a
 * row: cells are accumulated *without* wrapping and the row count falls out of
 * one division at the end (so a string that exactly fills a row reports column
 * 0 of the next one, which is where readline's own forced space puts the
 * caret), and a double-width character that would straddle the edge is pushed
 * whole onto the next row.
 */
export function localDisplayPos(
  text: string,
  columns: number,
): { readonly rows: number; readonly cols: number } {
  const width = Math.max(1, columns);
  let offset = 0;
  let rows = 0;
  for (const char of stripEscapes(text)) {
    if (char === "\n") {
      rows += Math.ceil(offset / width) || 1;
      offset = 0;
      continue;
    }
    const cells = charWidth(char.codePointAt(0) ?? 0);
    if (cells === 2 && (offset + 1) % width === 0) offset += 1;
    offset += cells;
  }
  const cols = offset % width;
  return { cols, rows: rows + (offset - cols) / width };
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
 * Whether a `keypress` event's `key` is Ctrl+`name` — guarding the
 * `undefined` a special key without a `readline.Key` (rare, but the type
 * allows it) would otherwise force at every call site.
 */
function isCtrlKey(key: readline.Key | undefined, name: string): boolean {
  return key !== undefined && key.ctrl === true && key.name === name;
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
  /**
   * The input band: the two soft-white rules the line being typed sits
   * between, and the gray bar a sent message becomes on its way into the
   * transcript (see `band.ts`).
   *
   * Omitting it turns the band off entirely and leaves this manager writing
   * exactly the bytes it wrote before the band existed — which is what every
   * caller that is not the REPL on a terminal wants, and what the tests below
   * a fake TTY assert.
   */
  readonly band?: BandDecor;
  /**
   * Called on every keystroke that changes the line being typed *while a turn
   * is running* — see {@link InputManager.captureWhileBusy}. That line is not
   * echoed by `readline`; whoever owns the screen during a turn paints it, and
   * this is how they learn it is time to repaint. Absent means the line is
   * captured but never shown, which is what a caller with nothing to paint on
   * (a test, a non-terminal stream) wants.
   */
  readonly onPendingChange?: () => void;
}

export interface InputManager {
  /** The main REPL read: multiline continuation + paste coalescing. */
  readMessage(promptText: string): Promise<InputReadResult>;
  /** One-line sub-question (e.g. a permission y/N). Not coalesced or stored. */
  question(query: string): Promise<string | typeof INPUT_SIGINT | undefined>;
  /**
   * Catches lines typed while a turn is running, instead of dropping them.
   *
   * The prompt's read is not open during a turn — the REPL is inside
   * `handleLine` and will not call {@link readMessage} again until it returns
   * — so a line Entered mid-turn used to reach a `line` event with nobody
   * waiting for it and simply vanish. This is the seam that catches it: while
   * a capture is open every completed line goes to `onLine` (trimmed, empties
   * skipped), the keystrokes that composed it are not echoed, and the buffer
   * is offered to a painter through {@link pendingRow}.
   *
   * Deliberately *not* a second {@link readMessage}: there is no promise to
   * resolve, no band to open, no multiline assembly and no paste window. A
   * turn may produce any number of lines or none, and each one is handed over
   * the moment it lands.
   *
   * @returns the closer for this capture. Idempotent; a buffer half-typed when
   * it runs is left in the editor, so the next prompt opens on it rather than
   * throwing the user's words away.
   */
  captureWhileBusy(onLine: (line: string) => void): () => void;
  /**
   * The mid-turn line as a row of text to paint, or `undefined` when there is
   * no capture open or nothing has been typed into it. See
   * {@link composePendingRow}.
   */
  pendingRow(): string | undefined;
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

  /**
   * The mid-turn capture, when one is open. Its presence is also what mutes
   * `readline`'s echo — the two are the same condition, so they cannot drift.
   */
  let capture: { readonly onLine: (line: string) => void } | undefined;

  /**
   * Whether `readline` currently draws nothing.
   *
   * A capture mutes it — but a permission question opened *during* that same
   * turn (the prompter shares this interface; see `createPrompter`) is
   * `readline` being asked to run a real prompt, and a prompt nobody can see
   * is worse than no prompt at all. So the question wins for as long as it is
   * open, and the capture goes back to owning the editor afterwards.
   */
  const echoMuted = (): boolean =>
    capture !== undefined && questionPending === undefined;

  const rl = readline.createInterface({
    input: options.input,
    output: gatedOutput(options.output, echoMuted),
    terminal: true,
    history: options.history ? [...options.history] : [],
    historySize: 200,
    ...(options.completer
      ? { completer: toReadlineCompleter(options.completer) }
      : {}),
  });

  /**
   * `readline`'s own keypress handling, captured the instant after it
   * attaches and before this module's own listener joins the list — see the
   * comment above `options.input.on("keypress", onKeypress)` further down.
   *
   * Everywhere else in this file, "after readline" is the only vantage point
   * there is: this module's listener is registered second, so it always sees
   * a buffer `readline` has already mutated, and the band and the `/` menu
   * are built entirely out of reading that aftermath — a query character for
   * reverse-i-search cannot be handled that way. There is nothing to "undo"
   * a keystroke `readline` has already echoed and folded into `rl.line`,
   * because `write` is not something one listener can take back from
   * another, and `EventEmitter` has no "handled, stop here": every listener
   * registered for an event runs, in order, regardless of what an earlier one
   * decided. Being first in line buys nothing.
   *
   * What *does* work is removing `readline`'s listener from `input` for as
   * long as search is open, and putting it back the moment search ends.
   * While it is off, `readline` itself is untouched — its `history`, its
   * `line`, its `cursor` all still exist exactly where they were — it is
   * simply never handed a key, so none of them move. Every keystroke that
   * would otherwise have gone to it instead reaches only
   * {@link onSearchKeypress}, which is free to treat a plain character as
   * "extend the query" rather than "insert here" precisely because nothing
   * else in the process ever sees it as an insertion.
   *
   * The snapshot has to be taken *now* — before this module's own permanent
   * listener is added a little further down — or that listener would end up
   * captured inside the very array meant to be suspended and resumed around
   * it. It is read once, not on every search: `readline` never re-registers
   * this listener after construction, so the array can never go stale.
   */
  const readlineKeypressListeners = options.input
    .listeners("keypress")
    .slice() as unknown as ReadonlyArray<(...args: unknown[]) => void>;

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

  // --- the input band, and the live slash-command menu ----------------------
  //
  // Everything drawn around the line being typed is drawn here, in one place,
  // by one function: the soft-white rule under the input, the `/` menu under
  // that, and the erase that takes both back. The rule *above* the input is
  // the odd one out — it is written once, when the band opens, and readline
  // never touches the row above its own block, so it needs no repainting.
  //
  //     ────────────────────────────────   ← written once by `openBand`
  //     tell me about render.ts▏           ← readline's, redrawn per keystroke
  //     ────────────────────────────────   ← `drawBelow`, redrawn per keystroke
  //       /resume   switch to a stored …   ← `drawBelow`, when a `/` is open
  //
  // Every escape below is *relative* — `ESC[nA/B`, `\r`, `ESC[0J` — so a
  // scroll, a resize or an alternate screen can move the whole block without
  // invalidating a single one of them. Nothing here ever addresses a row.
  //
  // One keystroke redraws like this: readline's own `_refreshLine` has already
  // run by the time our `keypress` listener is called (it was registered
  // first), and it clears from the top of the input block downwards — so
  // whatever we drew last is usually gone before we draw again. `drawBelow`
  // re-clears anyway, in the same write, because the keys that only move the
  // cursor never trigger that refresh.
  //
  // The cursor always ends where it started: on the input line, in the column
  // readline believes it is in. readline's own bookkeeping is therefore never
  // touched, which is what keeps ↑-history, wrapping and Tab intact.
  //
  // ## The wrap boundary, which is the whole reason this is hard
  //
  // A previous attempt at the lower rule was abandoned because `readline` and
  // the terminal appear to disagree about where the caret is whenever the text
  // typed so far ends exactly on a row boundary. They do not, in fact,
  // disagree — `_refreshLine` writes a deliberate extra space at that one
  // column ("force terminal to allocate a new line") precisely to resolve the
  // deferred wrap — but the *arithmetic* around it was wrong: counting rows as
  // `floor(cells / columns)` says there is one row below the caret when the
  // caret is sitting at the start of the last row and there is none. Draw the
  // menu one row too low and come back one row too high, and the line being
  // typed is overwritten by its own scaffolding.
  //
  // So no row count here is estimated. {@link displayPos} asks readline itself
  // where a string ends, using the very function `getCursorPos` is built on,
  // and every move is the difference between two of its answers. That is what
  // makes a rule under a wrapping line safe where a rule under a `/command` —
  // which is short and never reaches a boundary — merely looked safe.

  const CSI = "\u001b[";
  const menuEntries = options.commandMenu;
  const menuStyles = options.styles ?? PLAIN_STYLES;
  const menuMaxRows = options.commandMenuRows ?? COMMAND_MENU_MAX_ROWS;
  const decor = options.band;
  /**
   * Both ends must be a terminal: a piped stdin has no keystrokes to react to
   * and a redirected stdout must never receive a cursor escape. A run without
   * a band or a menu writes exactly the bytes it wrote before either existed.
   */
  const onTerminal =
    options.input.isTTY === true && options.output.isTTY === true;
  const menuEnabled = menuEntries !== undefined && onTerminal;
  const bandEnabled = decor !== undefined && onTerminal;
  /**
   * Whether Ctrl+R may open reverse-i-search — the same `onTerminal` rule as
   * the menu and the band, and for the same reason: search is drawn through
   * the identical `drawBelow` pipe and reaches real keystrokes off `input`
   * directly, neither of which exists on a pipe.
   */
  const searchEnabled = onTerminal;
  /**
   * Reverse-i-search state, or `undefined` while the ordinary editor owns the
   * keyboard. Its presence is what tells `onKeypress` to stand aside — see
   * {@link onSearchKeypress}, which is who takes over instead.
   */
  let search: ReverseSearchState | undefined;
  /** Physical rows currently drawn below the input block. */
  let belowRows = 0;
  /** True while another consumer owns the terminal (see `withSuspended`). */
  let suspended = false;
  /** True between {@link openBand} and the erase that closes it. */
  let bandOpen = false;
  /**
   * True from the moment a complete message lands until the paste window
   * closes and the band comes down. Nothing is redrawn under the input in
   * between: the keystroke that submitted has a `keypress` listener of its
   * own still to run, and a rule painted by it would be a row of chrome
   * written under a prompt that is already over — one that has to scroll a
   * new row into being to do it.
   */
  let submitting = false;
  /**
   * Rows from the current readline block's first row up to the band's upper
   * rule — 1 for an ordinary prompt, more once a multiline block has pushed
   * lines above the one being typed. The single number every erase is
   * measured from; see {@link closeBand}.
   */
  let rowsAboveBlock = 0;

  const write = (text: string): void => {
    options.output.write(text);
  };

  const columns = (): number => {
    const value = options.output.columns;
    return typeof value === "number" && value > 0
      ? value
      : DEFAULT_BAND_COLUMNS;
  };

  /** The terminal's height, when it admits to one. */
  const screenRows = (): number | undefined => {
    const value = (options.output as { rows?: number }).rows;
    return typeof value === "number" && value > 0 ? value : undefined;
  };

  /**
   * Where `text` leaves the cursor, in readline's own model of the screen.
   *
   * Delegated to `readline`'s `_getDisplayPos` — private-but-stable in the
   * same way `.history` and `.clearLine` are, and the function `getCursorPos`
   * itself is one line of sugar over. Borrowing it rather than reimplementing
   * it is what guarantees that the rows this band counts and the rows readline
   * counts can never be two different numbers, which is the only way a block
   * drawn around a live editor stays in one piece.
   */
  const displayPos = (text: string): { rows: number; cols: number } => {
    const get = (
      rl as unknown as {
        _getDisplayPos?: (value: string) => { rows: number; cols: number };
      }
    )._getDisplayPos;
    if (typeof get === "function") {
      try {
        return get.call(rl, text);
      } catch {
        // fall through to the local model
      }
    }
    return localDisplayPos(text, columns());
  };

  /** What readline currently prefixes the line being edited with. */
  const promptText = (): string => {
    const get = (rl as unknown as { getPrompt?: () => string }).getPrompt;
    return typeof get === "function" ? get.call(rl) : "";
  };

  /** Where readline believes the caret is, relative to the prompt's start. */
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

  /** How many rows the whole input block occupies right now. */
  const blockRows = (): number => displayPos(promptText() + rl.line).rows + 1;

  /**
   * How many rows of the input block sit *below* the caret's own row — the
   * tail of a wrapped line the user has arrowed back into. Whatever is drawn
   * under the input goes under the whole block, not under the caret.
   */
  const rowsBelowCursor = (): number =>
    Math.max(0, blockRows() - 1 - cursorPos().rows);

  /**
   * Make the phantom row at an exact wrap boundary real, so the terminal and
   * `readline` are standing on the same one before anything moves.
   *
   * This is the wrap-boundary bug, and it is worth stating precisely because
   * it is subtler than "readline lies". When the text ends exactly at the
   * right edge, the terminal does *not* move to the next row — it sets a
   * deferred-wrap flag and stays put, so the caret is at (row R, last column)
   * while readline's model says (row R+1, column 0). readline knows this and
   * resolves it: `_refreshLine` writes one extra space at that column, which
   * makes the terminal wrap for real, and its comment says as much — "force
   * terminal to allocate a new line".
   *
   * The catch is that `_refreshLine` is not always what runs. Node's
   * `kInsertString` has a second, faster branch taken while
   * `isCompletionEnabled` is false — which is exactly what a *paste* does,
   * and a paste is exactly when a long line crosses a boundary — and that
   * branch echoes the character and nothing else. The space is never written,
   * the wrap stays deferred, and every relative move afterwards is a row out.
   * That is what killed the previous attempt at a rule under the input: it is
   * unreproducible by typing and immediate on paste.
   *
   * So the band writes the space itself, on the same reasoning readline uses,
   * and then clears the row it just landed on (the space has done its work by
   * then; leaving it would mean the row under a wrapped line is never quite
   * empty). Two guards make it safe. Only when the *whole block* ends on a
   * boundary — a caret sitting on one mid-line means readline has already
   * refreshed and resolved it. And only when the caret is at the end of the
   * buffer, which is the only place an unresolved wrap can be, because every
   * cursor movement away from it goes through a refresh.
   */
  const resolveDeferredWrap = (): void => {
    const end = displayPos(promptText() + rl.line);
    if (end.cols !== 0 || end.rows === 0) return;
    if (rl.cursor !== rl.line.length) return;
    write(` \r${CSI}0K`);
  };

  /** Climb `up` rows and return to the caret's column. */
  const backToCursor = (up: number, cols: number): string =>
    `${up > 0 ? `${CSI}${up}A` : ""}\r${cols > 0 ? `${CSI}${cols}C` : ""}`;

  /** Move `up` rows and to column 0 — where an erase or a repaint starts. */
  const moveUpToColumnZero = (up: number): string =>
    up > 0 ? `${CSI}${up}A\r` : "\r";

  /** Erase everything under the input block, caret left where it was. */
  const eraseBelow = (): void => {
    if (belowRows === 0) return;
    belowRows = 0;
    resolveDeferredWrap();
    const { cols } = cursorPos();
    // `ESC[nB` rather than newlines: the rows are known to exist (something is
    // drawn on them), so moving down cannot scroll, and nothing below is ever
    // created.
    const down = rowsBelowCursor() + 1;
    write(`${CSI}${down}B\r${CSI}0J${backToCursor(down, cols)}`);
  };

  /**
   * Erase from where readline's own `\r\n` has already left the caret: the
   * first row under the block. This is the Enter path — by the time the `line`
   * event fires the caret has left the input line, so {@link eraseBelow}'s
   * arithmetic no longer applies and a plain clear-to-end-of-screen is both
   * correct and cheaper.
   */
  const dropBelow = (): void => {
    if (belowRows === 0) return;
    belowRows = 0;
    write(`\r${CSI}0J`);
  };

  /** Draw `rows` under the input block, in one write, caret unmoved. */
  const drawBelow = (rows: readonly string[]): void => {
    resolveDeferredWrap();
    const { cols } = cursorPos();
    const below = rowsBelowCursor();
    // `\r\n` (not `ESC[B`) for the step onto the first row under the block:
    // that row may not exist yet, and a newline is the one thing that makes
    // the terminal scroll one into being.
    const down = below + rows.length;
    write(
      `${below > 0 ? `${CSI}${below}B` : ""}\r\n${CSI}0J${rows.join("\r\n")}${backToCursor(down, cols)}`,
    );
    belowRows = rows.length;
  };

  /** The menu's rows for the buffer as it stands, or none at all. */
  const menuLines = (): readonly string[] => {
    if (!menuEnabled) return [];
    // Only ever under a message being composed: a `question()` answer and an
    // idle prompt-less terminal are not places to offer commands.
    if (readPending === undefined) return [];
    const token = commandMenuToken(rl.line, rl.cursor);
    if (token === undefined) return [];
    const matches = filterCommandMenu(menuEntries?.() ?? [], token);
    return renderCommandMenu(matches, token, {
      columns: columns(),
      styles: menuStyles,
      maxRows: menuMaxRows,
    });
  };

  /**
   * The reverse-i-search rows for the query as it stands, or none at all —
   * `menuLines`'s counterpart, drawn instead of it rather than beside it
   * whenever {@link search} is open (see {@link renderBelow}).
   */
  const searchLines = (): readonly string[] => {
    if (search === undefined) return [];
    return renderReverseSearch(search, rlHistory(rl) ?? [], {
      columns: columns(),
      styles: menuStyles,
    });
  };

  /**
   * Put the screen back in the state the buffer implies: the band's lower rule
   * under the input, then either the `/` menu or the reverse-i-search rows
   * under that — never both, since a query typed for one is never a command
   * name for the other — and nothing under either.
   *
   * The menu (and search) sit *outside* the band rather than between the
   * input and the rule, which is a choice about what the rules mean. They
   * bound the thing you are typing into; a list of what you might be typing,
   * or of what you might be recalling, is a suggestion about it, and putting
   * it inside the frame would make the frame grow and shrink under your hands
   * for reasons that have nothing to do with your message.
   */
  const renderBelow = (): void => {
    if (suspended || submitting) return;
    const rows = [
      ...(bandOpen && decor !== undefined ? [decor.rule(columns())] : []),
      ...(search !== undefined ? searchLines() : menuLines()),
    ];
    if (rows.length === 0) {
      eraseBelow();
      return;
    }
    drawBelow(rows);
  };

  /**
   * Open the band: write its upper rule and leave the caret on the row under
   * it, which is where readline is about to draw the prompt.
   *
   * Printed rather than painted, and printed *once*: the row above readline's
   * own block is the one row readline never clears, so the rule stays put
   * through every keystroke, every wrap and every `_refreshLine` without
   * anyone redrawing it. It comes back off in {@link closeBand}, which is the
   * only thing on screen that ever knew it was there.
   */
  const openBand = (): void => {
    if (!bandEnabled || decor === undefined || suspended || bandOpen) return;
    write(`${decor.rule(columns())}\r\n`);
    bandOpen = true;
    submitting = false;
    rowsAboveBlock = 1;
  };

  /**
   * Take the whole band off the screen, from its upper rule down.
   *
   * `fromBelowBlock` distinguishes the two moments this is called at. After a
   * `line` event (and after `clearLine`'s `\r\n` on Ctrl-C) the caret is on
   * the row *under* the input block, so the climb has to clear the block's own
   * rows too — `consumed` is how many they were, measured before readline
   * emptied the buffer. Otherwise the caret is still inside the block, and the
   * climb is however far down it the caret had wandered.
   *
   * A band taller than the screen is left exactly where it is, and this
   * answers `false` so the caller knows nothing was reclaimed: the climb would
   * stop at the top row and the erase would take the transcript with it, and a
   * band that is merely still on screen is a far better outcome than a
   * transcript with a hole in it.
   *
   * @returns whether the band's rows were actually reclaimed.
   */
  const closeBand = (fromBelowBlock: boolean, consumed = 0): boolean => {
    if (!bandOpen) return false;
    // The caret is still inside the block on this path, so it may be the one
    // holding a deferred wrap; on the other it has already been carried below
    // the block by a `\r\n` that resolved it.
    if (!fromBelowBlock) resolveDeferredWrap();
    const up = rowsAboveBlock + (fromBelowBlock ? consumed : cursorPos().rows);
    bandOpen = false;
    submitting = false;
    belowRows = 0;
    rowsAboveBlock = 0;
    const height = screenRows();
    if (height !== undefined && up + 1 >= height) return false;
    write(`${moveUpToColumnZero(up)}${CSI}0J`);
    return true;
  };

  /** Print a sent message into the transcript as its gray bar. */
  const echoSubmitted = (message: string): void => {
    if (decor === undefined) return;
    for (const row of decor.echo(message, columns())) {
      write(`${row}\r\n`);
    }
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

  /** Detaches `readline`'s own key handling — see {@link readlineKeypressListeners}. */
  const suspendReadlineKeypress = (): void => {
    for (const listener of readlineKeypressListeners) {
      options.input.removeListener("keypress", listener);
    }
  };

  /**
   * Reattaches it, and restores the one ordering this module depends on:
   * readline's listener first, this module's own `onKeypress` second — the
   * band and the `/` menu are drawn from the buffer readline has *already*
   * updated for the key, so a listener that ran first would paint one
   * keystroke behind. Re-appending `onKeypress` after readline's is what
   * keeps that true across a suspension or a reverse-i-search.
   */
  const resumeReadlineKeypress = (): void => {
    for (const listener of readlineKeypressListeners) {
      options.input.on("keypress", listener);
    }
    options.input.removeListener("keypress", onKeypress);
    options.input.on("keypress", onKeypress);
  };

  /**
   * Overwrites `readline`'s buffer directly — the same private-but-stable
   * fields {@link abandonLine} falls back to when `clearLine` does not exist.
   * Used only to install the entry reverse-i-search accepted, caret at its
   * end: "accept, then keep editing" is the point, not dropping the user back
   * wherever the query happened to leave the cursor.
   */
  const setEditorLine = (text: string): void => {
    const state = rl as unknown as { line?: string; cursor?: number };
    state.line = text;
    state.cursor = text.length;
  };

  /**
   * Opens reverse-i-search: freezes the buffer exactly as it stands — nothing
   * about it changes until the search is accepted or cancelled, which is also
   * why cancelling needs no separate "restore" step below — and hands every
   * future keystroke to {@link onSearchKeypress} instead of `readline`.
   */
  const enterSearch = (): void => {
    search = initialReverseSearch();
    suspendReadlineKeypress();
    options.input.on("keypress", onSearchKeypress);
    renderBelow();
  };

  /**
   * Closes reverse-i-search. `readline`'s own listener goes back on `input`
   * first, so a key arriving the instant after acceptance is handled the
   * ordinary way rather than falling into a gap between two disconnected
   * halves of this manager.
   *
   * `entry` is the history line to install, caret at its end, or `undefined`
   * to cancel — cancelling needs no restoring work at all, because the buffer
   * was never touched while search was open (see {@link enterSearch}).
   * `rl.prompt(true)` is what makes either outcome visible: the primary row
   * was never redrawn during search (nothing wrote to it — that is the whole
   * point of lifting `readline`'s listener off `input`), so the screen still
   * shows whatever it showed before Ctrl+R, and `rl.prompt(true)` — the same
   * call `withSuspended` reopens a prompt with, further down — is what
   * reconciles it with whatever `readline`'s buffer holds now, preserving the
   * caret this function (or the untouched buffer) just left it at.
   */
  const leaveSearch = (entry: string | undefined): void => {
    if (search === undefined) return;
    search = undefined;
    options.input.removeListener("keypress", onSearchKeypress);
    resumeReadlineKeypress();
    if (entry !== undefined) setEditorLine(entry);
    rl.prompt(true);
    renderBelow();
  };

  /**
   * Every keystroke while reverse-i-search is open, in place of `readline`'s
   * own handling — see {@link readlineKeypressListeners} for why this is the
   * *only* listener a key reaches while `search` is set.
   */
  const onSearchKeypress = (
    str: string | undefined,
    key: readline.Key | undefined,
  ): void => {
    if (search === undefined) return;
    if (key?.name === "escape" || isCtrlKey(key, "c")) {
      // Ctrl-C here is not the abort-the-line Ctrl-C: `readline` never sees
      // this keystroke — its listener is off `input` for the duration of the
      // search — so the `SIGINT` event that keystroke would otherwise raise
      // never fires at all. There is nothing for the ordinary Ctrl-C handling
      // further down to even see.
      leaveSearch(undefined);
      return;
    }
    if (isCtrlKey(key, "r")) {
      search = reduceReverseSearch(search, { type: "cycle" });
      renderBelow();
      return;
    }
    if (
      key?.name === "return" ||
      key?.name === "enter" ||
      key?.name === "tab"
    ) {
      const matches = reverseSearchMatches(rlHistory(rl) ?? [], search.query);
      leaveSearch(reverseSearchSelection(search, matches));
      return;
    }
    if (key?.name === "backspace") {
      search = reduceReverseSearch(search, { type: "backspace" });
      renderBelow();
      return;
    }
    // Anything else with a printable representation and no modifier held is
    // a character for the query — arrows and the like arrive with `str`
    // `undefined` and are silently ignored, the same as `readline` ignores an
    // unbound key.
    if (str !== undefined && str.length > 0 && !key?.ctrl && !key?.meta) {
      search = reduceReverseSearch(search, { type: "type", char: str });
      renderBelow();
    }
  };

  const onKeypress = (
    _str: string | undefined,
    key: readline.Key | undefined,
  ): void => {
    // While another consumer owns the terminal (see `withSuspended`) these
    // keystrokes are theirs: readline's own listener is off the stream, and
    // reacting here would paint over whatever they are drawing.
    if (suspended) return;
    // Mid-turn nothing under the input is ours to draw: the status band owns
    // that part of the screen, and the line being typed is one of its rows.
    if (capture !== undefined) {
      options.onPendingChange?.();
      return;
    }
    // While search is open, every key is `onSearchKeypress`'s to interpret —
    // this listener is never removed, so it still fires, but it has nothing
    // left to do until search ends.
    if (search !== undefined) return;
    if (
      searchEnabled &&
      readPending !== undefined &&
      questionPending === undefined &&
      isCtrlKey(key, "r")
    ) {
      enterSearch();
      return;
    }
    renderBelow();
  };
  /**
   * A resize invalidates every row already on screen (the terminal reflows
   * them itself, by rules that differ between emulators). Re-rendering is the
   * defensive move: `drawBelow` clears from the input line down before it
   * writes, so whatever the reflow left behind goes with it — and the rules it
   * writes are measured against the width the terminal has *now*.
   */
  const onResize = (): void => {
    if (capture !== undefined) {
      options.onPendingChange?.();
      return;
    }
    renderBelow();
  };

  // `readline` already turned this stream into a keypress emitter; our
  // listener is simply the second one, so it sees the buffer *after* readline
  // has applied the key. Registered unconditionally — the band and the menu
  // are terminal-only, but the mid-turn capture repaints on any stream, and
  // everything downstream of here is a no-op when neither is switched on.
  // `onSearchKeypress` is the exception: it goes on `input` only for the
  // duration of a search, and by the time it is on there, `readline`'s own
  // listener has been taken back off — see {@link readlineKeypressListeners}.
  options.input.on("keypress", onKeypress);
  options.output.on("resize", onResize);

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

  /**
   * Hands a line typed during a turn to whoever opened the capture.
   *
   * Trimmed and non-empty only: a bare Enter while waiting is a nervous tic,
   * not a message, and dispatching it would cost the user a turn. The line is
   * recorded in the session's history like any other — it is something they
   * typed and sent, and ↑ on the next prompt has to find it — while
   * `readline`'s own history already holds it, put there by the same Enter.
   */
  function deliverCaptured(line: string): void {
    const current = capture;
    if (current === undefined) return;
    const text = line.trim();
    // The buffer is empty either way: tell the painter before anything else,
    // so the row the line was on comes off screen with the line.
    options.onPendingChange?.();
    if (text === "") return;
    const entry = historyEntryFor(text);
    if (entry !== "") options.onHistoryAppend?.(entry);
    current.onLine(text);
  }

  /**
   * Puts `readline`'s idea of what it last drew back to "nothing", without
   * touching the buffer.
   *
   * Needed exactly once: on the way out of a mid-turn capture. Every redraw
   * `readline` performs starts by climbing back over the rows it believes it
   * drew last time (`prevRows`) and clearing from there down — and while the
   * capture was open it drew none of them, because they were all muted. Left
   * as it is, the first real redraw afterwards would climb over rows of
   * somebody else's transcript and erase them. Private-but-stable in the same
   * way `.history` and `.clearLine` above are; a runtime without it is no
   * worse off than before this existed.
   */
  function resetLineModel(): void {
    const state = rl as unknown as { prevRows?: number };
    if (typeof state.prevRows === "number") state.prevRows = 0;
  }

  function resolveRead(value: InputReadResult): void {
    if (readPending === undefined) return;
    clearCoalesceTimer();
    const { resolve } = readPending;
    readPending = undefined;
    resolve(value);
  }

  /**
   * The end of one read on a terminal: the band comes off the screen, and a
   * message that was actually sent is printed back into the transcript as its
   * gray bar.
   *
   * Erasing and reprinting rather than leaving what the terminal echoed is the
   * one place this manager rewrites the screen, and it is worth the trouble:
   * the echoed text is the user's keystrokes, in whatever colours the terminal
   * felt like, on rows the band happens to own. The bar is the same words, in
   * the transcript, marked as theirs — and appended, never erased in place, so
   * it survives every scroll afterwards.
   *
   * Nothing is reprinted for a Ctrl-C or an end-of-input: no message was sent,
   * so the band simply closes over an empty row.
   */
  function closeBandFor(
    message: string | undefined,
    consumedRows: number,
  ): void {
    if (!bandOpen) return;
    const reclaimed = closeBand(true, consumedRows);
    // No bar when the band could not be taken down: the rows it is still
    // sitting on are showing the message as the terminal echoed it, and
    // printing it a second time underneath would read as two messages.
    if (reclaimed && message !== undefined) echoSubmitted(message);
  }

  function scheduleCoalesceFlush(): void {
    if (readPending === undefined) return;
    clearCoalesceTimer();
    readPending.coalesceTimer = setTimeout(() => {
      if (readPending === undefined) return;
      const message = readPending.coalesced ?? "";
      readPending.assembly = initialAssembly();
      fixupHistoryFor(message);
      // Before the promise resolves, so the bar is on screen above whatever
      // the turn it starts prints next.
      closeBandFor(message, 0);
      resolveRead(message);
    }, pasteWindowMs);
  }

  rl.on("line", (line: string) => {
    // How tall the block readline has just finished echoing was. Measured
    // *here*, from the text it echoed and the prompt it echoed in front of it,
    // because `rl.line` is already empty by now and this is the last moment
    // the number can be known. See `closeBand`.
    const consumed = bandOpen ? displayPos(promptText() + line).rows + 1 : 0;
    // readline has already written the `\r\n` that ends the echoed line, so
    // the caret is standing on the band's lower rule: wipe it there, before
    // anything the REPL prints next lands on top of stale chrome.
    dropBelow();
    if (questionPending !== undefined) {
      // readline routes lines to the question callback while a question is
      // pending, not to this listener — nothing to do here in that case.
      return;
    }
    if (readPending === undefined) {
      // No read is open. Either a turn is running and something asked to
      // catch what gets typed into it, or the line has nowhere to go and is
      // dropped exactly as it always was.
      deliverCaptured(line);
      return;
    }

    const action = reduceAssemblyLine(readPending.assembly, line);
    if (action.type === "continue") {
      // The band grows rather than reopening: the lines already typed stay on
      // screen under the upper rule, and the one being typed keeps the lower
      // one under it. Only the offset the eventual erase climbs from moves.
      rowsAboveBlock += consumed;
      readPending.assembly = action.state;
      rl.setPrompt(continuationPrompt);
      rl.prompt();
      renderBelow();
      return;
    }

    // A complete message landed. Rather than resolve immediately, fold it
    // into whatever's already been coalesced this read and (re)start the
    // paste window: another `line` arriving before it fires means more of
    // the same pasted block, joined with "\n".
    rowsAboveBlock += consumed;
    submitting = bandOpen;
    // Nothing follows this line's echo, so nothing should be measured against
    // a prompt that will not be written in front of it: a pasted block's
    // second and later lines are echoed bare.
    if (bandOpen) rl.setPrompt("");
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
    eraseBelow();
    // How tall the block `abandonLine` is about to close is, measured while
    // the buffer it is measured from still exists.
    const consumed = bandOpen ? blockRows() : 0;
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
      // No gray bar: an abandoned line was never sent, and the band closes
      // over it rather than leaving half a message above the transcript.
      closeBandFor(undefined, consumed);
      resolveRead(INPUT_SIGINT);
      return;
    }
    if (capture !== undefined) {
      // A turn is running and the user was part-way through a line for it.
      // The Ctrl-C still means the turn — that is the one thing it has always
      // meant here — but the half-typed line goes with it: they are changing
      // course, and a fragment aimed at the run they just cancelled is not
      // something to carry into the next prompt. Nothing is written: the
      // buffer was never echoed, so there is no row to end.
      abandonLine();
      resetLineModel();
      options.onPendingChange?.();
      options.onIdleSigint?.();
      return;
    }
    // Nothing was being typed (a turn is running, and this Ctrl-C is meant for
    // it): no buffer to throw away, and no row to end — a newline here would
    // be a blank line in the middle of the assistant's output.
    options.onIdleSigint?.();
  });

  rl.on("close", () => {
    closed = true;
    // A search left open when the interface closes is cleaned up quietly:
    // `readline`'s listener is not needed back for anything further, but
    // leaving `onSearchKeypress` attached to a stream nobody else is
    // listening to any more would be a leak.
    if (search !== undefined) {
      search = undefined;
      options.input.removeListener("keypress", onSearchKeypress);
      resumeReadlineKeypress();
    }
    eraseBelow();
    // Ctrl-D writes no newline, so the caret is still inside the block: this
    // is the one close that climbs from where it stands rather than from the
    // row under it.
    closeBand(false);
    options.input.removeListener("keypress", onKeypress);
    options.output.removeListener("resize", onResize);
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
        // The upper rule first, then the prompt on the row under it: the
        // band opens around the read rather than being drawn into by it.
        openBand();
        rl.setPrompt(promptText);
        // `preserveCursor`, because the buffer is not always empty: a line the
        // user was still typing when the turn ended is still in the editor
        // (see `captureWhileBusy`), and a prompt that reset the cursor to 0
        // would leave them typing into the middle of their own sentence. On
        // the ordinary path the buffer is empty and the cursor is 0 either
        // way, so this changes nothing.
        rl.prompt(true);
        // A fresh prompt starts on an empty buffer, but `/help` may have just
        // grown the command list: render so the state on screen is this
        // read's, not the last one's — and so the lower rule is there before
        // the first keystroke.
        renderBelow();
      });
    },

    captureWhileBusy(onLine: (line: string) => void): () => void {
      if (closed) return () => undefined;
      if (capture !== undefined) {
        throw new Error(
          "InputManager.captureWhileBusy: a capture is already open",
        );
      }
      const opened = { onLine };
      capture = opened;
      return () => {
        if (capture !== opened) return;
        capture = undefined;
        // Whatever is still in the buffer was never drawn, and `readline`
        // spent the capture redrawing into a muted stream: hand it back a
        // clean slate to draw the next prompt onto. The text itself stays —
        // the next `readMessage` opens on it, so a line the user was still
        // composing when the turn ended survives into the prompt.
        resetLineModel();
        options.onPendingChange?.();
      };
    },

    pendingRow(): string | undefined {
      if (capture === undefined) return undefined;
      // Whatever is in the buffer belongs to the question, not to the turn.
      if (questionPending !== undefined) return undefined;
      if (rl.line === "") return undefined;
      return composePendingRow(rl.line, rl.cursor);
    },

    question(query: string): Promise<string | typeof INPUT_SIGINT | undefined> {
      if (closed) return Promise.resolve(undefined);
      if (readPending !== undefined || questionPending !== undefined) {
        throw new Error("InputManager.question: a read is already in progress");
      }
      if (capture !== undefined) {
        // A mid-turn line and a permission question are two things wanting the
        // same one-line editor, and the question is the one with a turn
        // waiting on its answer. The fragment goes — while the stream is still
        // muted, so its abandoning writes nothing — and the question opens on
        // an empty buffer instead of on somebody's half-typed sentence.
        abandonLine();
        resetLineModel();
        options.onPendingChange?.();
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
      // A reverse-i-search left open would keep its own keypress listener on
      // the stream while somebody else owns it: close it first, restoring the
      // ordinary listener arrangement the suspension below starts from.
      leaveSearch(undefined);
      // The terminal is about to belong to someone else (a select prompt, a
      // browser login): take the whole band off the screen first, and stay
      // quiet even though our keypress listener still hears their keystrokes.
      eraseBelow();
      closeBand(false);
      suspended = true;
      // `rl.pause()` alone is not enough to make readline deaf: pausing only
      // stops the *stream*, and the new owner (a select prompt) resumes it —
      // after which every one of their keystrokes still reached readline's own
      // keypress listener. An arrow then walked this editor's history and an
      // Enter delivered the recalled line to `deliverCaptured`, which is how
      // answering the `/config` wizard used to queue a ghost `/config` that
      // re-ran the wizard the moment it finished. Lifting readline's listener
      // off the stream for the duration — the same detach reverse-i-search
      // uses — is what actually hands the keyboard over.
      suspendReadlineKeypress();
      rl.pause();
      input.setRawMode?.(false);
      try {
        return await fn();
      } finally {
        const isTty = (options.input as unknown as { isTTY?: boolean }).isTTY;
        input.setRawMode?.(wasRaw || isTty === true);
        resumeReadlineKeypress();
        rl.resume();
        suspended = false;
        if (readPending !== undefined) {
          // Reopened, not restored: whatever the other consumer left on screen
          // is where the band goes now, and it is drawn from scratch there.
          openBand();
          rl.setPrompt(readPending.promptText);
          rl.prompt(true);
          renderBelow();
        }
      }
    },

    close(): void {
      if (closed) return;
      rl.close();
    },
  };
}
