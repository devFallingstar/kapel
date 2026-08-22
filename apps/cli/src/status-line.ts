/**
 * The self-updating progress indicator the text renderer shows while a turn is
 * running and nothing else is being printed.
 *
 * It exists because a model can think for tens of seconds with nothing to say
 * yet, and a screen that shows nothing at all is indistinguishable from a
 * hung process. It is rewritten in place rather than printed, so it costs no
 * scrollback: whatever the run actually produces still reads as a clean
 * transcript afterwards.
 *
 * Two rules keep it honest:
 *
 * - **A TTY or nothing.** Every method is a no-op when the output stream is
 *   not a terminal, so a pipe, a redirect or a CI log never sees `\r`, an ANSI
 *   escape or a spinner frame. There is no flag for this — a stream that
 *   cannot show a moving line does not get one.
 * - **Erase before anything real.** The block owns the rows from the cursor's
 *   current row downwards and nothing else; the renderer erases it before
 *   writing a single character of actual output, and repaints afterwards.
 *
 * ## One line, or the band
 *
 * With no {@link StatusLineOptions.frame} this is exactly what it has always
 * been: one row, `\r`-erased. Given one, it becomes the *turn's* shape of the
 * input band (see `band.ts`) — the same two soft-white rules the prompt sits
 * between, with the spinner where the line being typed goes:
 *
 * ```
 *   ───────────────────────────
 *   ⠹ thinking 4s · 1.2k tokens
 *   ───────────────────────────
 * ```
 *
 * The mechanism is unchanged and that is the point: erase, let the caller
 * print, repaint underneath. More rows than one only changes the arithmetic —
 * the block is painted downwards from the cursor's row and the cursor is
 * walked back up to it, so the next erase starts where this paint did, and the
 * whole band moves down the screen as the transcript grows without a single
 * absolute cursor address being written.
 *
 * ## What goes between the rules
 *
 * Three rows is only the common case. The block paints however many rows it
 * has, tracks the count, and erases exactly that many; two things vary it, and
 * both ride on the same paint rather than on a painter of their own, because
 * one painting authority per screen is the whole discipline this file exists
 * to keep.
 *
 * **Rows the caller owns.** A spinner speaks for one wait, and an
 * orchestration run is several at once: four workers in four worktrees have
 * four things to say and no single label that says them. So the block's
 * content is pluggable — see {@link StatusLineOptions.rows} — and a caller
 * with something better to show than `⠹ thinking 4s` (the per-worker row in
 * `worker-band.ts`) supplies it. Such a block is opened with {@link open}
 * rather than {@link start}: there is no wait to name.
 *
 * **The line being typed into the running turn.** It joins the content rows,
 * under them and inside the band, while the user is mid-sentence:
 *
 * ```
 *   ───────────────────────────
 *   ⠹ thinking 4s · 1 queued
 *   > and check the tests too▏
 *   ───────────────────────────
 * ```
 *
 * That row is drawn here rather than echoed by `readline` for the same reason
 * the content rows are: a second writer into these rows a few times a second
 * is how a status line and a line being typed turn into a smear. See
 * {@link StatusLineOptions.pending}, and {@link StatusLineOptions.queued} for
 * the `N queued` clause that counts the lines it did not steer.
 */

import type { BandDecor } from "./band.js";
import { type Styles, stylesFor } from "./styles.js";

/** Braille spinner frames. Every one of them is a single cell wide. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How often the spinner advances. Fast enough to look alive, slow enough to be cheap. */
const TICK_MS = 120;

/** Carriage return plus "erase the whole line" — leaves the cursor at column 0. */
const ERASE = "\r[2K";

/** Control Sequence Introducer, spelled so no source file carries a raw ESC. */
const CSI = "\u001b[";

/**
 * Carriage return plus "erase from here to the bottom of the screen" — what a
 * block taller than one row needs. It leaves the cursor exactly where
 * {@link ERASE} leaves it, which is what lets the two share every call site.
 */
