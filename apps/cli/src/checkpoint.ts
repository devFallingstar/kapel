import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Big enough for a path list covering a whole worktree. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * How many checkpoints one session keeps. Older ones fall off the bottom: the
 * dangling commit they named stays in the object database until git's own
 * garbage collection reaches it, but nothing points at it any more.
 */
export const MAX_CHECKPOINTS = 20;

/** How much of the prompt's first line identifies a checkpoint in `/undo`. */
const MAX_LABEL_CHARS = 48;

/**
 * kapel's own state directory: the session database, run records and task
 * worktrees live here. It is never captured and never restored — reverting a
 * SQLite file under the handle that is writing it corrupts the conversation
 * this very command is part of, and `/undo` has no business rewinding another
 * checkout.
 */
const EXCLUDED_DIR = ".agent";

/**
 * The identity checkpoint commits are written with, inline rather than from
 * the user's configuration: `commit-tree` refuses to run without one, and a
 * machine that has never configured git should still get checkpoints.
 */
const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: "kapel",
  GIT_AUTHOR_EMAIL: "kapel@localhost",
  GIT_COMMITTER_NAME: "kapel",
  GIT_COMMITTER_EMAIL: "kapel@localhost",
} as const;

/**
 * How far the copied index is backdated so git keeps treating recently
 * touched files as racily clean. One second covers filesystems that store
 * whole-second timestamps, which is the case the protection exists for.
 */
const RACY_MARGIN_MS = 1000;

/** Paths per `checkout-index` call, so a huge restore cannot blow the arg list. */
const RESTORE_BATCH = 200;

/** A `.git` entry that means some multi-step git operation is half-finished. */
const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["BISECT_LOG", "a bisect"],
];

// --- The stored checkpoint --------------------------------------------------

/** One captured working tree, named by the prompt it was taken before. */
export interface CheckpointEntry {
  /** The dangling commit object wrapping {@link tree}. */
  readonly commit: string;
  /** The tree object `/undo` restores from. */
  readonly tree: string;
  readonly createdAt: number;
  /** The prompt's first line, trimmed to something printable. */
  readonly label: string;
}

export type UndoOutcome =
  | {
      readonly ok: true;
      /** How many paths the restore touched — created, rewritten or deleted. */
      readonly restored: number;
      readonly label: string;
      readonly ageMs: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Per-prompt working-tree checkpoints, and the `/undo` that walks them back.
 *
 * Injectable on purpose: the interactive controller only ever sees this
 * interface, so its own tests can drive `/undo` with a stand-in and leave the
 * real git plumbing to `checkpoint.test.ts`.
 */
export interface CheckpointStore {
  /**
   * Snapshots the working tree before a prompt starts a turn.
   *
   * Never throws and never blocks the turn: a repository that cannot be
   * snapshotted returns one printable warning — once per session, because a
   * failure here repeats on every prompt — and the turn runs uncheckpointed.
   */
  capture(prompt: string): Promise<string | undefined>;
  /** Restores the newest checkpoint and pops it. */
  undo(): Promise<UndoOutcome>;
  /** Oldest first. Exposed for tests and for the retention cap's sake. */
  entries(): readonly CheckpointEntry[];
}

// --- Formatting -------------------------------------------------------------

/** The prompt's first non-empty line, collapsed and clipped for one-line use. */
export function checkpointLabel(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > MAX_LABEL_CHARS
    ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
    : collapsed;
}

/** `just now` / `45 sec ago` / `2 min ago` / `1 hr ago` — coarse on purpose. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} hr ago`;
}

/**
 * What `/undo` prints.
 *
 * The second line is not decoration: a checkpoint is a snapshot of the whole
 * repository, so restoring it also reverts anything else that touched those
 * files in the meantime — a `bash` command the agent ran, an editor, another
 * terminal. Saying so every time is the honest version of "undo".
 */
export function undoLines(outcome: UndoOutcome): readonly string[] {
  if (!outcome.ok) return [outcome.reason];
  const age = formatAge(outcome.ageMs);
  const quoted =
    outcome.label === "" ? "the last prompt" : `"${outcome.label}"`;
  if (outcome.restored === 0) {
    return [`↩ nothing had changed since ${quoted} (${age})`];
  }
  const plural = outcome.restored === 1 ? "" : "s";
  return [
    `↩ restored ${outcome.restored} file${plural} to before ${quoted} (${age})`,
    "  every edit since then is gone, including ones made by shell commands or other programs — undo is one-way",
  ];
}

// --- git plumbing -----------------------------------------------------------

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs `git` with `execFile` (never a shell) and reports failure as a value.
 *
 * Nothing on the checkpoint path may throw its way into a turn, so even a
 * missing git binary comes back as a non-zero result.
 */
async function git(
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      ...(env === undefined ? {} : { env }),
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? String(error),
      exitCode: typeof value.code === "number" ? value.code : 127,
    };
  }
}

