import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitDiffTool } from "../../src/tools/git-diff.js";
import {
  cleanupWorkspace,
  makeContext,
  makeWorkspace,
} from "./test-helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("GitDiffTool", () => {
  let workspacePath: string;
  const tool = new GitDiffTool();

  beforeEach(async () => {
    workspacePath = await makeWorkspace();
    await git(workspacePath, ["init", "-q"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "file.txt"), "line1\nline2\n", "utf8");
    await git(workspacePath, ["add", "file.txt"]);
    await git(workspacePath, ["commit", "-q", "-m", "initial commit"]);
  });

  afterEach(async () => {
    await cleanupWorkspace(workspacePath);
  });

  it("returns an empty diff with no changes", async () => {
    const result = await tool.execute({}, makeContext(workspacePath));
    expect(result.diff).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("shows unstaged working-tree changes", async () => {
    await writeFile(
      join(workspacePath, "file.txt"),
      "line1\nline2 changed\n",
      "utf8",
    );
    const result = await tool.execute({}, makeContext(workspacePath));
    expect(result.diff).toContain("line2 changed");
    expect(result.diff).toContain("diff --git");
  });

  it("shows staged changes with staged: true", async () => {
    await writeFile(
      join(workspacePath, "file.txt"),
      "line1\nstaged change\n",
      "utf8",
    );
    await git(workspacePath, ["add", "file.txt"]);

    const unstaged = await tool.execute({}, makeContext(workspacePath));
    expect(unstaged.diff).toBe("");

    const staged = await tool.execute(
      { staged: true },
      makeContext(workspacePath),
    );
    expect(staged.diff).toContain("staged change");
  });

  it("restricts the diff to a given path", async () => {
    await writeFile(
      join(workspacePath, "file.txt"),
      "line1\nchanged\n",
      "utf8",
    );
    await writeFile(join(workspacePath, "other.txt"), "untracked", "utf8");

    const result = await tool.execute(
      { path: "file.txt" },
      makeContext(workspacePath),
    );
    expect(result.diff).toContain("file.txt");
    expect(result.diff).not.toContain("other.txt");
  });

  it("rejects a path escaping the workspace", async () => {
    await expect(
      tool.execute({ path: "../outside" }, makeContext(workspacePath)),
    ).rejects.toThrow(/path escapes workspace/);
  });

  it("rejects invalid input via zod", async () => {
    await expect(
      tool.execute({ staged: "yes" }, makeContext(workspacePath)),
    ).rejects.toThrow();
  });
});
