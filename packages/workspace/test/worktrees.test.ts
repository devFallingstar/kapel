import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_DIFF_CHARS,
  TaskWorktreeManager,
  WORKTREE_BRANCH_PREFIX,
  WorktreeError,
} from "../src/index.js";
import {
  cleanupTempDirs,
  git,
  gitStatus,
  makeRepo,
  makeTempDir,
  writeIn,
} from "./git-helpers.js";

const TIMEOUT = 60_000;

const SCRUBBED_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "HOME",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

const savedEnv = new Map<string, string | undefined>();

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function head(repo: string): Promise<string> {
  return (await git(repo, "rev-parse", "HEAD")).trim();
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (
    (await gitStatus(repo, "rev-parse", "--verify", `refs/heads/${branch}`)) ===
    0
  );
}

beforeAll(async () => {
  // The manager must commit without depending on any user/system git config:
  // scrub identity + config discovery from the environment it inherits.
  const home = await makeTempDir("wt-home");
  for (const key of SCRUBBED_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await cleanupTempDirs();
});

describe("TaskWorktreeManager.create", () => {
  it(
    "creates an isolated checkout on a new branch at the base commit",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const base = await head(repo);

      const worktree = await manager.create("run1", "task1");

      expect(worktree.branch).toBe(`${WORKTREE_BRANCH_PREFIX}/run1/task1`);
      expect(worktree.baseCommit).toBe(base);
      expect(worktree.path).toBe(
        join(repo, ".agent", "worktrees", "run1", "task1"),
      );
      expect(await exists(join(worktree.path, "README.md"))).toBe(true);
      expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(base);
      expect(
        (await git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
      ).toBe(worktree.branch);
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(
        worktree.branch,
      );
    },
    TIMEOUT,
  );

  it(
    "sanitizes run and task ids into branch-safe segments",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });

      const worktree = await manager.create("run 1/2", "task#3!");

      expect(worktree.runId).toBe("run-1-2");
      expect(worktree.taskId).toBe("task-3");
      expect(worktree.branch).toBe(`${WORKTREE_BRANCH_PREFIX}/run-1-2/task-3`);
      expect(worktree.path).toBe(
        join(repo, ".agent", "worktrees", "run-1-2", "task-3"),
      );
      expect(await branchExists(repo, worktree.branch)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "rejects ids that sanitize to nothing",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });

      await expect(manager.create("///", "task")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    },
    TIMEOUT,
  );

  it(
    "reports a helpful error for a non-repository and for an empty repository",
    async () => {
      const plain = await makeTempDir("wt-plain");
      const notARepo = new TaskWorktreeManager({ repoRoot: plain });
      await expect(notARepo.create("run", "task")).rejects.toThrow(
        /not a git repository/,
      );

      const empty = await makeTempDir("wt-empty");
      await git(empty, "init", "-b", "main");
      const noCommits = new TaskWorktreeManager({ repoRoot: empty });
      await expect(noCommits.create("run", "task")).rejects.toThrow(
        /no commits/,
      );
    },
    TIMEOUT,
  );

  it(
    "recreates over leftovers from a previous attempt",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });

      const first = await manager.create("run1", "task1");
      await writeIn(first.path, "stale.txt", "stale\n");

      const second = await manager.create("run1", "task1");

      expect(second.path).toBe(first.path);
      expect(await exists(join(second.path, "stale.txt"))).toBe(false);
      expect(
        (await git(repo, "worktree", "list", "--porcelain")).match(
          /^worktree /gm,
        ),
      ).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    "supports concurrent creation for different tasks",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });

      const [a, b] = await Promise.all([
        manager.create("run1", "task-a"),
        manager.create("run1", "task-b"),
      ]);

      expect(a.branch).not.toBe(b.branch);
      expect(await exists(join(a.path, "README.md"))).toBe(true);
      expect(await exists(join(b.path, "README.md"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("TaskWorktreeManager.collect", () => {
  it(
    "commits changes with the inline agent identity and reports diff metadata",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      await writeIn(worktree.path, "src/added.ts", "export const a = 1;\n");
      await writeIn(worktree.path, "README.md", "base\nmore\n");

      const result = await manager.collect(worktree);

      expect(result.committed).toBe(true);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect([...result.changedFiles].sort()).toEqual([
        "README.md",
        "src/added.ts",
      ]);
      expect(result.diff).toContain("+export const a = 1;");
      const identity = (
        await git(worktree.path, "log", "-1", "--format=%an|%ae|%cn|%ce|%s")
      ).trim();
      expect(identity).toBe(
        "AGENT|agent@localhost|AGENT|agent@localhost|agent task task1",
      );
      // The base branch is untouched until integrate().
      expect(await head(repo)).toBe(worktree.baseCommit);
    },
    TIMEOUT,
  );

  it(
    "uses a custom commit message when provided",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      await writeIn(worktree.path, "a.txt", "a\n");

      await manager.collect(worktree, "custom message");

      expect(
        (await git(worktree.path, "log", "-1", "--format=%s")).trim(),
      ).toBe("custom message");
    },
    TIMEOUT,
  );

  it(
    "reports nothing committed when the worktree is unchanged",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");

      const result = await manager.collect(worktree);

      expect(result).toEqual({ committed: false, changedFiles: [], diff: "" });
      expect((await git(worktree.path, "rev-parse", "HEAD")).trim()).toBe(
        worktree.baseCommit,
      );
    },
    TIMEOUT,
  );

  it(
    "truncates very large diffs and says so inside the diff",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      const big = `${"x".repeat(80)}\n`.repeat(Math.ceil(MAX_DIFF_CHARS / 40));
      await writeIn(worktree.path, "big.txt", big);

      const result = await manager.collect(worktree);

      expect(result.committed).toBe(true);
      expect(result.diff).toContain("[diff truncated after");
      expect(result.diff.length).toBeLessThan(MAX_DIFF_CHARS + 200);
    },
    TIMEOUT,
  );
});

