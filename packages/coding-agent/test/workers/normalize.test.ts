import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failedTaskResult,
  inspectWorkspaceChanges,
  normalizeTaskResult,
  type WorkspaceInspection,
} from "../../src/workers/normalize.js";
import { cleanup, initGitRepo, makeTempDir } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

describe("inspectWorkspaceChanges", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("normalize-repo-");
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("lists modified, untracked and deleted files and reports HEAD", async () => {
    const head = await initGitRepo(dir);

    await writeFile(join(dir, "tracked.txt"), "modified\n", "utf8");
    await writeFile(join(dir, "brand-new.ts"), "export {};\n", "utf8");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "deep.ts"), "export {};\n", "utf8");

    const inspection = await inspectWorkspaceChanges(dir);

    expect(inspection.commit).toBe(head);
    expect(inspection.changedFiles).toEqual([
      "brand-new.ts",
      "nested/deep.ts",
      "tracked.txt",
    ]);
  });

  it("reports a clean repository as unchanged but still resolves HEAD", async () => {
    const head = await initGitRepo(dir);

    const inspection = await inspectWorkspaceChanges(dir);

    expect(inspection.changedFiles).toEqual([]);
    expect(inspection.commit).toBe(head);
  });

  it("reports the destination path of a staged rename", async () => {
    await initGitRepo(dir);
    await rename(join(dir, "tracked.txt"), join(dir, "renamed.txt"));
    await execFileAsync("git", ["add", "-A"], { cwd: dir });

    const inspection = await inspectWorkspaceChanges(dir);

    expect(inspection.changedFiles).toEqual(["renamed.txt"]);
  });

  it("degrades to an empty inspection outside a git repository", async () => {
    await writeFile(join(dir, "loose.txt"), "hello\n", "utf8");

    const inspection = await inspectWorkspaceChanges(dir);

    expect(inspection).toEqual({ changedFiles: [] });
    expect(inspection.commit).toBeUndefined();
  });

  it("omits the commit for a repository with no commits yet", async () => {
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, "first.txt"), "hello\n", "utf8");

    const inspection = await inspectWorkspaceChanges(dir);

    expect(inspection.changedFiles).toEqual(["first.txt"]);
    expect(inspection.commit).toBeUndefined();
  });

  it("degrades to an empty inspection for a missing directory", async () => {
    const missing = join(dir, "gone");
    await rm(missing, { recursive: true, force: true });

    expect(await inspectWorkspaceChanges(missing)).toEqual({
      changedFiles: [],
    });
  });

  it("degrades to an empty inspection when the signal is already aborted", async () => {
    await initGitRepo(dir);

    expect(await inspectWorkspaceChanges(dir, AbortSignal.abort())).toEqual({
      changedFiles: [],
    });
  });
});

describe("normalizeTaskResult", () => {
  const inspection: WorkspaceInspection = {
    changedFiles: ["src/a.ts", "src/b.ts"],
    commit: "abc123",
  };

  it("passes status and summary through and carries the inspection", () => {
    const result = normalizeTaskResult({
      taskId: "task-9",
      loop: { status: "success", summary: "Added retries.", output: "ignored" },
      inspection,
    });

    expect(result).toEqual({
      taskId: "task-9",
      status: "success",
      summary: "Added retries.",
      decisions: [],
      changedFiles: ["src/a.ts", "src/b.ts"],
      commit: "abc123",
      tests: { passed: 0, failed: 0, commands: [] },
      unresolvedIssues: [],
      confidence: 0.8,
    });
  });

  it("omits the commit when the inspection has none", () => {
    const result = normalizeTaskResult({
      taskId: "task-9",
      loop: { status: "partial", summary: "Ran out of iterations." },
      inspection: { changedFiles: [] },
    });

    expect("commit" in result).toBe(false);
    expect(result.confidence).toBe(0.4);
  });

  it("scores confidence by status", () => {
    const confidence = (status: "success" | "partial" | "failed"): number =>
      normalizeTaskResult({
        taskId: "t",
        loop: { status, summary: "s" },
        inspection: { changedFiles: [] },
      }).confidence;

    expect(confidence("success")).toBe(0.8);
    expect(confidence("partial")).toBe(0.4);
    expect(confidence("failed")).toBe(0.1);
  });

  it("falls back to the run output, then to a placeholder summary", () => {
    expect(
      normalizeTaskResult({
        taskId: "t",
        loop: { status: "success", summary: "  ", output: "the output" },
        inspection: { changedFiles: [] },
      }).summary,
    ).toBe("the output");

    expect(
      normalizeTaskResult({
        taskId: "t",
        loop: { status: "success", summary: "" },
        inspection: { changedFiles: [] },
      }).summary,
    ).toBe("The worker returned no summary.");
  });
});

describe("failedTaskResult", () => {
  it("builds a failed result with no changes by default", () => {
    const result = failedTaskResult("task-3", "Unknown agent ghost");

    expect(result.status).toBe("failed");
    expect(result.taskId).toBe("task-3");
    expect(result.summary).toBe("Unknown agent ghost");
    expect(result.changedFiles).toEqual([]);
    expect(result.confidence).toBe(0.1);
  });
});
