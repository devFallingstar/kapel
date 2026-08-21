/**
 * The input band: the soft-white-ruled block that sits at the foot of an
 * interactive `kapel` session, and the gray bar a submitted message turns into
 * on its way past it into the transcript.
 *
 * ```
 *   ╭─ kapel v0.12.0 ────────────────────────╮      ← the dashboard, printed once
 *   │ …                                      │
 *   ╰────────────────────────────────────────╯
 *
 *   > what changed in render.ts?                    ← the echo of a sent message
 *   The renderer now …                              ← the transcript, flowing
 *   ──────────────────────────────────────────      ← the band's upper rule
 *   how about status-line.ts?▏                      ← the line being typed
 *   ──────────────────────────────────────────      ← the band's lower rule
 * ```
 *
 * The band is *painted*, not printed: it is written after whatever output came
 * last, erased before the next output is written, and painted again underneath
 * it — the same discipline the status line has always used (see
 * `status-line.ts`), just three rows tall instead of one. That is what keeps
 * the transcript flowing between the dashboard and the band without a scroll
 * region: the transcript is ordinary scrollback, and the band is simply always
 * the last thing on the screen.
 *
 * Everything in this module is pure. The band's *rows* are decided here; where
 * they go on screen is decided in `input.ts` (at the prompt, where `readline`
 * owns the middle row) and in `status-line.ts` (during a turn, where the middle
 * row is the spinner). Both take their strings from {@link BandDecor}.
 */

import { type Styles, stylesFor } from "./styles.js";

/** Fallback width for a terminal that reports none. */
export const DEFAULT_BAND_COLUMNS = 80;

/** The marker the first row of an echoed message carries. */
export const ECHO_MARKER = "> ";

/** What the continuation rows of a multi-row echo carry instead. */
const ECHO_CONTINUATION = "  ";

// --- Display width -----------------------------------------------------------

/**
 * Codepoint ranges that occupy two terminal cells, per Unicode's East Asian
 * Width property (`W` and `F`) plus the emoji blocks every terminal in
 * practice draws double-wide.
 *
 * This is the short, boring list rather than a generated table: the band uses
 * it to decide how much padding a gray bar needs and where to fold a long
 * message, so being wrong costs a ragged bar — never a corrupted band, which
 * is a property of `input.ts`'s geometry and not of this function.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Kana, Hangul Compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6b], // CJK compatibility forms
  [0xff01, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji: symbols and pictographs, emoticons
  [0x1f900, 0x1f9ff], // Emoji: supplemental symbols
  [0x20000, 0x3fffd], // CJK Extension B and beyond
];

/** Zero-width: combining marks, and the joiners emoji sequences are built of. */
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // Combining diacriticals
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // Zero-width space … RTL mark
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], // Variation selectors
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], // BOM
];

function inRanges(
  code: number,
  ranges: readonly (readonly [number, number])[],
): boolean {
  for (const [low, high] of ranges) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

/** How many terminal cells one codepoint takes: 0, 1 or 2. */
export function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (inRanges(code, ZERO_RANGES)) return 0;
  return inRanges(code, WIDE_RANGES) ? 2 : 1;
}

/**
 * How many terminal cells `text` takes, counting nothing for the SGR escapes
 * a styled string carries.
 *
 * `[...text]` rather than `text.length`, so an astral codepoint (every emoji
 * above U+FFFF) is one character and not two halves of a surrogate pair.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripEscapes(text)) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

const ESC = "\u001B";
const BEL = "\u0007";

/**
 * The three escape shapes a styled string can carry: a CSI sequence (what
 * every colour in this CLI is), an OSC string (a hyperlink, a window title),
 * and the bare two-character `ESC <char>` forms.
 *
 * Built with `new RegExp` rather than written as literals so the escape
 * characters live in named constants instead of inside a pattern, where they
 * are both unreadable and — quite reasonably — linted against.
 */
const ESCAPE_PATTERNS: readonly RegExp[] = [
  new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"),
  new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, "g"),
  new RegExp(`${ESC}[@-Z\\\\-_]`, "g"),
];

/**
 * `text` with every escape sequence removed. Used only to *measure* — nothing
 * this module puts on screen is ever rewritten, so a message that contains an
 * escape is sent, echoed and displayed exactly as it was typed.
 */
export function stripEscapes(text: string): string {
  let out = text;
  for (const pattern of ESCAPE_PATTERNS) out = out.replace(pattern, "");
  return out;
}