function failure(operation: string, result: GitResult): Error {
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return new Error(
    detail === ""
      ? `git ${operation} failed (exit ${result.exitCode})`
      : `git ${operation} failed: ${detail}`,
  );
}

/** The repository a workspace belongs to: its top level and its `.git` dir. */
interface RepoInfo {
  /** Top level of the work tree — every git call below runs from here. */
  readonly root: string;
  readonly gitDir: string;
}

async function detectRepo(
  workspacePath: string,
): Promise<RepoInfo | undefined> {
  const root = await git(["rev-parse", "--show-toplevel"], workspacePath);
  if (root.exitCode !== 0) return undefined;
  const gitDir = await git(["rev-parse", "--absolute-git-dir"], workspacePath);
  if (gitDir.exitCode !== 0) return undefined;
  const top = root.stdout.trim();
  const dir = gitDir.stdout.trim();
  if (top === "" || dir === "") return undefined;
  return { root: top, gitDir: dir };
}

/** The scratch root for temporary index files; test runs can redirect it. */
async function tempRoot(): Promise<string> {
  const root = process.env.AGENT_TEST_TMPDIR || tmpdir();
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Runs `fn` against a private index file, so nothing here can disturb the
 * real one.
 *
 * `seed` copies the repository's index in first. That is mostly an
 * optimization — with the index's stat cache in place `git add -A` re-hashes
 * only the files that actually changed instead of the whole worktree, which
 * is the difference between a checkpoint costing milliseconds and costing a
 * full `git status` on a large repository. The copy is read-only from git's
 * point of view: every write lands on the temporary file.
 *
 * The copy's own timestamp is then backdated, and that is not cosmetic. Git
 * decides whether a cached stat can be trusted by comparing an entry's mtime
 * against the *index file's* mtime: entries at or after it are "racily clean"
 * and get their content re-read, which is what stops a same-second edit of
 * the same length from hiding behind an unchanged stat. A fresh copy carries
 * a fresh mtime, which would silently switch that protection off — and a
 * checkpoint that missed the edit made a second ago is worse than none.
 * Backdating restores it, at the cost of re-reading only the handful of files
 * touched around the last real index write.
 */
async function withTempIndex<T>(
  repo: RepoInfo,
  seed: boolean,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(await tempRoot(), "kapel-checkpoint-"));
  try {
    const indexPath = path.join(dir, "index");
    if (seed) {
      const source = path.join(repo.gitDir, "index");
      try {
        const original = await stat(source);
        await copyFile(source, indexPath);
        const asOf = new Date(original.mtimeMs - RACY_MARGIN_MS);
        await utimes(indexPath, asOf, asOf);
      } catch {
        // No index yet (a repository with no commits and nothing staged):
        // starting from an empty one produces the same tree, just slower.
      }
    }
    return await fn({ ...process.env, GIT_INDEX_FILE: indexPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Hashes the current working tree into a tree object, with no side effects.
 *
 * `git stash create` would be the obvious tool and is the wrong one: it does
 * not cover untracked files, which is most of what an agent creates in a
 * turn. Staging everything against a *temporary* index instead covers tracked
 * modifications, deletions and untracked files in one pass, while the real
 * index, the worktree and the stash list are all left exactly as they were.
 *
 * What is not covered: anything `.gitignore` excludes (`node_modules/`,
 * build output, `.env`), and `.agent/`. Those are never restored either, so
 * the two halves stay consistent.
 */
async function snapshotTree(repo: RepoInfo): Promise<string> {
  return await withTempIndex(repo, true, async (env) => {
    const added = await git(
      ["add", "-A", "--", ".", `:(exclude)${EXCLUDED_DIR}`],
      repo.root,
      env,
    );
    if (added.exitCode !== 0) throw failure("add", added);
    const written = await git(["write-tree"], repo.root, env);
    if (written.exitCode !== 0) throw failure("write-tree", written);
    const tree = written.stdout.trim();
    if (tree === "") throw new Error("git write-tree produced no tree");
    return tree;
  });
}

/**
 * Wraps a snapshot tree in a commit object that nothing references.
 *
 * The commit is not needed to restore — the tree alone would do — but it
 * carries the timestamp and the prompt, and it is what makes a lost
 * checkpoint recoverable by hand (`git fsck --lost-found`, `git show <hash>`)
 * after the process that held it is gone.
 */
async function commitSnapshot(
  repo: RepoInfo,
  tree: string,
  label: string,
): Promise<string> {
  const head = await git(
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    repo.root,
  );
  const parent = head.exitCode === 0 ? head.stdout.trim() : "";
  const result = await git(
    [
      "commit-tree",
      tree,
      ...(parent === "" ? [] : ["-p", parent]),
      "--no-gpg-sign",
      "-m",
      `kapel checkpoint: ${label}`,
    ],
    repo.root,
    { ...process.env, ...CHECKPOINT_IDENTITY },
  );
  if (result.exitCode !== 0) throw failure("commit-tree", result);
  return result.stdout.trim();
}

function isExcluded(relativePath: string): boolean {
  return (
    relativePath === EXCLUDED_DIR || relativePath.startsWith(`${EXCLUDED_DIR}/`)
  );
}

interface TreeChange {
  /** `D` means "delete it from the worktree"; anything else means "write it". */
  readonly status: string;
  readonly path: string;
}

/**
 * The paths that differ between two trees, as seen from `from` towards `to`.
 *
 * `--raw` rather than `--name-status` so submodules can be recognized by
 * their `160000` mode and skipped: `/undo` restores files, and rewinding
 * somebody's submodule checkout is not that.
 */
async function diffTrees(
  repo: RepoInfo,
  from: string,
  to: string,
): Promise<readonly TreeChange[]> {
  const result = await git(
    ["diff", "--raw", "-z", "--no-renames", from, to],
    repo.root,
  );
  if (result.exitCode !== 0) throw failure("diff", result);
  const fields = result.stdout.split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const meta = fields[i];
    if (meta === undefined || !meta.startsWith(":")) continue;
    const target = fields[i + 1];
    i += 1;
    if (target === undefined || target === "" || isExcluded(target)) continue;
    const parts = meta.slice(1).split(" ");
    const srcMode = parts[0] ?? "";
    const dstMode = parts[1] ?? "";
    const status = parts[4] ?? "";
    if (srcMode === "160000" || dstMode === "160000") continue;
    changes.push({ status, path: target });
  }
  return changes;
}

/** Removes now-empty parent directories, the way a checkout would. */
async function pruneEmptyParents(
  root: string,
  filePath: string,
): Promise<void> {
  let dir = path.dirname(path.join(root, filePath));
  while (dir !== root && dir.startsWith(`${root}${path.sep}`)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Writes the snapshot's version of `paths` into the worktree. */
async function checkoutPaths(
  repo: RepoInfo,
  tree: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await withTempIndex(repo, false, async (env) => {
    const read = await git(["read-tree", tree], repo.root, env);
    if (read.exitCode !== 0) throw failure("read-tree", read);
    for (let i = 0; i < paths.length; i += RESTORE_BATCH) {
      const batch = paths.slice(i, i + RESTORE_BATCH);
      const checkedOut = await git(
        ["checkout-index", "-f", "--", ...batch],
        repo.root,
        env,
      );
      if (checkedOut.exitCode !== 0)
        throw failure("checkout-index", checkedOut);
    }
  });
}

/** The half-finished git operation blocking `/undo`, if there is one. */
async function inProgressOperation(
  gitDir: string,
): Promise<string | undefined> {
  for (const [entry, description] of IN_PROGRESS) {
    try {
      await stat(path.join(gitDir, entry));
      return description;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

// --- The store ---------------------------------------------------------------

export interface CheckpointStoreOptions {
  /** Where the conversation is running; the repository is found from here. */
  readonly workspacePath: string;
  readonly now?: () => number;
  /** How many checkpoints to keep. Defaults to {@link MAX_CHECKPOINTS}. */
  readonly limit?: number;
}

function notARepositoryReason(workspacePath: string): string {
  return `/undo needs a git repository — ${workspacePath} is not inside one, so nothing was checkpointed. Run \`git init\` to get undo.`;
}

/**
 * Builds the real, git-backed checkpoint store.
 *
 * Checkpoints live in this process's memory only. They are deliberately not
 * persisted: the objects behind them are unreferenced, so a later run could
 * find them already collected, and a `/undo` that silently restores a tree
 * from a previous week would be worse than no `/undo` at all.
 */
export function createCheckpointStore(
  options: CheckpointStoreOptions,
): CheckpointStore {
  const now = options.now ?? (() => Date.now());
  const limit = options.limit ?? MAX_CHECKPOINTS;
  const stack: CheckpointEntry[] = [];
  let repo: RepoInfo | undefined;
  let warned = false;

  /** Positive results are cached; a negative one is retried (`git init` happens). */
  const resolveRepo = async (): Promise<RepoInfo | undefined> => {
    if (repo !== undefined) return repo;
    repo = await detectRepo(options.workspacePath);
    return repo;
  };

  const capture = async (prompt: string): Promise<string | undefined> => {
    const info = await resolveRepo();
    // Not a repository: no checkpoint, and no noise on every prompt either.
    // `/undo` is where that gets explained, because that is where it matters.
    if (info === undefined) return undefined;
    try {
      const tree = await snapshotTree(info);
      const label = checkpointLabel(prompt);
      const commit = await commitSnapshot(info, tree, label);
      stack.push({ commit, tree, createdAt: now(), label });
      while (stack.length > limit) stack.shift();
      return undefined;
    } catch (error) {
      if (warned) return undefined;
      warned = true;
      const message = error instanceof Error ? error.message : String(error);
      return `(checkpoint failed, /undo will not cover this turn: ${message})`;
    }
  };

  const undo = async (): Promise<UndoOutcome> => {
    const info = await resolveRepo();
    if (info === undefined) {
      return { ok: false, reason: notARepositoryReason(options.workspacePath) };
    }
    const entry = stack[stack.length - 1];
    if (entry === undefined) {
      return {
        ok: false,
        reason:
          "nothing to undo — no checkpoint has been taken in this session yet.",
      };
    }
    const busy = await inProgressOperation(info.gitDir);
    if (busy !== undefined) {
      return {
        ok: false,
        reason: `/undo is unavailable while ${busy} is in progress — finish or abort it first, then try again. The checkpoint is kept.`,
      };
    }

    try {
      // Diffing the snapshot against a snapshot of *now* is what makes the
      // restore exact in both directions: files the turn created are as
      // visible as the ones it changed, and everything the snapshot never
      // covered (ignored paths, `.agent/`) is absent from both sides and so
      // is left alone.
      const current = await snapshotTree(info);
      const changes = await diffTrees(info, current, entry.tree);
      const removals = changes.filter((change) => change.status === "D");
      const writes = changes.filter((change) => change.status !== "D");

      await checkoutPaths(
        info,
        entry.tree,
        writes.map((change) => change.path),
      );
      for (const change of removals) {
        await rm(path.join(info.root, change.path), { force: true });
        await pruneEmptyParents(info.root, change.path);
      }

      stack.pop();
      return {
        ok: true,
        restored: changes.length,
        label: entry.label,
        ageMs: Math.max(0, now() - entry.createdAt),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The checkpoint stays on the stack: a restore that stopped halfway is
      // a reason to try again, not a reason to lose the only way back.
      return {
        ok: false,
        reason: `/undo could not restore the working tree: ${message}`,
      };
    }
  };

  return {
    capture,
    undo,
    entries: () => stack.slice(),
  };
}
