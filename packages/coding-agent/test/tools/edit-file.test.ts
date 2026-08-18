import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditFileTool } from "../../src/tools/edit-file.js";
import { cleanupWorkspace, makeContext, makeWorkspace } from "./test-helpers.js";

describe("EditFileTool", () => {
  let workspacePath: string;
  const tool = new EditFileTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("replaces a unique occurrence", async () => {
    await writeFile(join(workspacePath, "f.txt"), "hello world", "utf8");
    const result = await tool.execute(
      { path: "f.txt", oldText: "world", newText: "there" },
      makeContext(workspacePath),
    );
    expect(result.replacements).toBe(1);
    const onDisk = await readFile(join(workspacePath, "f.txt"), "utf8");
    expect(onDisk).toBe("hello there");
  });

  it("errors when oldText is not found", async () => {
    await writeFile(join(workspacePath, "f.txt"), "hello world", "utf8");
    await expect(
      tool.execute(
        { path: "f.txt", oldText: "missing", newText: "x" },
        makeContext(workspacePath),
      ),
    ).rejects.toThrow(/oldText not found/);
  });

  it("errors on multiple occurrences without replaceAll, stating the count", async () => {
    await writeFile(join(workspacePath, "f.txt"), "foo foo foo", "utf8");
    await expect(
      tool.execute(
        { path: "f.txt", oldText: "foo", newText: "bar" },
        makeContext(workspacePath),
      ),
    ).rejects.toThrow(/occurs 3 times/);
  });

  it("replaces all occurrences with replaceAll: true", async () => {
    await writeFile(join(workspacePath, "f.txt"), "foo foo foo", "utf8");
    const result = await tool.execute(
      { path: "f.txt", oldText: "foo", newText: "bar", replaceAll: true },
      makeContext(workspacePath),
    );
    expect(result.replacements).toBe(3);
    const onDisk = await readFile(join(workspacePath, "f.txt"), "utf8");
    expect(onDisk).toBe("bar bar bar");
  });

  it("rejects when oldText equals newText", async () => {
    await writeFile(join(workspacePath, "f.txt"), "same", "utf8");
    await expect(
      tool.execute(
        { path: "f.txt", oldText: "same", newText: "same" },
        makeContext(workspacePath),
      ),
    ).rejects.toThrow(/must differ/);
  });

  it("rejects empty oldText via zod", async () => {
    await writeFile(join(workspacePath, "f.txt"), "x", "utf8");
    await expect(
      tool.execute({ path: "f.txt", oldText: "", newText: "y" }, makeContext(workspacePath)),
    ).rejects.toThrow();
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(
      tool.execute(
        { path: "../f.txt", oldText: "a", newText: "b" },
        makeContext(workspacePath),
      ),
    ).rejects.toThrow(/path escapes workspace/);
  });
});
