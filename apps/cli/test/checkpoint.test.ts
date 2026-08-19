import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointStore } from "../src/checkpoint.js";
import {
  checkpointLabel,
  createCheckpointStore,
  formatAge,
  MAX_CHECKPOINTS,
  undoLines,
} from "../src/checkpoint.js";

const execFileAsync = promisify(execFile);

/** Sandboxed runs point the fixtures at a writable scratch directory. */
const TEST_TMP_ROOT = process.env.AGENT_TEST_TMPDIR || tmpdir();

const created: string[] = [];

/** Git environment with user/system configuration disabled and a fixed identity. */
function fixtureEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: fixtureEnv(cwd),
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

/** Runs git and returns the exit code instead of throwing — for the conflicting merge. */
async function gitCode(cwd: string, ...args: string[]): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd, env: fixtureEnv(cwd) });
    return 0;
  } catch (error) {
    const code = (error as { code?: number }).code;
    return typeof code === "number" ? code : 1;
  }
}

async function tempDir(prefix: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP_ROOT, `${prefix}-`));
  created.push(dir);
  return dir;
}

/** A repo on `main` with one commit: `README.md` and `src/app.ts`. */
async function makeRepo(): Promise<string> {
  const dir = await tempDir("kapel-checkpoint");
  await git(dir, "init", "-b", "main");
  await write(dir, "README.md", "base\n");
  await write(dir, "src/app.ts", "export const value = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "initial");
  return dir;
}

async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function read(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

function exists(root: string, relativePath: string): boolean {
  return existsSync(path.join(root, relativePath));
}

function storeFor(root: string, limit?: number): CheckpointStore {
  return createCheckpointStore({
    workspacePath: root,
    ...(limit === undefined ? {} : { limit }),
  });
}

/** The `ok: true` half of an outcome, or a failing assertion naming the reason. */
function expectRestored(
  outcome: Awaited<ReturnType<CheckpointStore["undo"]>>,
): { restored: number; label: string; ageMs: number } {
  if (!outcome.ok)
    throw new Error(`expected a restore, got: ${outcome.reason}`);
  return outcome;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// --- capture ----------------------------------------------------------------

describe("checkpoint capture", () => {
  it("snapshots without touching the index, the worktree or the stash", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);

    // A staged change and an unstaged one, both of which must survive intact.
    await write(repo, "README.md", "staged\n");
    await git(repo, "add", "README.md");
    await write(repo, "src/app.ts", "export const value = 2;\n");
    await write(repo, "untracked.txt", "new\n");

    const statusBefore = await git(repo, "status", "--porcelain");
    expect(await store.capture("do the thing")).toBeUndefined();

    expect(await git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(await git(repo, "diff", "--cached", "--name-only")).toBe(
      "README.md\n",
    );
    expect(await git(repo, "stash", "list")).toBe("");
    expect(await read(repo, "src/app.ts")).toBe("export const value = 2;\n");
    expect(store.entries()).toHaveLength(1);
  });

  it("records a dangling commit that git can still show", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await write(repo, "untracked.txt", "captured\n");

    await store.capture("fix the failing tests\nsecond line ignored");

    const entry = store.entries()[0];
    if (entry === undefined) throw new Error("no checkpoint was recorded");
    expect(entry.label).toBe("fix the failing tests");
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.tree).toMatch(/^[0-9a-f]{40}$/);
    // The commit is real and reachable by hash — it is simply referenced by
    // nothing, which is what keeps it out of the user's branches and reflog.
    expect(await git(repo, "cat-file", "-t", entry.commit)).toBe("commit\n");
    expect(
      await git(repo, "show", "--stat", "--oneline", entry.commit),
    ).toContain("kapel checkpoint: fix the failing tests");
    // Untracked files are in the snapshot — the whole point of not using
    // `git stash create`.
    expect(await git(repo, "ls-tree", "--name-only", entry.tree)).toContain(
      "untracked.txt",
    );
    expect(await git(repo, "rev-parse", "--verify", "HEAD")).not.toContain(
      entry.commit,
    );
  });

  it("keeps at most the configured number of checkpoints, dropping the oldest", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);

    for (let i = 0; i < MAX_CHECKPOINTS + 5; i += 1) {
      await write(repo, "src/app.ts", `export const value = ${i};\n`);
      await store.capture(`prompt ${i}`);
    }

    const entries = store.entries();
    expect(entries).toHaveLength(MAX_CHECKPOINTS);
    expect(entries[0]?.label).toBe("prompt 5");
    expect(entries[entries.length - 1]?.label).toBe(
      `prompt ${MAX_CHECKPOINTS + 4}`,
    );
  });

  it("is a no-op outside a git repository", async () => {
    const plain = await tempDir("kapel-checkpoint-plain");
    const store = storeFor(plain);
    await write(plain, "notes.txt", "before\n");

    expect(await store.capture("hello")).toBeUndefined();
    expect(store.entries()).toEqual([]);

    await write(plain, "notes.txt", "after\n");
    const outcome = await store.undo();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("needs a git repository");
    expect(outcome.reason).toContain("git init");
    // Nothing was restored, and nothing was destroyed either.
    expect(await read(plain, "notes.txt")).toBe("after\n");
  });

  it("works in a repository with no commits yet", async () => {
    const repo = await tempDir("kapel-checkpoint-empty");
    await git(repo, "init", "-b", "main");
    await write(repo, "first.txt", "one\n");
    const store = storeFor(repo);

    expect(await store.capture("start")).toBeUndefined();
    await write(repo, "first.txt", "two\n");

    expect(expectRestored(await store.undo()).restored).toBe(1);
    expect(await read(repo, "first.txt")).toBe("one\n");
  });
});