const ERASE_BLOCK = `\r${CSI}0J`;

/** Fallback width when the stream does not report one. */
const DEFAULT_COLUMNS = 80;

/** A writable that may know it is a terminal, and how wide it is. */
export type StatusLineStream = NodeJS.WritableStream & {
  readonly isTTY?: boolean;
  readonly columns?: number;
};

export interface StatusLineOptions {
  /** Where the line is painted. Defaults to `process.stdout`. */
  readonly output?: StatusLineStream;
  /**
   * Overrides the TTY probe. Only tests should pass this: production code
   * lets the stream answer for itself.
   */
  readonly tty?: boolean;
  readonly now?: () => number;
  /**
   * Cumulative tokens for the run so far. `undefined` or `0` drops the clause
   * entirely, so a backend that reports usage only at the end shows no number
   * rather than a misleading zero.
   */
  readonly tokens?: () => number | undefined;
  /**
   * While this returns `true` the line stays erased — something else owns the
   * screen, e.g. a permission question waiting for a keypress.
   */
  readonly suspended?: () => boolean;
  /**
   * The role palette the line paints itself with. Defaults to whatever
   * `output` and the environment allow; `NO_COLOR` costs the dimming, never
   * the line itself — a spinner is progress, not decoration.
   */
  readonly styles?: Styles;
  /**
   * Starts the repaint timer and returns its canceller. Defaults to an
   * unref'd `setInterval`, so a spinner never keeps the process alive.
   * Injected by tests to keep painting deterministic.
   */
  readonly ticker?: (tick: () => void) => () => void;
  /**
   * The rules to bound the status with, turning it into the turn's shape of
   * the input band — see the module comment. Absent (the default, and the only
   * thing every non-REPL caller wants) leaves the one-row line untouched: a
   * `kapel run` summary or an orchestration log has no band to be part of.
   */
  readonly frame?: BandDecor;
  /**
   * The block's content rows, in place of the spinner — already styled, and
   * already narrow enough for `columns` (nothing here folds them: a block that
   * silently grew a row would leave the row above it uneraseable).
   *
   * Called on every repaint, so the rows may move on their own between events:
   * that is how a worker row's elapsed seconds tick. Returning an empty array
   * means "nothing to show right now" and leaves the screen clean without
   * ending the block — the next tick puts it back if there is something to say
   * by then.
   */
  readonly rows?: (columns: number) => readonly string[];
  /**
   * The line the user is typing *into* the running turn, as a row of text
   * (see `composePendingRow` in `input.ts`), or `undefined` when they are not
   * typing one.
   *
   * Mid-turn keystrokes are not echoed by `readline` — they would land on
   * whichever row this block happens to be repainting — so the block shows
   * them itself, as a row under whatever it is already reporting. That keeps
   * one painter in charge of these rows, which is the only arrangement in
   * which a spinner and a line being typed can share them without fighting.
   *
   * Unlike {@link rows} this one is folded to fit, from the *end* (see
   * {@link clipToEnd}), because it is a row the user is still writing.
   *
   * Only ever drawn inside a {@link frame}: the typed row is part of the
   * band's shape, and a caller with no band — a `kapel run` summary, an
   * orchestration log — has a single `\r`-erased row and nobody at a prompt to
   * be typing into it.
   */
  readonly pending?: () => string | undefined;
  /**
   * How many lines are waiting to run after this turn — the count `N queued`
   * reports. Zero, or absent, drops the clause entirely.
   */
  readonly queued?: () => number;
}

function defaultTicker(tick: () => void): () => void {
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** `1234` → `1.2k`; anything under a thousand stays exact. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * The text of the status line, without the carriage return or any styling.
 *
 * Exported for tests: this is the part worth asserting on, and it says exactly
 * what the line promises — what is being waited on, for how long, and what the
 * conversation has cost so far.
 */
export function formatStatus(
  label: string,
  elapsedMs: number,
  tokens?: number,
  queued?: number,
): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const parts = [`${label} ${seconds}s`];
  if (tokens !== undefined && tokens > 0) {
    parts.push(`${formatTokenCount(tokens)} tokens`);
  }
  // Last, because it is the only clause that is about the user rather than
  // about the run: it is there to answer "did it take my line?", and it
  // disappears the moment the answer stops mattering.
  if (queued !== undefined && queued > 0) {
    parts.push(`${queued} queued`);
  }
  return parts.join(" · ");
}

