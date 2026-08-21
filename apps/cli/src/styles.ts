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
 * - **accent** — kapel's own colour, and the only one the *chrome* wears: the
 *   dashboard's box, the rule above the prompt, the bar down the side of a
 *   notice. A muted sky blue (#7EB6D9) rather than a vivid cyan, because
 *   furniture that shouts is furniture you end up reading. See
 *   {@link accentSgr} for how it degrades on terminals that cannot show it.
 * - **user** — the prompt marker, and with it the line the terminal echoed
 *   after it. The accent, in bold: the one thing on screen that is not kapel
 *   talking, and the anchor the eye uses to find "where did I ask this". It
 *   shares the accent's hue on purpose — the gutter you type at and the frame
 *   you type inside are one object, and two colours would make them two.
 * - **agent** — the assistant's own prose. Deliberately *unstyled*: it is the
 *   content, everything else is furniture, and furniture is what gets colour.
 * - **tool** — the machine's trace: `→ read_file …`, the `✓`/`✗` under it,
 *   task and validation lifecycle, the status line. Dim, because it is worth
 *   glancing at and never worth reading.
 * - **notice** — kapel's own voice: "resumed …", "model switched …", the
 *   banner hints. Dim text behind an accent bar (`▌ `, see
 *   {@link NOTICE_GUTTER}), so a remark about the session is never mistaken
 *   for the trace of a tool that ran. The bar, not a hue, is what carries the
 *   identity: it survives being read at a glance, it groups the lines of a
 *   multi-line notice into one block the way no colour can, and it leaves the
 *   line's *text* free to stay quiet — a remark about the session should
 *   recede exactly as far as a tool trace does, and only be findable faster.
 * - **heading** — a table's header row, a section title. Bold; bodies stay
 *   plain, so the header is the only thing the eye has to skip.
 * - **menu** — the rows of a completion menu drawn under the prompt: the live
 *   `/` command list. Dim, because a menu is scaffolding around the line being
 *   typed rather than something the session said — and because the one part of
 *   each row that is *not* dim is the prefix the user has already typed, which
 *   wears **user** like every other echo of their own words. It shares dim
 *   with **tool** today and still gets its own name: a menu is not a trace,
 *   and the two should be able to part ways without hunting call sites.
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
  | "accent"
  | "user"
  | "agent"
  | "tool"
  | "notice"
  | "heading"
  | "menu"
  | "ok"
  | "warn"
  | "error";

/** #7EB6D9, exactly, on a terminal that can address 16.7M colours. */
export const ACCENT_TRUECOLOR = "38;2;126;182;217";
/** xterm-256 colour 110 — the nearest muted sky blue in the cube. */
export const ACCENT_256 = "38;5;110";
/** Plain cyan. Brighter than intended, but the only blue guaranteed to exist. */
export const ACCENT_BASIC = "36";

/** The environment variables {@link accentSgr} reads. */
export type AccentEnv = {
  readonly COLORTERM?: string | undefined;
  readonly TERM?: string | undefined;
};

/**
 * The accent's SGR parameters for one terminal, in three tiers.
 *
 * A 24-bit escape sent to a terminal that only understands 256 colours is not
 * ignored — it is *misparsed*, and what lands on screen is the tail of the
 * escape as text. So the exact colour is claimed only where the terminal has
 * said it can show one (`COLORTERM=truecolor` or `24bit`, the de-facto
 * signal), approximated where `TERM` names a 256-colour type, and given up on
 * everywhere else in favour of the cyan that every terminal since the 1970s
 * has had.
 */
export function accentSgr(env: AccentEnv = process.env): string {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") {
    return ACCENT_TRUECOLOR;
  }
  return (env.TERM ?? "").includes("256color") ? ACCENT_256 : ACCENT_BASIC;
}

/** The bar kapel's own remarks are written behind. See the module comment. */
export const NOTICE_GUTTER = "▌ ";