// --- undo -------------------------------------------------------------------

describe("checkpoint undo", () => {
  it("reverts a modified tracked file", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("rewrite the module");

    await write(repo, "src/app.ts", "export const value = 999;\n");

    const outcome = expectRestored(await store.undo());
    expect(outcome.restored).toBe(1);
    expect(outcome.label).toBe("rewrite the module");
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");
    expect(store.entries()).toEqual([]);
  });

  it("catches an edit made in the same second, at the same length", async () => {
    // The stat cache's blind spot, and the reason the copied index is
    // backdated: same size, same inode, same whole-second mtime as the commit
    // that wrote the real index. Git only re-reads such a file because it
    // considers it racily clean, and it only does that if the index it is
    // reading looks at least as old as the file.
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("swap a digit");

    await write(repo, "src/app.ts", "export const value = 9;\n");

    expect(expectRestored(await store.undo()).restored).toBe(1);
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");
  });

  it("deletes files created after the checkpoint and prunes their directories", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("add a feature");

    await write(repo, "src/new/feature.ts", "export const added = true;\n");
    await write(repo, "loose.txt", "loose\n");

    expect(expectRestored(await store.undo()).restored).toBe(2);
    expect(exists(repo, "src/new/feature.ts")).toBe(false);
    expect(exists(repo, "src/new")).toBe(false);
    expect(exists(repo, "loose.txt")).toBe(false);
    expect(exists(repo, "src/app.ts")).toBe(true);
  });

  it("restores a tracked file the turn deleted, recreating its directory", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("clean up");

    await rm(path.join(repo, "src"), { recursive: true, force: true });
    await rm(path.join(repo, "README.md"), { force: true });

    expect(expectRestored(await store.undo()).restored).toBe(2);
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");
    expect(await read(repo, "README.md")).toBe("base\n");
  });

  it("restores an untracked file that existed at capture time", async () => {
    const repo = await makeRepo();
    await write(repo, "scratch/notes.md", "keep me\n");
    const store = storeFor(repo);
    await store.capture("tidy the scratch dir");

    await rm(path.join(repo, "scratch"), { recursive: true, force: true });
    await write(repo, "scratch-two.md", "created\n");

    expect(expectRestored(await store.undo()).restored).toBe(2);
    expect(await read(repo, "scratch/notes.md")).toBe("keep me\n");
    expect(exists(repo, "scratch-two.md")).toBe(false);
  });

  it("handles a modify, a create and a delete in one restore", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("do everything at once");

    await write(repo, "src/app.ts", "export const value = 42;\n");
    await write(repo, "src/extra.ts", "export const extra = true;\n");
    await rm(path.join(repo, "README.md"), { force: true });

    const outcome = expectRestored(await store.undo());
    expect(outcome.restored).toBe(3);
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");
    expect(exists(repo, "src/extra.ts")).toBe(false);
    expect(await read(repo, "README.md")).toBe("base\n");
    // The working tree is exactly what it was: git sees nothing to report.
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("reports nothing changed when the turn touched no files", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("just a question");

    const outcome = expectRestored(await store.undo());
    expect(outcome.restored).toBe(0);
    expect(undoLines(outcome)).toEqual([
      expect.stringContaining('↩ nothing had changed since "just a question"'),
    ]);
  });

  it("walks back one checkpoint per invocation", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);

    await store.capture("first");
    await write(repo, "src/app.ts", "export const value = 2;\n");
    await store.capture("second");
    await write(repo, "src/app.ts", "export const value = 3;\n");

    expect(expectRestored(await store.undo()).label).toBe("second");
    expect(await read(repo, "src/app.ts")).toBe("export const value = 2;\n");
    expect(expectRestored(await store.undo()).label).toBe("first");
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");

    const empty = await store.undo();
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain("nothing to undo");
  });

  it("says so when there is nothing to undo", async () => {
    const repo = await makeRepo();
    const outcome = await storeFor(repo).undo();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("nothing to undo");
  });

  it("leaves ignored files and .agent/ alone", async () => {
    const repo = await makeRepo();
    await write(repo, ".gitignore", "build/\n");
    await write(repo, "build/out.js", "old\n");
    await mkdir(path.join(repo, ".agent"), { recursive: true });
    await write(repo, ".agent/sessions.db", "old-db\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "ignore build");

    const store = storeFor(repo);
    await store.capture("regenerate");

    await write(repo, "build/out.js", "new\n");
    await write(repo, ".agent/sessions.db", "new-db\n");
    await write(repo, "src/app.ts", "export const value = 7;\n");

    expect(expectRestored(await store.undo()).restored).toBe(1);
    expect(await read(repo, "build/out.js")).toBe("new\n");
    expect(await read(repo, ".agent/sessions.db")).toBe("new-db\n");
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");
  });

  it("refuses while a merge is in progress and keeps the checkpoint", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("before the merge");

    await git(repo, "checkout", "-b", "other");
    await write(repo, "README.md", "other\n");
    await git(repo, "commit", "-am", "other");
    await git(repo, "checkout", "main");
    await write(repo, "README.md", "mine\n");
    await git(repo, "commit", "-am", "mine");
    expect(await gitCode(repo, "merge", "other")).not.toBe(0);
    expect(exists(repo, ".git/MERGE_HEAD")).toBe(true);

    const outcome = await store.undo();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("a merge is in progress");
    // Refusing is only useful if it is not also destructive.
    expect(exists(repo, ".git/MERGE_HEAD")).toBe(true);
    expect(store.entries()).toHaveLength(1);
  });

  it("restores what a shell command changed, not only what a tool wrote", async () => {
    const repo = await makeRepo();
    const store = storeFor(repo);
    await store.capture("run the formatter");

    // Stands in for the agent's `bash` tool, or any other process: the
    // checkpoint is of the tree, so the source of the edit does not matter.
    await execFileAsync("sh", ["-c", "echo mangled > src/app.ts"], {
      cwd: repo,
    });

    expect(expectRestored(await store.undo()).restored).toBe(1);
    expect(await read(repo, "src/app.ts")).toBe("export const value = 1;\n");
  });
});

