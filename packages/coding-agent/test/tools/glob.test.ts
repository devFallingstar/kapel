import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobTool } from "../../src/tools/glob.js";
import { cleanupWorkspace, makeContext, makeWorkspace } from "./test-helpers.js";

describe("GlobTool", () => {
  let workspacePath: string;
  const tool = new GlobTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
    await mkdir(join(workspacePath, "src", "nested"), { recursive: true });
    await mkdir(join(workspacePath, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(workspacePath, ".git"), { recursive: true });
    await writeFile(join(workspacePath, "src", "a.ts"), "a", "utf8");
    await writeFile(join(workspacePath, "src", "nested", "b.ts"), "b", "utf8");
    await writeFile(join(workspacePath, "src", "c.js"), "c", "utf8");
    await writeFile(join(workspacePath, "node_modules", "pkg", "index.ts"), "x", "utf8");
    await writeFile(join(workspacePath, ".git", "HEAD"), "ref", "utf8");
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("matches files with a ** pattern, sorted, workspace-relative", async () => {
    const result = await tool.execute({ pattern: "**/*.ts" }, makeContext(workspacePath));
    expect(result.matches).toEqual(["src/a.ts", "src/nested/b.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("always skips node_modules and .git", async () => {
    const result = await tool.execute({ pattern: "**/*" }, makeContext(workspacePath));
    expect(result.matches.some((m) => m.includes("node_modules"))).toBe(false);
    expect(result.matches.some((m) => m.includes(".git"))).toBe(false);
  });

  it("supports a single * within a directory", async () => {
    const result = await tool.execute({ pattern: "src/*.ts" }, makeContext(workspacePath));
    expect(result.matches).toEqual(["src/a.ts"]);
  });

  it("searches from a given cwd", async () => {
    const result = await tool.execute(
      { pattern: "*.ts", cwd: "src" },
      makeContext(workspacePath),
    );
    expect(result.matches).toEqual(["src/a.ts"]);
  });

  it("rejects a cwd escaping the workspace", async () => {
    await expect(
      tool.execute({ pattern: "*.ts", cwd: "../" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects invalid input via zod", async () => {
    await expect(tool.execute({}, makeContext(workspacePath))).rejects.toThrow();
    await expect(tool.execute({ pattern: "" }, makeContext(workspacePath))).rejects.toThrow();
  });
});