/** The roles whose codes no terminal capability can change. */
const FIXED_SGR: Record<Exclude<StyleRole, "accent" | "user">, string> = {
  // The content, not the frame: no escape at all.
  agent: "",
  tool: "2",
  notice: "2",
  heading: "1",
  menu: "2",
  ok: "32",
  warn: "33",
  error: "31",
};

/**
 * The SGR parameters behind each role on one terminal. Exported so the few
 * renderers that compose their own escapes (the dashboard measures plain text
 * and styles afterwards) can still take their codes from here rather than keep
 * a second opinion about what "dim" means.
 */
export function roleSgr(
  env: AccentEnv = process.env,
): Record<StyleRole, string> {
  const accent = accentSgr(env);
  return { ...FIXED_SGR, accent, user: `1;${accent}` };
}

/**
 * {@link roleSgr} for the environment this process was started in — the answer
 * every caller that has no particular terminal in mind wants. Environment
 * variables do not change under a running process, so reading them once here
 * is a snapshot of a constant.
 */
export const ROLE_SGR: Record<StyleRole, string> = roleSgr();

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
  /**
   * This palette's codes, for the renderers that compose their own escapes
   * around text they have already measured (the dashboard's box). Reading them
   * from here rather than from {@link ROLE_SGR} is what keeps a component
   * handed a palette for *another* terminal from painting in this one's accent.
   */
  readonly sgr: Record<StyleRole, string>;
  role(role: StyleRole, text: string): string;
  /** kapel's own colour: the chrome, and nothing that is content. */
  accent(text: string): string;
  /**
   * A horizontal rule `columns` cells wide, in the accent — the line above the
   * prompt. Empty when colour is off: a rule is chrome, and chrome is the
   * first thing `NO_COLOR` and a pipe are promised they will not see.
   *
   * One cell short of the width it is given, always. A row that exactly fills
   * a terminal wraps, and a wrapped rule is a second row nobody counted.
   */
  rule(columns: number): string;
  /** The user's own words: the prompt marker and the line echoed after it. */
  user(text: string): string;
  /** Assistant prose. Identity by design — see the module comment. */
  agent(text: string): string;
  /** Tool calls, task lifecycle, metering: the trace of the machine working. */
  tool(text: string): string;
  /**
   * kapel's own remarks about the session, behind their accent bar. One call
   * per line, so a multi-line notice reads as one block with a bar down it.
   */
  notice(text: string): string;
  /** A table header or a section title. */
  heading(text: string): string;
  /** A completion-menu row under the prompt — see the module comment. */
  menu(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  error(text: string): string;
}

export function createStyles(
  enabled: boolean,
  env: AccentEnv = process.env,
): Styles {
  const sgr = roleSgr(env);
  const at = (role: StyleRole, text: string): string =>
    ansi(sgr[role], text, enabled);
  /**
   * The bar goes on styled lines only — off a terminal a notice is plain text
   * like everything else — and never on a blank one: a bar with nothing after
   * it is two cells of furniture holding up no content.
   */
  const notice = (text: string): string =>
    enabled && text !== ""
      ? `${at("accent", NOTICE_GUTTER)}${at("notice", text)}`
      : at("notice", text);
  return {
    enabled,
    sgr,
    // `notice` is the one role whose rendering is more than its escape, so
    // `role()` routes through it rather than re-deciding: the two can never
    // disagree about what a notice looks like.
    role: (role, text) => (role === "notice" ? notice(text) : at(role, text)),
    accent: (text) => at("accent", text),
    rule: (columns) =>
      enabled ? at("accent", "─".repeat(Math.max(0, columns - 1))) : "",
    user: (text) => at("user", text),
    agent: (text) => at("agent", text),
    tool: (text) => at("tool", text),
    notice,
    heading: (text) => at("heading", text),
    menu: (text) => at("menu", text),
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
  return createStyles(colorEnabled(stream, env), env);
}
