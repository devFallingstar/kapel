import { describe, expect, it } from "vitest";
import { builtinTools } from "../../src/tools/index.js";

describe("builtinTools", () => {
  it("returns all 7 tools with unique names and valid definitions", () => {
    const tools = builtinTools();
    expect(tools).toHaveLength(7);

    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(7);
    expect(names.sort()).toEqual(
      [
        "bash",
        "edit_file",
        "git_diff",
        "glob",
        "grep",
        "read_file",
        "write_file",
      ].sort(),
    );

    for (const tool of tools) {
      const def = tool.definition();
      expect(def.name).toBe(tool.name);
      expect(def.description).toBe(tool.description);
      expect(def.inputSchema).toBeTypeOf("object");
    }
  });

  it("returns fresh instances on each call", () => {
    const first = builtinTools();
    const second = builtinTools();
    expect(first[0]).not.toBe(second[0]);
  });
});