describe("TaskWorktreeManager.integrate", () => {
  it(
    "merges a task branch into the base branch",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      await writeIn(worktree.path, "feature.txt", "feature\n");
      await manager.collect(worktree);

      const result = await manager.integrate(worktree);

      expect(result.merged).toBe(true);
      expect(result.conflictFiles).toEqual([]);
      expect(result.commit).toBe(await head(repo));
      expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe(
        "feature\n",
      );
      expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe(
        "merge agent task task1",
      );
    },
    TIMEOUT,
  );

  it(
    "is a no-op when the task branch has no commits",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      await manager.collect(worktree);
      const before = await head(repo);

      const result = await manager.integrate(worktree);

      expect(result.merged).toBe(true);
      expect(result.commit).toBe(before);
      expect(await head(repo)).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "refuses to merge into a dirty base",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      await writeIn(worktree.path, "feature.txt", "feature\n");
      await manager.collect(worktree);
      await writeIn(repo, "README.md", "locally edited\n");
      const before = await head(repo);

      const result = await manager.integrate(worktree);

      expect(result.merged).toBe(false);
      expect(result.reason).toBe("dirty-base");
      expect(result.detail).toContain("README.md");
      expect(result.conflictFiles).toEqual([]);
      expect(await head(repo)).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "lands two parallel workers that touched different files",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const [a, b] = await Promise.all([
        manager.create("run1", "task-a"),
        manager.create("run1", "task-b"),
      ]);
      await writeIn(a.path, "a.txt", "from a\n");
      await writeIn(b.path, "b.txt", "from b\n");

      const collected = await Promise.all([
        manager.collect(a),
        manager.collect(b),
      ]);
      expect(collected.map((entry) => entry.committed)).toEqual([true, true]);

      const [first, second] = await Promise.all([
        manager.integrate(a),
        manager.integrate(b),
      ]);

      expect(first.merged).toBe(true);
      expect(second.merged).toBe(true);
      expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("from a\n");
      expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("from b\n");
      expect(
        await git(repo, "status", "--porcelain", "--untracked-files=no"),
      ).toBe("");
    },
    TIMEOUT,
  );

  it(
    "serializes concurrent integrate calls so both merges land",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktrees = await Promise.all([
        manager.create("run1", "task-1"),
        manager.create("run1", "task-2"),
        manager.create("run1", "task-3"),
      ]);
      for (const [index, worktree] of worktrees.entries()) {
        await writeIn(worktree.path, `file-${index}.txt`, `content ${index}\n`);
        await manager.collect(worktree);
      }

      const results = await Promise.all(
        worktrees.map((worktree) => manager.integrate(worktree)),
      );

      expect(results.every((result) => result.merged)).toBe(true);
      const commits = new Set(results.map((result) => result.commit));
      expect(commits.size).toBe(3);
      const log = await git(repo, "log", "--format=%s");
      for (const [index, worktree] of worktrees.entries()) {
        expect(log).toContain(`merge agent task ${worktree.taskId}`);
        expect(await exists(join(repo, `file-${index}.txt`))).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "surfaces conflicts, leaves the base clean, and can keep the branch",
    async () => {
      const repo = await makeRepo();
      await writeIn(repo, "shared.txt", "original\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-m", "add shared");
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const a = await manager.create("run1", "task-a");
      const b = await manager.create("run1", "task-b");
      await writeIn(a.path, "shared.txt", "from a\n");
      await writeIn(b.path, "shared.txt", "from b\n");
      await manager.collect(a);
      await manager.collect(b);

      const first = await manager.integrate(a);
      expect(first.merged).toBe(true);

      const second = await manager.integrate(b);

      expect(second.merged).toBe(false);
      expect(second.reason).toBe("conflicts");
      expect(second.conflictFiles).toEqual(["shared.txt"]);
      expect(second.commit).toBeUndefined();
      // No merge left in progress and no conflict markers in the base checkout.
      expect(await exists(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
      expect(
        await git(repo, "status", "--porcelain", "--untracked-files=no"),
      ).toBe("");
      expect(await readFile(join(repo, "shared.txt"), "utf8")).toBe("from a\n");

      await manager.remove(b, { keepBranch: true });
      expect(await branchExists(repo, b.branch)).toBe(true);
      expect(await exists(b.path)).toBe(false);
    },
    TIMEOUT,
  );
});

describe("TaskWorktreeManager.remove", () => {
  it(
    "removes the checkout and deletes the branch by default",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");

      await manager.remove(worktree);

      expect(await exists(worktree.path)).toBe(false);
      expect(await branchExists(repo, worktree.branch)).toBe(false);
      expect(
        (await git(repo, "worktree", "list", "--porcelain")).match(
          /^worktree /gm,
        ),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "tolerates a worktree directory that is already gone",
    async () => {
      const repo = await makeRepo();
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");
      await manager.remove(worktree);

      await expect(manager.remove(worktree)).resolves.toBeUndefined();
    },
    TIMEOUT,
  );
});

describe("TaskWorktreeManager.recover", () => {
  it(
    "cleans up worktrees after a crash and reports branches",
    async () => {
      const repo = await makeRepo();
      let manager: TaskWorktreeManager | undefined = new TaskWorktreeManager({
        repoRoot: repo,
      });
      const a = await manager.create("run1", "task-a");
      const b = await manager.create("run1", "task-b");
      await writeIn(a.path, "a.txt", "a\n");
      await manager.collect(a);
      // Simulate a crash: the process dies and one checkout is wiped by hand.
      manager = undefined;
      await rm(a.path, { recursive: true, force: true });

      const kept = await TaskWorktreeManager.recover(repo);

      expect(kept.prunedWorktrees).toHaveLength(1);
      expect(kept.prunedWorktrees[0]).toContain(join("run1", "task-b"));
      expect(kept.removedBranches).toEqual([]);
      expect([...kept.kept].sort()).toEqual([a.branch, b.branch].sort());
      expect(await exists(b.path)).toBe(false);
      expect(
        (await git(repo, "worktree", "list", "--porcelain")).match(
          /^worktree /gm,
        ),
      ).toHaveLength(1);
      expect(await branchExists(repo, a.branch)).toBe(true);

      const cleared = await TaskWorktreeManager.recover(repo, {
        removeBranches: true,
      });

      expect(cleared.prunedWorktrees).toEqual([]);
      expect([...cleared.removedBranches].sort()).toEqual(
        [a.branch, b.branch].sort(),
      );
      expect(cleared.kept).toEqual([]);
      expect(await branchExists(repo, a.branch)).toBe(false);
      expect(await branchExists(repo, b.branch)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "never touches branches outside the agent-task namespace",
    async () => {
      const repo = await makeRepo();
      await git(repo, "branch", "keep-me");
      const manager = new TaskWorktreeManager({ repoRoot: repo });
      const worktree = await manager.create("run1", "task1");

      const report = await TaskWorktreeManager.recover(repo, {
        removeBranches: true,
      });

      expect(report.prunedWorktrees).toHaveLength(1);
      expect(report.removedBranches).toEqual([worktree.branch]);
      expect(await branchExists(repo, "keep-me")).toBe(true);
      expect(await branchExists(repo, "main")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "honours a custom worktrees directory outside the repository",
    async () => {
      const repo = await makeRepo();
      const outside = await makeTempDir("wt-outside");
      const manager = new TaskWorktreeManager({
        repoRoot: repo,
        worktreesDir: outside,
      });
      const worktree = await manager.create("run1", "task1");
      expect(worktree.path).toBe(join(outside, "run1", "task1"));
      await writeIn(worktree.path, "outside.txt", "outside\n");
      await manager.collect(worktree);

      const integrated = await manager.integrate(worktree);
      expect(integrated.merged).toBe(true);

      const report = await TaskWorktreeManager.recover(repo, {
        worktreesDir: outside,
        removeBranches: true,
      });
      expect(report.prunedWorktrees).toHaveLength(1);
      expect(report.removedBranches).toEqual([worktree.branch]);
    },
    TIMEOUT,
  );
});
