import { describe, expect, it } from "vitest";
import { promptMarker } from "../src/interactive.js";
import {
  ACCENT_256,
  ACCENT_BASIC,
  ACCENT_TRUECOLOR,
  accentSgr,
  ansi,
  CHROME_256,
  CHROME_BASIC,
  chromeSgr,
  colorEnabled,
  createStyles,
  ECHO_256,
  ECHO_BASIC,
  echoSgr,
  NOTICE_GUTTER,
  PLAIN_STYLES,
  ROLE_SGR,
  roleSgr,
  type StyleRole,
  stylesFor,
} from "../src/styles.js";

const ESC = "";
const RESET = `${ESC}[0m`;

/** Every role a caller can name. */
const ROLES: readonly StyleRole[] = [
  "accent",
  "chrome",
  "echo",
  "user",
  "agent",
  "tool",
  "notice",
  "heading",
  "menu",
  "ok",
  "warn",
  "error",
];

/** A terminal that can show the accent exactly. */
const TRUECOLOR = { COLORTERM: "truecolor" };

/** A stream that only has to answer "are you a terminal". */
function stream(isTTY: boolean | undefined): { isTTY?: boolean } {
  return isTTY === undefined ? {} : { isTTY };
}

describe("ansi", () => {
  it("wraps in an SGR escape when enabled", () => {
    expect(ansi("2", "dim", true)).toBe(`${ESC}[2mdim${RESET}`);
  });

  it("returns the text untouched when disabled", () => {
    expect(ansi("2", "dim", false)).toBe("dim");
  });

  it("treats an empty code as the identity, escapes or not", () => {
    expect(ansi("", "plain", true)).toBe("plain");
    expect(ansi("", "plain", false)).toBe("plain");
  });

  it("leaves a blank line blank rather than colouring nothing", () => {
    expect(ansi("2", "", true)).toBe("");
  });
});