// --- formatting -------------------------------------------------------------

describe("checkpoint formatting", () => {
  it("labels a checkpoint by the prompt's first line", () => {
    expect(checkpointLabel("  fix   the tests \nand then some")).toBe(
      "fix the tests",
    );
    expect(checkpointLabel("\n\nsecond line is the first real one")).toBe(
      "second line is the first real one",
    );
    expect(checkpointLabel("x".repeat(80))).toBe(`${"x".repeat(47)}…`);
    expect(checkpointLabel("   ")).toBe("");
  });

  it("ages a checkpoint in units a human reads at a glance", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(45_000)).toBe("45 sec ago");
    expect(formatAge(2 * 60_000)).toBe("2 min ago");
    expect(formatAge(3 * 3_600_000)).toBe("3 hr ago");
  });

  it("prints the restore, its scope warning, and any refusal", () => {
    expect(
      undoLines({
        ok: true,
        restored: 3,
        label: "fix the tests",
        ageMs: 120_000,
      }),
    ).toEqual([
      '↩ restored 3 files to before "fix the tests" (2 min ago)',
      expect.stringContaining("undo is one-way"),
    ]);
    expect(
      undoLines({ ok: true, restored: 1, label: "one", ageMs: 0 }),
    ).toEqual([
      '↩ restored 1 file to before "one" (just now)',
      expect.stringContaining("shell commands"),
    ]);
    expect(undoLines({ ok: false, reason: "nothing to undo" })).toEqual([
      "nothing to undo",
    ]);
  });
});
