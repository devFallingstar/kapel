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
 * - **accent** — kapel's own colour, and the one the *drawn* chrome wears: the
 *   dashboard's box, the caret of a picker, the bar down the side of a notice.
 *   A muted sky blue (#7EB6D9) rather than a vivid cyan, because furniture
 *   that shouts is furniture you end up reading. See {@link accentSgr} for how
 *   it degrades on terminals that cannot show it.
 * - **chrome** — the two rules that bound the input band at the foot of the
 *   screen. A soft white (xterm-256 grey 245) rather than the accent: the band
 *   is where *you* are, and painting its edges in kapel's own colour made the
 *   prompt read as one more thing kapel had drawn. It is the quietest visible
 *   line the palette has — present enough to close the box, dim enough that
 *   the eye goes to what is inside it. See {@link chromeSgr}.
 * - **echo** — the gray bar a submitted message becomes on its way into the
 *   transcript. A background, uniquely in this palette (see the note below),
 *   because that is the one treatment that survives being scrolled past: the
 *   message you sent is the landmark you scan for, and a bar finds the eye
 *   where a coloured glyph does not. See {@link echoSgr}.
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
 * There is exactly one background colour, **echo**, and it is the exception
 * that states the rule: a background that reads on a dark terminal is a smear
 * on a light one, so everything else here uses a gutter, a weight or a hue
 * instead. The echo bar earns it because it is not decoration — it is the only
 * mark that says "this row is yours, not kapel's" in a transcript the user
 * scrolls back through.
 *
 * Colour is off unless the stream is a terminal *and* `NO_COLOR` is unset —
 * see {@link colorEnabled}. A piped, redirected or `NO_COLOR=1` run gets the
 * same bytes it would have got before this module existed.
 */

export type StyleRole =
  | "accent"
  | "chrome"
  | "echo"
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

/** xterm-256 grey 245 — the soft white the input band's rules are drawn in. */
export const CHROME_256 = "38;5;245";
/** Plain white. The only light neutral a 16-colour terminal is sure to have. */
export const CHROME_BASIC = "37";

/**
 * The chrome's SGR parameters for one terminal, in two tiers.
 *
 * Unlike {@link accentSgr} there is no 24-bit tier to want: grey 245 *is* the
 * colour, and a terminal that can show 16.7M colours can certainly show the
 * 256-colour cube. What is left is the same veto the accent has — a terminal
 * that never claimed 256 colours gets the white that has always existed rather
 * than an escape it would print as text.
 */
export function chromeSgr(env: AccentEnv = process.env): string {
  return has256Colors(env) ? CHROME_256 : CHROME_BASIC;
}

/** xterm-256 grey 237 — the background a submitted message is echoed on. */
export const ECHO_256 = "48;5;237";
/**
 * aixterm's bright-black background. A single SGR parameter, so a terminal
 * that does not know it *ignores* it (unlike the multi-parameter 24-bit form,
 * which gets misparsed onto the screen) — the bar then simply has no bar, and
 * the `> message` inside it still reads.
 */
export const ECHO_BASIC = "100";

/** See {@link chromeSgr}; the echo bar degrades on the same terminal capability. */
export function echoSgr(env: AccentEnv = process.env): string {
  return has256Colors(env) ? ECHO_256 : ECHO_BASIC;
}

/** Whether this terminal has said it can address the 256-colour cube. */
function has256Colors(env: AccentEnv): boolean {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return true;
  return (env.TERM ?? "").includes("256color");
}

/** The bar kapel's own remarks are written behind. See the module comment. */
export const NOTICE_GUTTER = "▌ ";

/** The character every rule in this CLI is made of. */
export const RULE_CHAR = "─";

/** The roles whose codes no terminal capability can change. */
const FIXED_SGR: Record<
  Exclude<StyleRole, "accent" | "user" | "chrome" | "echo">,
  string
> = {
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
  return {
    ...FIXED_SGR,
    accent,
    user: `1;${accent}`,
    chrome: chromeSgr(env),
    echo: echoSgr(env),
  };
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
  /** kapel's own colour: the drawn chrome, and nothing that is content. */
  accent(text: string): string;
  /**
   * A horizontal rule `columns` cells wide, in the soft white the input band
   * is bounded with.
   *
   * Structure, not colour: `NO_COLOR` strips the escape and keeps the `─`
   * characters, because a rule is what tells you where the band you type in
   * begins and ends, and a user who asked for no colour did not ask to be
   * left guessing. A stream that is not a terminal never asks for one at all —
   * the band is a painted object, and nothing paints onto a pipe.
   *
   * One cell short of the width it is given, always. A row that exactly fills
   * a terminal wraps, and a wrapped rule is a second row nobody counted.
   */
  rule(columns: number): string;
  /**
   * One row of the gray bar a submitted message becomes. The caller pads the
   * text to the width it wants the bar to be *before* calling: measuring a
   * string that already carries escapes is how a bar ends up ragged.
   */
  echo(text: string): string;
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
    rule: (columns) => at("chrome", RULE_CHAR.repeat(Math.max(0, columns - 1))),
    echo: (text) => at("echo", text),
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