describe("colorEnabled", () => {
  it("is false off a terminal, whatever the environment says", () => {
    expect(colorEnabled(stream(false), {})).toBe(false);
    expect(colorEnabled(stream(undefined), {})).toBe(false);
    expect(colorEnabled(undefined, {})).toBe(false);
  });

  it("is true on a terminal with no NO_COLOR", () => {
    expect(colorEnabled(stream(true), {})).toBe(true);
  });

  it("honours NO_COLOR: any non-empty value disables colour", () => {
    expect(colorEnabled(stream(true), { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled(stream(true), { NO_COLOR: "anything" })).toBe(false);
  });

  it("treats an empty NO_COLOR as unset, per no-color.org", () => {
    expect(colorEnabled(stream(true), { NO_COLOR: "" })).toBe(true);
  });
});

describe("createStyles", () => {
  it("is the identity for every role when disabled", () => {
    const plain = createStyles(false);
    for (const role of ROLES) {
      expect(plain.role(role, "text")).toBe("text");
    }
    expect(plain.enabled).toBe(false);
  });

  it("leaves assistant prose undecorated even with colour on", () => {
    const styled = createStyles(true);
    expect(styled.agent("the model said this")).toBe("the model said this");
  });

  it("wraps every other role in its own escape", () => {
    const styled = createStyles(true);
    for (const role of ROLES) {
      // `agent` is the identity by design; `notice` is more than an escape —
      // it carries the bar, and has its own tests below.
      if (role === "agent" || role === "notice") continue;
      expect(styled.role(role, "x")).toBe(`${ESC}[${ROLE_SGR[role]}mx${RESET}`);
    }
  });

  it("keeps the classes a glance has to tell apart visually distinct", () => {
    // The four that share a screen row by row: what you said, what kapel
    // said about the session, what a tool did, and a heading over a table.
    // Compared as *rendered lines*, not as codes: a notice is told apart by
    // the bar down its left, which no SGR parameter can express.
    const styled = createStyles(true);
    const rendered = [
      styled.user("x"),
      styled.notice("x"),
      styled.tool("x"),
      styled.heading("x"),
    ];
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("keeps a menu row quieter than the prefix highlighted inside it", () => {
    // The one contrast the `/` menu depends on: the typed prefix wears the
    // user's own colour, the rest of the row recedes.
    expect(ROLE_SGR.menu).not.toBe(ROLE_SGR.user);
    expect(ROLE_SGR.menu).toBe("2");
  });

  it("named methods agree with role()", () => {
    const styled = createStyles(true);
    expect(styled.menu("a")).toBe(styled.role("menu", "a"));
    expect(styled.user("a")).toBe(styled.role("user", "a"));
    expect(styled.warn("a")).toBe(styled.role("warn", "a"));
    expect(styled.error("a")).toBe(styled.role("error", "a"));
  });

  it("paints the prompt marker in the accent, in bold", () => {
    // One hue for the whole shell: the marker you type at is the same colour
    // as the box above it and the bar beside a notice, only heavier.
    const sgr = roleSgr(TRUECOLOR);
    expect(sgr.user).toBe(`1;${ACCENT_TRUECOLOR}`);
    expect(sgr.accent).toBe(ACCENT_TRUECOLOR);
  });

  it("takes its codes from the terminal it was built for", () => {
    expect(createStyles(true, TRUECOLOR).accent("x")).toBe(
      `${ESC}[${ACCENT_TRUECOLOR}mx${RESET}`,
    );
    expect(createStyles(true, {}).accent("x")).toBe(
      `${ESC}[${ACCENT_BASIC}mx${RESET}`,
    );
  });

  it("PLAIN_STYLES is the disabled palette", () => {
    expect(PLAIN_STYLES.enabled).toBe(false);
    expect(PLAIN_STYLES.error("boom")).toBe("boom");
  });
});

describe("accentSgr", () => {
  it("claims the exact colour only where the terminal says it can show one", () => {
    expect(accentSgr({ COLORTERM: "truecolor" })).toBe(ACCENT_TRUECOLOR);
    expect(accentSgr({ COLORTERM: "24bit" })).toBe(ACCENT_TRUECOLOR);
    // The variable is set by terminals in whatever case they please.
    expect(accentSgr({ COLORTERM: "TrueColor" })).toBe(ACCENT_TRUECOLOR);
  });

  it("approximates it on a 256-colour TERM", () => {
    expect(accentSgr({ TERM: "xterm-256color" })).toBe(ACCENT_256);
    expect(accentSgr({ TERM: "screen-256color" })).toBe(ACCENT_256);
    // A truecolour terminal that also names a 256-colour TERM gets the exact
    // colour: COLORTERM is the more specific claim.
    expect(accentSgr({ COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe(
      ACCENT_TRUECOLOR,
    );
  });

  it("falls back to plain cyan when nothing promises more", () => {
    expect(accentSgr({})).toBe(ACCENT_BASIC);
    expect(accentSgr({ TERM: "xterm" })).toBe(ACCENT_BASIC);
    expect(accentSgr({ TERM: "dumb", COLORTERM: "" })).toBe(ACCENT_BASIC);
  });
});

describe("chromeSgr", () => {
  it("takes grey 245 wherever the terminal admits to 256 colours", () => {
    expect(chromeSgr(TRUECOLOR)).toBe(CHROME_256);
    expect(chromeSgr({ TERM: "xterm-256color" })).toBe(CHROME_256);
  });

  it("falls back to plain white on a terminal that claimed neither", () => {
    expect(chromeSgr({})).toBe(CHROME_BASIC);
    expect(chromeSgr({ TERM: "xterm" })).toBe(CHROME_BASIC);
  });
});

describe("echoSgr", () => {
  it("takes grey 237 as a background wherever 256 colours exist", () => {
    expect(echoSgr(TRUECOLOR)).toBe(ECHO_256);
    expect(echoSgr({ TERM: "screen-256color" })).toBe(ECHO_256);
  });

  it("falls back to one parameter an old terminal can safely ignore", () => {
    // Single-parameter SGR: a terminal that does not know it drops it, and
    // the `> message` inside the bar still reads. The multi-parameter 24-bit
    // form would have been printed onto the screen as text.
    expect(echoSgr({})).toBe(ECHO_BASIC);
    expect(ECHO_BASIC).not.toContain(";");
  });
});

describe("Styles.rule", () => {
  it("is one cell short of the width it is given, so it cannot wrap", () => {
    const rule = createStyles(true, TRUECOLOR).rule(20);
    expect(rule).toBe(`${ESC}[${CHROME_256}m${"─".repeat(19)}${RESET}`);
  });

  it("keeps its characters with colour off — structure is not decoration", () => {
    // `NO_COLOR` strips the escape and nothing else: the rules are what say
    // where the band you type in begins and ends. A stream that is not a
    // terminal never asks for one at all — nothing paints onto a pipe.
    expect(PLAIN_STYLES.rule(80)).toBe("─".repeat(79));
    expect(stylesFor(stream(true), { NO_COLOR: "1" }).rule(80)).toBe(
      "─".repeat(79),
    );
  });

  it("never returns a negative-width run for an absurd terminal", () => {
    expect(createStyles(true).rule(0)).toBe("");
    expect(createStyles(true).rule(1)).toBe("");
  });
});

describe("Styles.echo", () => {
  it("wraps a row in the gray background and nothing else", () => {
    expect(createStyles(true, TRUECOLOR).echo("> hi  ")).toBe(
      `${ESC}[${ECHO_256}m> hi  ${RESET}`,
    );
  });

  it("is the bare text with colour off", () => {
    expect(PLAIN_STYLES.echo("> hi")).toBe("> hi");
  });
});

describe("Styles.notice", () => {
  it("puts an accent bar down the left of kapel's own remarks", () => {
    const styled = createStyles(true, TRUECOLOR);
    expect(styled.notice("resumed foo")).toBe(
      `${ESC}[${ACCENT_TRUECOLOR}m${NOTICE_GUTTER}${RESET}${ESC}[${ROLE_SGR.notice}mresumed foo${RESET}`,
    );
  });

  it("agrees with role('notice'), so the two can never drift", () => {
    const styled = createStyles(true, TRUECOLOR);
    expect(styled.role("notice", "x")).toBe(styled.notice("x"));
  });

  it("leaves a blank notice line blank — a bar holding up nothing", () => {
    expect(createStyles(true).notice("")).toBe("");
  });

  it("is plain text off a terminal: no bar, no escape", () => {
    expect(PLAIN_STYLES.notice("resumed foo")).toBe("resumed foo");
    expect(
      stylesFor(stream(true), { NO_COLOR: "1" }).notice("resumed foo"),
    ).toBe("resumed foo");
  });
});

describe("stylesFor", () => {
  it("follows colorEnabled's verdict", () => {
    expect(stylesFor(stream(true), {}).enabled).toBe(true);
    expect(stylesFor(stream(true), { NO_COLOR: "1" }).enabled).toBe(false);
    expect(stylesFor(stream(false), {}).enabled).toBe(false);
  });
});

describe("promptMarker", () => {
  it("is the plain `kapel> ` off a terminal — a pipe sees no escape", () => {
    expect(promptMarker(PLAIN_STYLES)).toBe("kapel> ");
  });

  it("colours the marker and nothing else, so the echo stays the message", () => {
    const marker = promptMarker(createStyles(true));
    expect(marker).toBe(`${ESC}[${ROLE_SGR.user}mkapel>${RESET} `);
    expect(marker.endsWith("> ")).toBe(false);
    // The trailing space is outside the escape: what the terminal echoes
    // after it is the user's own text, unstyled.
    expect(marker.endsWith(" ")).toBe(true);
  });
});
