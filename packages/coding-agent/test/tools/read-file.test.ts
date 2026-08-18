import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadFileTool } from "../../src/tools/read-file.js";
import {
  cleanupWorkspace,
  makeContext,
  makeWorkspace,
} from "./test-helpers.js";

describe("ReadFileTool", () => {
  let workspacePath: string;
  const tool = new ReadFileTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("has correct definition metadata", () => {
    expect(tool.name).toBe("read_file");
    const def = tool.definition();
    expect(def.name).toBe("read_file");
    expect(def.inputSchema).toBeTypeOf("object");
  });

  it("reads a whole file", async () => {
    await writeFile(join(workspacePath, "a.txt"), "one\ntwo\nthree\n", "utf8");
    const result = await tool.execute(
      { path: "a.txt" },
      makeContext(workspacePath),
    );
    expect(result.content).toBe("one\ntwo\nthree");
    expect(result.totalLines).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.path).toBe("a.txt");
  });

  it("applies offset and limit", async () => {
    await writeFile(
      join(workspacePath, "b.txt"),
      "l1\nl2\nl3\nl4\nl5\n",
      "utf8",
    );
    const result = await tool.execute(
      { path: "b.txt", offset: 2, limit: 2 },
      makeContext(workspacePath),
    );
    expect(result.content).toBe("l2\nl3");
    expect(result.totalLines).toBe(5);
  });

  it("caps content at 200000 chars and sets truncated", async () => {
    const big = "x".repeat(250_000);
    await writeFile(join(workspacePath, "big.txt"), big, "utf8");
    const result = await tool.execute(
      { path: "big.txt" },
      makeContext(workspacePath),
    );
    expect(result.content.length).toBe(200_000);
    expect(result.truncated).toBe(true);
  });

  it("reads a nested file", async () => {
    await mkdir(join(workspacePath, "nested", "dir"), { recursive: true });
    await writeFile(
      join(workspacePath, "nested", "dir", "f.txt"),
      "hi",
      "utf8",
    );
    const result = await tool.execute(
      { path: "nested/dir/f.txt" },
      makeContext(workspacePath),
    );
    expect(result.content).toBe("hi");
  });

  it("throws a clear error for a missing file", async () => {
    await expect(
      tool.execute({ path: "missing.txt" }, makeContext(workspacePath)),
    ).rejects.toThrow(/failed to read file/);
  });

  it("rejects a path escaping the workspace via ../", async () => {
    await expect(
      tool.execute({ path: "../outside.txt" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects an absolute path outside the workspace", async () => {
    await expect(
      tool.execute({ path: "/etc/passwd" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects invalid input via zod", async () => {
    await expect(
      tool.execute({}, makeContext(workspacePath)),
    ).rejects.toThrow();
    await expect(
      tool.execute({ path: "a.txt", offset: -1 }, makeContext(workspacePath)),
    ).rejects.toThrow();
  });
});
