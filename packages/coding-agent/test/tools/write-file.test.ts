import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WriteFileTool } from "../../src/tools/write-file.js";
import { cleanupWorkspace, makeContext, makeWorkspace } from "./test-helpers.js";

describe("WriteFileTool", () => {
  let workspacePath: string;
  const tool = new WriteFileTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("creates a new file and reports created: true", async () => {
    const result = await tool.execute(
      { path: "new.txt", content: "hello" },
      makeContext(workspacePath),
    );
    expect(result.created).toBe(true);
    expect(result.bytesWritten).toBe(5);
    const onDisk = await readFile(join(workspacePath, "new.txt"), "utf8");
    expect(onDisk).toBe("hello");
  });

  it("creates parent directories as needed", async () => {
    const result = await tool.execute(
      { path: "a/b/c/file.txt", content: "deep" },
      makeContext(workspacePath),
    );
    expect(result.created).toBe(true);
    const onDisk = await readFile(join(workspacePath, "a/b/c/file.txt"), "utf8");
    expect(onDisk).toBe("deep");
  });

  it("overwrites an existing file and reports created: false", async () => {
    await tool.execute({ path: "existing.txt", content: "v1" }, makeContext(workspacePath));
    const result = await tool.execute(
      { path: "existing.txt", content: "v2" },
      makeContext(workspacePath),
    );
    expect(result.created).toBe(false);
    const onDisk = await readFile(join(workspacePath, "existing.txt"), "utf8");
    expect(onDisk).toBe("v2");
  });

  it("counts bytes written using UTF-8 byte length", async () => {
    const result = await tool.execute(
      { path: "unicode.txt", content: "café" },
      makeContext(workspacePath),
    );
    expect(result.bytesWritten).toBe(Buffer.byteLength("café", "utf8"));
  });

  it("rejects a path escaping the workspace via ../", async () => {
    await expect(
      tool.execute({ path: "../escape.txt", content: "x" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects an absolute path outside the workspace", async () => {
    await expect(
      tool.execute({ path: "/tmp/escape.txt", content: "x" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects invalid input via zod", async () => {
    await expect(tool.execute({ path: "a.txt" }, makeContext(workspacePath))).rejects.toThrow();
    await expect(tool.execute({ content: "x" }, makeContext(workspacePath))).rejects.toThrow();
  });
});