/**
 * `text` folded into rows no wider than `width` cells, breaking at spaces
 * where one is close enough to the edge to be worth using and mid-word where
 * it is not.
 *
 * An empty string folds to one empty row, not to none: a blank line inside a
 * pasted message is part of the message, and a gray bar that silently dropped
 * it would be reporting something the user did not send.
 */
export function foldToWidth(text: string, width: number): readonly string[] {
  const limit = Math.max(1, width);
  const chars = [...text];
  if (chars.length === 0) return [""];

  const rows: string[] = [];
  let row = "";
  let used = 0;
  /** Where the last space in `row` is, so a fold can back up onto it. */
  let lastSpace = -1;

  const flush = (upTo?: number): void => {
    if (upTo === undefined) {
      rows.push(row);
      row = "";
      used = 0;
      lastSpace = -1;
      return;
    }
    const head = row.slice(0, upTo);
    const tail = row.slice(upTo + 1);
    rows.push(head);
    row = tail;
    used = displayWidth(tail);
    lastSpace = -1;
  };

  for (const char of chars) {
    const cells = charWidth(char.codePointAt(0) ?? 0);
    if (used + cells > limit) {
      // Back up onto a space only when it is in the last third of the row:
      // further back than that and the fold leaves a gap wide enough to read
      // as an intentional break in the message.
      if (
        lastSpace >= 0 &&
        displayWidth(row.slice(0, lastSpace)) * 3 > limit * 2
      ) {
        flush(lastSpace);
      } else {
        flush();
      }
    }
    if (char === " ") lastSpace = row.length;
    row += char;
    used += cells;
  }
  rows.push(row);
  return rows;
}

// --- The band's strings ------------------------------------------------------

/**
 * The strings the band is painted from, bound to one palette and one terminal.
 *
 * An object rather than three loose functions because both painters — the
 * prompt's in `input.ts` and the turn's in `status-line.ts` — need the same
 * rule, and a band whose two rules came from two decisions would eventually
 * have two different rules.
 */
export interface BandDecor {
  /** One rule row, one cell short of `columns`. See `Styles.rule`. */
  rule(columns: number): string;
  /**
   * A submitted message as transcript rows: a gray bar per row, or the plain
   * `> message` form when this palette paints no colour.
   */
  echo(message: string, columns: number): readonly string[];
}

/**
 * The gray bar a sent message becomes, one string per screen row.
 *
 * Three things this deliberately does *not* do. It never erases anything —
 * these rows are appended into the scrollback like any other output, so a
 * message that scrolls past stays legible forever. It never interprets the
 * message — the text may contain anything at all, including escape sequences
 * someone pasted, and what goes on screen is the text with this palette's
 * escapes around it and no others (see {@link stripEscapes}, which is used to
 * *measure*, never to rewrite). And it never lets a bar reach the terminal's
 * last column: a row that exactly fills the width wraps, and half a gray bar
 * on a row of its own is worse than a bar one cell short.
 *
 * Off a coloured palette the bar is simply `> message`, which is what a
 * `NO_COLOR` run and a piped transcript have always looked like.
 */
export function echoRows(
  message: string,
  columns: number,
  styles: Styles,
): readonly string[] {
  const lines = message.split("\n");
  if (!styles.enabled) {
    return lines.map((line, index) =>
      index === 0 ? `${ECHO_MARKER}${line}` : `${ECHO_CONTINUATION}${line}`,
    );
  }

  const width = Math.max(1, columns - 1);
  const inner = Math.max(1, width - ECHO_MARKER.length);
  const rows: string[] = [];
  for (const line of lines) {
    for (const folded of foldToWidth(line, inner)) {
      const marker = rows.length === 0 ? ECHO_MARKER : ECHO_CONTINUATION;
      const text = `${marker}${folded}`;
      const pad = Math.max(0, width - displayWidth(text));
      rows.push(styles.echo(text + " ".repeat(pad)));
    }
  }
  return rows;
}

/** {@link BandDecor} over one palette. */
export function createBandDecor(styles: Styles): BandDecor {
  return {
    rule: (columns) => styles.rule(columns),
    echo: (message, columns) => echoRows(message, columns, styles),
  };
}

/** {@link createBandDecor} for whatever `stream` and the environment allow. */
export function bandDecorFor(
  stream: { readonly isTTY?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BandDecor {
  return createBandDecor(stylesFor(stream, env));
}
