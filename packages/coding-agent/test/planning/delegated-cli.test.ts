import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../../src/planning/delegated-cli.js";

describe("extractJsonObject", () => {
  it("returns a bare object unchanged", () => {
    expect(extractJsonObject(' {"a":1} ')).toBe('{"a":1}');
  });

  it("unwraps a fenced block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips prose around the object", () => {
    expect(
      extractJsonObject('Here is the plan:\n{"a":1}\nHope that helps!'),
    ).toBe('{"a":1}');
  });

  it("keeps nested braces intact", () => {
    expect(extractJsonObject('x {"a":{"b":2}} y')).toBe('{"a":{"b":2}}');
  });

  it("returns undefined when there is no object at all", () => {
    expect(extractJsonObject("")).toBeUndefined();
    expect(extractJsonObject("I cannot plan this.")).toBeUndefined();
    expect(extractJsonObject("}{")).toBeUndefined();
  });
});
