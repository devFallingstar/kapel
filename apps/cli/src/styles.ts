/**
 * The REPL's one style system.
 *
 * Every escape sequence the interactive shell writes comes from here, so that
 * "what does a tool line look like" is answered in exactly one place instead
 * of being re-decided next to each `write`. Callers never name an SGR code;
 * they name a *role* — who is speaking — and this module decides what that
 * looks like.
 *
 * The roles, and the reasoning behind the palette:
 *
 * - **user** — the prompt marker, and with it the line the terminal echoed
 *   after it. Bold cyan: the one thing on screen that is not kapel talking,
 *   and the anchor the eye uses to find "where did I ask this".
 * - **agent** — the assistant's own prose. Deliberately *unstyled*: it is the
 *   content, everything else is furniture, and furniture is what gets colour.
 * - **tool** — the machine's trace: `→ read_file …`, the `✓`/`✗` under it,
 *   task and validation lifecycle, the status line. Dim, because it is worth
 *   glancing at and never worth reading.
 * - **notice** — kapel's own voice: "resumed …", "model switched …", the
 *   banner hints. Dim magenta, so a remark about the session is never mistaken
 *   for the trace of a tool that ran.
 * - **heading** — a table's header row, a section title. Bold; bodies stay
 *   plain, so the header is the only thing the eye has to skip.
 * - **ok / warn / error** — green, yellow, red, consistently and nowhere else.
 *
 * There are no background colours: a background that reads on a dark terminal
 * is a smear on a light one, and the gutter-plus-weight approach needs none.
 *
 * Colour is off unless the stream is a terminal *and* `NO_COLOR` is unset —
 * see {@link colorEnabled}. A piped, redirected or `NO_COLOR=1` run gets the
 * same bytes it would have got before this module existed.
 */

export type StyleRole =
  | "user"
  | "agent"
  | "tool"
  | "notice"
  | "heading"
  | "ok"
  | "warn"
  | "error";

/**
 * The SGR parameters behind each role. Exported so the few renderers that
 * compose their own escapes (the dashboard measures plain text and styles
 * afterwards) can still take their codes from here rather than keep a second
 * opinion about what "dim" means.
 */
export const ROLE_SGR: Record<StyleRole, string> = {
  user: "1;36",
  // The content, not the frame: no escape at all.
  agent: "",
  tool: "2",
  notice: "2;35",
  heading: "1",
  ok: "32",
  warn: "33",
  error: "31",
};

/**
 * Wraps `text` in an SGR escape when `enabled`, and returns it untouched when
 * not — the one place in the CLI that decides whether a stream gets control
 * characters at all.
 *
 * An empty `code` is the identity, which is what makes the unstyled `agent`
 * role expressible as a role rather than as an exception at every call site.
 * So is empty `text`: a blank line is a blank line, and wrapping one in an
 * escape pair puts control characters on screen to colour nothing at all.
 */
export function ansi(code: string, text: string, enabled: boolean): string {
  if (!enabled || code === "" || text === "") return text;
  return `[${code}m${text}[0m`;
}

/** The role vocabulary, bound to one answer about whether colour is on. */
export interface Styles {
  /** False for a pipe, a redirect, or `NO_COLOR` — every method is then identity. */
  readonly enabled: boolean;
  role(role: StyleRole, text: string): string;
  /** The user's own words: the prompt marker and the line echoed after it. */
  user(text: string): string;
  /** Assistant prose. Identity by design — see the module comment. */
  agent(text: string): string;
  /** Tool calls, task lifecycle, metering: the trace of the machine working. */
  tool(text: string): string;
  /** kapel's own remarks about the session. */
  notice(text: string): string;
  /** A table header or a section title. */
  heading(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  error(text: string): string;
}

export function createStyles(enabled: boolean): Styles {
  const at = (role: StyleRole, text: string): string =>
    ansi(ROLE_SGR[role], text, enabled);
  return {
    enabled,
    role: at,
    user: (text) => at("user", text),
    agent: (text) => at("agent", text),
    tool: (text) => at("tool", text),
    notice: (text) => at("notice", text),
    heading: (text) => at("heading", text),
    ok: (text) => at("ok", text),
    warn: (text) => at("warn", text),
    error: (text) => at("error", text),
  };
}

/**
 * The styles a component uses when nobody told it otherwise.
 *
 * Plain, never coloured: a renderer, a controller or a test that was handed no
 * stream cannot know it is talking to a terminal, and inventing escapes for a
 * stream that may be a file is the one mistake this module exists to prevent.
 */
export const PLAIN_STYLES: Styles = createStyles(false);

/** A writable that may know whether it is a terminal. */
export type ColorStream = { readonly isTTY?: boolean };

/**
 * Whether this stream may be written to in colour.
 *
 * Two independent vetoes, both absolute: a stream that is not a terminal
 * cannot show an escape, and `NO_COLOR` (https://no-color.org — any non-empty
 * value) is a user who has said not to. Neither is a preference this CLI
 * argues with.
 */
export function colorEnabled(
  stream: ColorStream | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (stream?.isTTY !== true) return false;
  const noColor = env.NO_COLOR;
  return noColor === undefined || noColor === "";
}

/** {@link createStyles} over {@link colorEnabled}'s verdict for one stream. */
export function stylesFor(
  stream: ColorStream | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Styles {
  return createStyles(colorEnabled(stream, env));
}
