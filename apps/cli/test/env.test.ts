import { describe, expect, it } from "vitest";
import { applyDotEnv, parseDotEnv } from "../src/env.js";

describe("parseDotEnv", () => {
  it("parses simple KEY=VALUE lines", () => {
    expect(parseDotEnv("FOO=bar\nBAZ=qux\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("skips blank lines and full-line comments", () => {
    expect(
      parseDotEnv(
        ["# a comment", "", "FOO=bar", "  # indented comment"].join("\n"),
      ),
    ).toEqual({ FOO: "bar" });
  });

  it("strips matching double quotes", () => {
    expect(parseDotEnv('KEY="hello world"')).toEqual({ KEY: "hello world" });
  });

  it("strips matching single quotes", () => {
    expect(parseDotEnv("KEY='hello world'")).toEqual({ KEY: "hello world" });
  });

  it("leaves mismatched or absent quotes as-is", () => {
    expect(parseDotEnv("KEY='unterminated")).toEqual({
      KEY: "'unterminated",
    });
    expect(parseDotEnv("KEY=plain")).toEqual({ KEY: "plain" });
  });

  it("trims surrounding whitespace from unquoted values", () => {
    expect(parseDotEnv("KEY=  spaced out  ")).toEqual({ KEY: "spaced out" });
  });

  it("ignores lines with no '=' or an invalid key", () => {
    expect(
      parseDotEnv(["not a valid line", "1BAD=nope", "FOO=bar"].join("\n")),
    ).toEqual({ FOO: "bar" });
  });

  it("allows underscores and digits in keys (but not as the first char)", () => {
    expect(parseDotEnv("_FOO_1=bar")).toEqual({ _FOO_1: "bar" });
  });

  it("handles an empty value", () => {
    expect(parseDotEnv("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("handles CRLF line endings", () => {
    expect(parseDotEnv("FOO=bar\r\nBAZ=qux\r\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("later duplicate keys win", () => {
    expect(parseDotEnv("FOO=first\nFOO=second\n")).toEqual({ FOO: "second" });
  });
});

describe("applyDotEnv", () => {
  it("copies parsed entries into an empty target", () => {
    const target: Record<string, string | undefined> = {};
    applyDotEnv({ FOO: "bar" }, target);
    expect(target).toEqual({ FOO: "bar" });
  });

  it("never overrides a variable already set in the target", () => {
    const target: Record<string, string | undefined> = { FOO: "existing" };
    applyDotEnv({ FOO: "from-file", BAZ: "new" }, target);
    expect(target).toEqual({ FOO: "existing", BAZ: "new" });
  });

  it("treats an explicit empty string as already set", () => {
    const target: Record<string, string | undefined> = { FOO: "" };
    applyDotEnv({ FOO: "from-file" }, target);
    expect(target.FOO).toBe("");
  });
});
