import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrepTool } from "../../src/tools/grep.js";
import {
  cleanupWorkspace,
  makeContext,
  makeWorkspace,
} from "./test-helpers.js";

describe("GrepTool", () => {
  let workspacePath: string;
  const tool = new GrepTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await mkdir(join(workspacePath, "node_modules", "pkg"), {
      recursive: true,
    });
    await writeFile(
      join(workspacePath, "src", "a.ts"),
      "const Foo = 1;\nfunction bar() {}\nconst foo2 = 2;\n",
      "utf8",
    );
    await writeFile(
      join(workspacePath, "src", "b.txt"),
      "no match here\n",
      "utf8",
    );
    await writeFile(
      join(workspacePath, "node_modules", "pkg", "index.ts"),
      "const Foo = 999;\n",
      "utf8",
    );
    // A binary-looking file (contains a NUL byte) that must be skipped.
    await writeFile(
      join(workspacePath, "src", "bin.dat"),
      Buffer.from([0x00, 0x01, 0x46, 0x6f, 0x6f]),
    );
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("finds matches by regex with file/line/text", async () => {
    const result = await tool.execute(
      { pattern: "^const \\w+" },
      makeContext(workspacePath),
    );
    const files = result.matches.map((m) => m.file);
    expect(files).toContain("src/a.ts");
    expect(result.matches.find((m) => m.text.includes("Foo"))?.line).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("supports ignoreCase", async () => {
    const withoutIgnoreCase = await tool.execute(
      { pattern: "^const foo" },
      makeContext(workspacePath),
    );
    expect(withoutIgnoreCase.matches.some((m) => m.text.includes("Foo"))).toBe(
      false,
    );

    const withIgnoreCase = await tool.execute(
      { pattern: "^const foo", ignoreCase: true },
      makeContext(workspacePath),
    );
    expect(withIgnoreCase.matches.some((m) => m.text.includes("Foo"))).toBe(
      true,
    );
  });

  it("skips node_modules", async () => {
    const result = await tool.execute(
      { pattern: "999" },
      makeContext(workspacePath),
    );
    expect(result.matches).toHaveLength(0);
  });

  it("skips binary-looking files", async () => {
    const result = await tool.execute(
      { pattern: "Foo" },
      makeContext(workspacePath),
    );
    expect(result.matches.every((m) => m.file !== "src/bin.dat")).toBe(true);
  });

  it("filters by glob", async () => {
    const result = await tool.execute(
      { pattern: "match", glob: "*.txt" },
      makeContext(workspacePath),
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.file).toBe("src/b.txt");
  });

  it("respects maxMatches and sets truncated", async () => {
    await writeFile(
      join(workspacePath, "src", "many.txt"),
      Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"),
      "utf8",
    );
    const result = await tool.execute(
      { pattern: "line", maxMatches: 3 },
      makeContext(workspacePath),
    );
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects an invalid regex pattern", async () => {
    await expect(
      tool.execute({ pattern: "(unclosed" }, makeContext(workspacePath)),
    ).rejects.toThrow(/invalid regex pattern/);
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(
      tool.execute({ pattern: "x", path: "../" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects invalid input via zod", async () => {
    await expect(
      tool.execute({}, makeContext(workspacePath)),
    ).rejects.toThrow();
  });
});
