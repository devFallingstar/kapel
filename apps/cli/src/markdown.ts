import type { Styles } from "./styles.js";

/**
 * Markdown, rendered instead of shown: the assistant writes `**bold**`,
 * headings and `` `code` `` spans, and before this module those markers
 * landed on screen as the literal punctuation. Here they become the styling
 * they meant.
 *
 * Two shapes of caller, one engine. {@link renderMarkdown} formats a complete
 * text (the non-streamed turn, a delegated task's buffered block).
 * {@link createMarkdownStream} formats *deltas* as they stream, which is the
 * part that earns a state machine: a `**` can arrive split across two chunks,
 * so the transformer holds back at most a few ambiguous characters (a
 * trailing `*`, a line-start run of `#` or backticks) and emits everything
 * else the moment it arrives — streaming stays streaming.
 *
 * What is rendered, deliberately small:
 *
 * - `**bold**` (and `__bold__`) — SGR bold, the markers swallowed.
 * - `` `code` `` — the accent colour, markers swallowed. Inside a span the
 *   other markers are literal, exactly as markdown reads them.
 * - `# Heading` (1–6 `#`, at line start) — the whole line bold, the marker
 *   swallowed.
 * - ``` fences — the fence lines themselves are dimmed; everything between
 *   them is verbatim, no inline rendering at all.
 *
 * Everything else passes through untouched. Single `*`/`_` italics are left
 * alone on purpose: `2*3` and `snake_case` are prose, and eagerly styling
 * them mangles more text than it helps. Every open style is closed at each
 * newline — markdown emphasis does not span lines, and an unmatched marker
 * must never bleed bold into the rest of the transcript.
 *
 * With colour off ({@link Styles.enabled} false — a pipe, `NO_COLOR`), both
 * entry points are the identity: a transcript that cannot show bold keeps the
 * markers, which at least still *say* what they meant.
 */

export interface MarkdownStream {
  /** Formats one streamed chunk; may hold back a few trailing characters. */
  push(text: string): string;
  /** Emits whatever was held, closes any open style, resets for a new text. */
  flush(): string;
}

const RESET = "[0m";

/** How many `#` may open a heading — markdown's own limit. */
const MAX_HEADING = 6;

export function createMarkdownStream(styles: Styles): MarkdownStream {
  if (!styles.enabled) {
    return {
      push: (text: string): string => text,
      flush: (): string => "",
    };
  }

  const boldOn = "[1m";
  const codeOn = `[${styles.sgr.accent}m`;
  const dimOn = "[2m";

  /** Held tail: an unresolved marker, or an undecided line-start run. */
  let pending = "";
  let atLineStart = true;
  /** Inline `**` span open. */
  let bold = false;
  /** Inline backtick span open. */
  let code = false;
  /** This line is a heading: bold to its end. */
  let heading = false;
  /** Between a ``` fence pair: no inline rendering at all. */
  let fence = false;
  /** On a fence's own line (the ``` and its info string): dimmed. */
  let fenceLine = false;

  /** The styles active right now, as the escape that turns them on. */
  const activeOn = (): string => {
    const parts: string[] = [];
    if (heading || bold) parts.push(boldOn);
    if (code) parts.push(codeOn);
    if (fenceLine) parts.push(dimOn);
    return parts.join("");
  };

  const anyActive = (): boolean => heading || bold || code || fenceLine;

  /** Re-emits the style state after a toggle: full reset, then what is on. */
  const restyle = (): string => `${RESET}${activeOn()}`;

  /** Ends the line: every style closes, the next char starts a line. */
  const endLine = (): string => {
    const out = anyActive() ? RESET : "";
    bold = false;
    code = false;
    heading = false;
    if (fenceLine) {
      fenceLine = false;
      fence = !fence;
    }
    atLineStart = true;
    return out;
  };

  const push = (text: string): string => {
    const buf = pending + text;
    pending = "";
    let out = "";
    let i = 0;

    while (i < buf.length) {
      const char = buf[i] as string;

      if (char === "\n") {
        out += `${endLine()}\n`;
        i += 1;
        continue;
      }

      // A fence's own line: dimmed verbatim until the newline above ends it.
      if (fenceLine) {
        out += char;
        i += 1;
        continue;
      }

      if (atLineStart && !code) {
        // A line-start run of backticks may be a fence; of `#`, a heading.
        // Both need the character after the run to decide, so an unfinished
        // run at the end of the chunk is held for the next one.
        if (char === "`" || (char === "#" && !fence)) {
          let run = i;
          while (run < buf.length && buf[run] === char) run += 1;
          const length = run - i;
          if (run === buf.length && length <= MAX_HEADING) {
            pending = buf.slice(i);
            return out;
          }
          if (char === "`" && length >= 3) {
            // Nothing is active at a line start (`endLine` closed it all),
            // so the dim can open bare.
            fenceLine = true;
            out += `${dimOn}${buf.slice(i, run)}`;
            atLineStart = false;
            i = run;
            continue;
          }
          if (
            char === "#" &&
            length <= MAX_HEADING &&
            buf[run] === " " &&
            !fence
          ) {
            heading = true;
            out += restyle();
            atLineStart = false;
            i = run + 1;
            continue;
          }
          // Not a fence and not a heading: the run is ordinary text.
          atLineStart = false;
          if (char === "#") {
            out += buf.slice(i, run);
            i = run;
            continue;
          }
          // Backticks fall through to the inline handling below.
        }
        atLineStart = false;
        continue;
      }

      // Fence content: verbatim, nothing toggles but the closing fence.
      if (fence) {
        out += char;
        i += 1;
        continue;
      }

      if (char === "`") {
        code = !code;
        out += restyle();
        i += 1;
        continue;
      }

      if ((char === "*" || char === "_") && !code) {
        if (i + 1 === buf.length) {
          // `*` at the edge of the chunk: `**` may be arriving in halves.
          pending = char;
          return out;
        }
        if (buf[i + 1] === char) {
          bold = !bold;
          out += restyle();
          i += 2;
          continue;
        }
        out += char;
        i += 1;
        continue;
      }

      out += char;
      i += 1;
    }

    return out;
  };

  const flush = (): string => {
    // Whatever was held is literal now: no continuation is coming to turn it
    // into a marker.
    let out = pending;
    pending = "";
    if (anyActive()) out += RESET;
    bold = false;
    code = false;
    heading = false;
    fenceLine = false;
    fence = false;
    atLineStart = true;
    return out;
  };

  return { push, flush };
}

/** {@link createMarkdownStream} over one complete text. */
export function renderMarkdown(text: string, styles: Styles): string {
  if (!styles.enabled) return text;
  const stream = createMarkdownStream(styles);
  return stream.push(text) + stream.flush();
}
