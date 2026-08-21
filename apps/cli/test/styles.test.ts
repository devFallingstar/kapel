import { describe, expect, it } from "vitest";
import { promptMarker } from "../src/interactive.js";
import {
  ansi,
  colorEnabled,
  createStyles,
  PLAIN_STYLES,
  ROLE_SGR,
  type StyleRole,
  stylesFor,
} from "../src/styles.js";

const ESC = "";
const RESET = `${ESC}[0m`;

/** Every role a caller can name. */
const ROLES: readonly StyleRole[] = [
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
      if (role === "agent") continue;
      expect(styled.role(role, "x")).toBe(`${ESC}[${ROLE_SGR[role]}mx${RESET}`);
    }
  });

  it("keeps the classes a glance has to tell apart visually distinct", () => {
    // The four that share a screen row by row: what you said, what kapel
    // said about the session, what a tool did, and a heading over a table.
    const codes = [
      ROLE_SGR.user,
      ROLE_SGR.notice,
      ROLE_SGR.tool,
      ROLE_SGR.heading,
    ];
    expect(new Set(codes).size).toBe(codes.length);
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

  it("PLAIN_STYLES is the disabled palette", () => {
    expect(PLAIN_STYLES.enabled).toBe(false);
    expect(PLAIN_STYLES.error("boom")).toBe("boom");
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