/**
 * The widest a row this block may write.
 *
 * One column short of the edge: a line that exactly fills the terminal wraps,
 * and a wrapped line is one `\r` can no longer erase.
 */
function rowWidth(columns: number): number {
  return Math.max(1, columns - 1);
}

/**
 * Clips a row to the width the block may write, keeping its *end*.
 *
 * The status text is clipped from the front like every other line on screen,
 * but the line being typed is not a line being read — the interesting end of
 * it is the one under the caret, and a user whose sentence has outgrown the
 * terminal needs to see what they are typing now, not how it started. The
 * ellipsis says the rest is still there.
 */
export function clipToEnd(text: string, width: number): string {
  const limit = Math.max(1, width);
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - limit + 1)}`;
}

export class StatusLine {
  readonly #output: StatusLineStream;
  readonly #enabled: boolean;
  readonly #now: () => number;
  readonly #tokens: (() => number | undefined) | undefined;
  readonly #suspended: () => boolean;
  readonly #ticker: (tick: () => void) => () => void;
  readonly #styles: Styles;
  readonly #band: BandDecor | undefined;
  readonly #rows: ((columns: number) => readonly string[]) | undefined;
  readonly #pending: (() => string | undefined) | undefined;
  readonly #queued: (() => number) | undefined;

  #cancel: (() => void) | undefined;
  /** The wait being reported, or `undefined` for a block opened without one. */
  #label: string | undefined;
  #startedAt = 0;
  #frame = 0;
  /** How many rows the last paint left on screen; `0` when nothing is up. */
  #paintedRows = 0;

  constructor(options: StatusLineOptions = {}) {
    this.#output = options.output ?? process.stdout;
    this.#enabled = options.tty ?? this.#output.isTTY === true;
    this.#now = options.now ?? (() => Date.now());
    this.#tokens = options.tokens;
    this.#suspended = options.suspended ?? (() => false);
    this.#ticker = options.ticker ?? defaultTicker;
    this.#styles = options.styles ?? stylesFor(this.#output);
    this.#band = options.frame;
    this.#rows = options.rows;
    this.#pending = options.pending;
    this.#queued = options.queued;
  }

  /** Whether this line will ever paint anything — false off a TTY. */
  get enabled(): boolean {
    return this.#enabled;
  }

  /** Whether a status is currently being kept up to date. */
  get running(): boolean {
    return this.#cancel !== undefined;
  }

  /**
   * Starts the status, or relabels a running one.
   *
   * The elapsed clock runs from the *start*, not from each relabel: it is the
   * age of the current wait, and a wait that changes phase (model → tool) is a
   * new wait, so {@link stop} then `start` is how the caller resets it.
   */
  start(label: string): void {
    if (!this.#enabled) return;
    this.#label = label;
    this.#begin();
    this.#paint();
  }

  /**
   * Starts a block with no wait to report: whatever
   * {@link StatusLineOptions.rows} says is the whole of it.
   *
   * The clock still runs and the ticker still repaints, because rows that
   * report on several tasks at once age between events exactly as a spinner
   * does — see `worker-band.ts`, whose seconds tick without an event to
   * prompt them.
   */
  open(): void {
    if (!this.#enabled) return;
    this.#label = undefined;
    this.#begin();
    this.#paint();
  }

  /** Starts the repaint timer, if it is not already running. */
  #begin(): void {
    if (this.#cancel !== undefined) return;
    this.#startedAt = this.#now();
    this.#frame = 0;
    this.#cancel = this.#ticker(() => {
      this.#frame += 1;
      this.#paint();
    });
  }

  /**
   * Erases the painted line but keeps the status running: the next tick (or
   * {@link refresh}) puts it back. This is what the renderer calls before
   * writing real output.
   */
  erase(): void {
    const rows = this.#paintedRows;
    if (rows === 0) return;
    this.#paintedRows = 0;
    if (rows === 1) {
      this.#output.write(ERASE);
      return;
    }
    // The cursor was left on the block's first row by {@link #paint}, so the
    // whole block comes off with one clear-to-bottom and the cursor stays
    // exactly where the caller's next line of output belongs.
    this.#output.write(ERASE_BLOCK);
  }

  /** Repaints immediately, if a status is running. */
  refresh(): void {
    this.#paint();
  }

  /** Ends the status: no more repainting, and nothing left on screen. */
  stop(): void {
    const cancel = this.#cancel;
    this.#cancel = undefined;
    cancel?.();
    this.erase();
  }

  #paint(): void {
    if (!this.#enabled || this.#cancel === undefined) return;
    if (this.#suspended()) {
      this.erase();
      return;
    }

    const columns = this.#output.columns ?? DEFAULT_COLUMNS;
    const content = this.#contentRows(columns);
    if (content.length === 0) {
      // Nothing to say this instant — a block that is running but momentarily
      // empty leaves a clean screen rather than a stale one.
      this.erase();
      return;
    }

    const band = this.#band;
    const rows =
      band === undefined
        ? content
        : [
            band.rule(columns),
            ...content,
            ...this.#typedRow(columns),
            band.rule(columns),
          ];

    if (rows.length === 1) {
      this.#output.write(`${ERASE}${rows[0]}`);
      this.#paintedRows = 1;
      return;
    }

    // `\r\n` rather than `ESC[B` between the rows: the rows under the first
    // one may not exist yet, and a newline is the one thing that makes the
    // terminal scroll them into being. Whatever that scroll moved, it moved
    // the whole block with it, which is why the walk back up is relative and
    // lands where the paint started every time.
    const below = rows.length - 1;
    this.#output.write(`${ERASE_BLOCK}${rows.join("\r\n")}${CSI}${below}A\r`);
    this.#paintedRows = rows.length;
  }

  /**
   * What the block is reporting: the caller's rows when it has any, and
   * otherwise the spinner for the wait {@link start} named.
   *
   * The caller's rows win rather than joining the spinner. A block reports one
   * thing at a time — during an orchestration run the spinner never starts at
   * all (every event carries a task id, so no turn-level wait is ever
   * declared) — and two ideas of "what is happening" stacked on top of each
   * other would be the screen contradicting itself.
   */
  #contentRows(columns: number): readonly string[] {
    const rows = this.#rows?.(columns);
    if (rows !== undefined && rows.length > 0) return rows;

    const label = this.#label;
    if (label === undefined) return [];

    const frame = FRAMES[this.#frame % FRAMES.length] ?? FRAMES[0];
    const status = formatStatus(
      label,
      this.#now() - this.#startedAt,
      this.#tokens?.(),
      this.#queued?.(),
    );
    const text = `${frame} ${status}`.slice(0, rowWidth(columns));
    return [this.#styles.tool(text)];
  }

  /**
   * The line the user is typing, as the band's last row before the closing
   * rule — or nothing at all, which is every case but a REPL mid-turn.
   *
   * A row rather than part of {@link #contentRows} because it is not content:
   * it says nothing about what the block is reporting on, it only shows the
   * user their own keystrokes, and it sits *under* whatever the block has to
   * say so the band still reads with the input at the bottom of it — where the
   * prompt would be if the turn were over. Which also means a block with
   * nothing to report is still off screen: {@link #paint} erases on empty
   * content before it gets here, and a lone typed row hanging between two
   * rules would be a band around no status at all.
   */
  #typedRow(columns: number): readonly string[] {
    const pending = this.#pending?.();
    if (pending === undefined) return [];
    return [this.#styles.user(clipToEnd(pending, rowWidth(columns)))];
  }
}
