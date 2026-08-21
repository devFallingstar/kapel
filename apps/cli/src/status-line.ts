/**
 * The one-line, self-updating progress indicator the text renderer shows while
 * a turn is running and nothing else is being printed.
 *
 * It exists because a model can think for tens of seconds with nothing to say
 * yet, and a screen that shows nothing at all is indistinguishable from a
 * hung process. The line is deliberately *one* line, rewritten in place with a
 * carriage return, so it costs no scrollback: whatever the run actually
 * produces still reads as a clean transcript afterwards.
 *
 * Two rules keep it honest:
 *
 * - **A TTY or nothing.** Every method is a no-op when the output stream is
 *   not a terminal, so a pipe, a redirect or a CI log never sees `\r`, an ANSI
 *   escape or a spinner frame. There is no flag for this — a stream that
 *   cannot show a moving line does not get one.
 * - **Erase before anything real.** The line owns the cursor's current row and
 *   nothing else; the renderer erases it before writing a single character of
 *   actual output, and repaints afterwards.
 */

import { type Styles, stylesFor } from "./styles.js";

/** Braille spinner frames. Every one of them is a single cell wide. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How often the spinner advances. Fast enough to look alive, slow enough to be cheap. */
const TICK_MS = 120;

/** Carriage return plus "erase the whole line" — leaves the cursor at column 0. */
const ERASE = "\r[2K";

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
): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const parts = [`${label} ${seconds}s`];
  if (tokens !== undefined && tokens > 0) {
    parts.push(`${formatTokenCount(tokens)} tokens`);
  }
  return parts.join(" · ");
}

export class StatusLine {
  readonly #output: StatusLineStream;
  readonly #enabled: boolean;
  readonly #now: () => number;
  readonly #tokens: (() => number | undefined) | undefined;
  readonly #suspended: () => boolean;
  readonly #ticker: (tick: () => void) => () => void;
  readonly #styles: Styles;

  #cancel: (() => void) | undefined;
  #label = "";
  #startedAt = 0;
  #frame = 0;
  #painted = false;

  constructor(options: StatusLineOptions = {}) {
    this.#output = options.output ?? process.stdout;
    this.#enabled = options.tty ?? this.#output.isTTY === true;
    this.#now = options.now ?? (() => Date.now());
    this.#tokens = options.tokens;
    this.#suspended = options.suspended ?? (() => false);
    this.#ticker = options.ticker ?? defaultTicker;
    this.#styles = options.styles ?? stylesFor(this.#output);
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
    if (this.#cancel === undefined) {
      this.#startedAt = this.#now();
      this.#frame = 0;
      this.#cancel = this.#ticker(() => {
        this.#frame += 1;
        this.#paint();
      });
    }
    this.#paint();
  }

  /**
   * Erases the painted line but keeps the status running: the next tick (or
   * {@link refresh}) puts it back. This is what the renderer calls before
   * writing real output.
   */
  erase(): void {
    if (!this.#painted) return;
    this.#painted = false;
    this.#output.write(ERASE);
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

    const frame = FRAMES[this.#frame % FRAMES.length] ?? FRAMES[0];
    const status = formatStatus(
      this.#label,
      this.#now() - this.#startedAt,
      this.#tokens?.(),
    );
    const columns = this.#output.columns ?? DEFAULT_COLUMNS;
    // One column short of the edge: a line that exactly fills the terminal
    // wraps, and a wrapped line is one `\r` can no longer erase.
    const text = `${frame} ${status}`.slice(0, Math.max(1, columns - 1));

    this.#output.write(`${ERASE}${this.#styles.tool(text)}`);
    this.#painted = true;
  }
}
