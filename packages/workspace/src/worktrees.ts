import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isUnder,
  parseWorktreeList,
  realPathOrSelf,
  runGit,
  sanitizeWorktreeSegment,
  splitLines,
  splitNul,
  tryGit,
  WorktreeError,
} from "./git.js";

export type { WorktreeErrorInit } from "./git.js";
export { WorktreeError } from "./git.js";

/** Branch namespace owned by the worktree manager: `agent-task/<runId>/<taskId>`. */
export const WORKTREE_BRANCH_PREFIX = "agent-task";

/**
 * kapel's own state directory, relative to the repository root.
 *
 * Everything under it belongs to kapel, not to the user's project: the
 * project template, the session database (and its `-wal`/`-shm` siblings) and
 * the task checkouts. It is deliberately excluded from the dirty-base check —
 * see {@link TaskWorktreeManager}'s `#dirtyPaths`.
 */
export const AGENT_STATE_DIR = ".agent";

/** Default location of task checkouts, relative to the repository root. */
export const DEFAULT_WORKTREES_DIR = join(AGENT_STATE_DIR, "worktrees");

/** Unified diffs are capped so a runaway task cannot blow up memory or a model prompt. */
export const MAX_DIFF_CHARS = 400_000;

/**
 * Total attempts for `git worktree add`, including the first. Guards against
 * a known upstream git race (see {@link isWorktreeAddRace}): two `worktree
 * add` invocations running concurrently against the same repository can each
 * read the other's half-initialized `.git/worktrees/<name>/` admin directory
 * and fail with "failed to read .../commondir" or ".../gitdir", even though
 * every input (branch, path, base commit) is otherwise valid. A bare retry
 * clears it, because the sibling's admin directory has always finished
 * initializing by the time the failed attempt is cleaned up and retried.
 */
const WORKTREE_ADD_MAX_ATTEMPTS = 3;

/**
 * True for the specific transient failure `git worktree add` produces when it
 * loses a race against a *different* concurrent `worktree add` on the same
 * repository — never for a deterministic error (bad ref, path collision,
 * branch already exists), which must still fail immediately and clearly.
 */
function isWorktreeAddRace(stderr: string): boolean {
  return (
    /fatal:/.test(stderr) &&
    /\.git[/\\]worktrees[/\\]/.test(stderr) &&
    /\b(commondir|gitdir)\b/.test(stderr)
  );
}

const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "AGENT",
  GIT_AUTHOR_EMAIL: "agent@localhost",
  GIT_COMMITTER_NAME: "AGENT",
  GIT_COMMITTER_EMAIL: "agent@localhost",
} as const;

/** Environment for commit-producing git calls: identity inline, never from user config. */
function commitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...COMMIT_IDENTITY };
}

export interface TaskWorktree {
  /** Absolute path of the isolated checkout. */
  readonly path: string;
  /** Branch created for the task, `agent-task/<runId>/<taskId>`. */
  readonly branch: string;
  /** Repository HEAD at creation time; the merge base for collect/integrate. */
  readonly baseCommit: string;
  /** Sanitized run identifier. */
  readonly runId: string;
  /** Sanitized task identifier. */
  readonly taskId: string;
}

export interface WorktreeCollectResult {
  /** False when the worktree had no changes to commit. */
  readonly committed: boolean;
  /** Hash of the new commit, when one was made. */
  readonly commit?: string;
  readonly changedFiles: readonly string[];
  /** Unified diff `base..HEAD`, truncated (with an inline note) at {@link MAX_DIFF_CHARS}. */
  readonly diff: string;
}

export interface WorktreeIntegrateResult {
  readonly merged: boolean;
  /** Base-branch commit after a successful merge (or the untouched HEAD for a no-op). */
  readonly commit?: string;
  /** Conflicting paths; non-empty when `merged === false` because of conflicts. */
  readonly conflictFiles: readonly string[];
  readonly reason?: "conflicts" | "dirty-base" | "error";
  readonly detail?: string;
}

export interface TaskWorktreeManagerOptions {
  readonly repoRoot: string;
  /** Defaults to `<repoRoot>/.agent/worktrees`; created on demand (`mkdir -p`). */
  readonly worktreesDir?: string;
}

export interface RecoveryReport {
  /** Worktree checkouts under the worktrees dir that were unregistered and deleted. */
  readonly prunedWorktrees: readonly string[];
  /** `agent-task/*` branches that were deleted. */
  readonly removedBranches: readonly string[];
  /** `agent-task/*` branches left in place (still checked out, or `removeBranches` off). */
  readonly kept: readonly string[];
}

export interface RecoverOptions {
  /** Delete `agent-task/*` branches that are not checked out anywhere. */
  readonly removeBranches?: boolean;
  /** Override the scanned worktrees directory; defaults to `<repoRoot>/.agent/worktrees`. */
  readonly worktreesDir?: string;
}

export interface RemoveOptions {
  /** Keep the task branch (e.g. so a conflict can be resolved by hand later). */
  readonly keepBranch?: boolean;
}

/**
 * Per-task Git worktree lifecycle.
 *
 * `create()` is safe to call concurrently for distinct tasks: `git worktree add`
 * takes its own locks and every task gets its own branch and directory.
 * `integrate()` is serialized per manager instance by an internal promise mutex,
 * because concurrent merges into a single base branch race on the index and on
 * HEAD; callers may issue parallel `integrate()` calls and each will wait its turn.
 */
export class TaskWorktreeManager {
  readonly repoRoot: string;
  readonly worktreesDir: string;

  /** Tail of the integrate queue; never rejects. */
  #integrateQueue: Promise<void> = Promise.resolve();

  constructor(options: TaskWorktreeManagerOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.worktreesDir =
      options.worktreesDir === undefined
        ? join(this.repoRoot, DEFAULT_WORKTREES_DIR)
        : resolve(options.worktreesDir);
  }

  /**
   * Creates an isolated checkout of the current repository HEAD on a fresh
   * `agent-task/<runId>/<taskId>` branch. Leftovers from a previous attempt
   * (stale directory and/or branch) are removed first so retries start clean.
   *
   * Multiple tasks may call this concurrently for the same manager/repo (see
   * the class doc); `#addWorktree` absorbs the one git-level race that
   * genuinely follows from that.
   */
  async create(
    runId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskWorktree> {
    const safeRunId = sanitizeWorktreeSegment(runId, "runId");
    const safeTaskId = sanitizeWorktreeSegment(taskId, "taskId");
    const branch = `${WORKTREE_BRANCH_PREFIX}/${safeRunId}/${safeTaskId}`;
    const path = join(this.worktreesDir, safeRunId, safeTaskId);

    const baseCommit = await this.#requireRepoHead(signal);

    await this.#removeLeftovers(path, branch, signal);
    await mkdir(dirname(path), { recursive: true });

    await this.#addWorktree(path, branch, baseCommit, signal);

    return { path, branch, baseCommit, runId: safeRunId, taskId: safeTaskId };
  }

  /**
   * Runs `git worktree add`, retrying past {@link isWorktreeAddRace} up to
   * {@link WORKTREE_ADD_MAX_ATTEMPTS} times. Any other failure — including a
   * race-shaped one on the final attempt — surfaces immediately as a
   * {@link WorktreeError}, exactly as a single `runGit` call would have.
   */
  async #addWorktree(
    path: string,
    branch: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; attempt <= WORKTREE_ADD_MAX_ATTEMPTS; attempt++) {
      const result = await tryGit(
        ["worktree", "add", path, "-b", branch, baseCommit],
        { cwd: this.repoRoot, operation: "create", signal },
      );
      if (result.exitCode === 0) {
        return;
      }
      const isLastAttempt = attempt === WORKTREE_ADD_MAX_ATTEMPTS;
      if (isLastAttempt || !isWorktreeAddRace(result.stderr)) {
        throw new WorktreeError({
          operation: "create",
          message: `git worktree add ${path} -b ${branch} ${baseCommit} failed with exit code ${result.exitCode}`,
          stderr: result.stderr.trim() || undefined,
        });
      }
      // Lost the race: the failed attempt may have left a half-registered
      // worktree and/or the branch it was about to create. Clear both before
      // retrying, the same way #removeLeftovers does for a stale prior run.
      await tryGit(["worktree", "remove", "--force", path], {
        cwd: this.repoRoot,
        operation: "create.retry-cleanup-worktree",
        signal,
      });
      await rm(path, { recursive: true, force: true });
      await tryGit(["worktree", "prune"], {
        cwd: this.repoRoot,
        operation: "create.retry-prune",
        signal,
      });
      await tryGit(["branch", "-D", branch], {
        cwd: this.repoRoot,
        operation: "create.retry-cleanup-branch",
        signal,
      });
    }
  }

  /**
   * Stages everything in the worktree and commits it with an inline agent
   * identity (no dependency on global git config), then reports the changed
   * files and unified diff relative to the base commit.
   */
  async collect(
    worktree: TaskWorktree,
    message?: string,
    signal?: AbortSignal,
  ): Promise<WorktreeCollectResult> {
    const cwd = worktree.path;
    await runGit(["add", "-A"], { cwd, operation: "collect.add", signal });

    const staged = await tryGit(["diff", "--cached", "--quiet"], {
      cwd,
      operation: "collect.status",
      signal,
    });
    if (staged.exitCode === 0) {
      return { committed: false, changedFiles: [], diff: "" };
    }
    if (staged.exitCode !== 1) {
      throw new WorktreeError({
        operation: "collect.status",
        message: `git diff --cached failed with exit code ${staged.exitCode}`,
        stderr: staged.stderr.trim() || undefined,
      });
    }

    const commitMessage = message ?? `agent task ${worktree.taskId}`;
    await runGit(["commit", "--no-verify", "-m", commitMessage], {
      cwd,
      operation: "collect.commit",
      signal,
      env: commitEnv(),
    });

    const head = await runGit(["rev-parse", "HEAD"], {
      cwd,
      operation: "collect.head",
      signal,
    });
    const range = `${worktree.baseCommit}..HEAD`;
    const names = await runGit(["diff", "--name-only", range], {
      cwd,
      operation: "collect.changed-files",
      signal,
    });
    const diff = await runGit(["diff", range], {
      cwd,
      operation: "collect.diff",
      signal,
    });

    return {
      committed: true,
      commit: head.stdout.trim(),
      changedFiles: splitLines(names.stdout),
      diff: truncateDiff(diff.stdout),
    };
  }

  /**
   * Merges a task branch back into the repository's checked-out base branch.
   * Serialized per manager; refuses to run against a dirty base; aborts and
   * reports conflicts instead of leaving a merge in progress.
   */
  async integrate(
    worktree: TaskWorktree,
    signal?: AbortSignal,
  ): Promise<WorktreeIntegrateResult> {
    const run = this.#integrateQueue.then(() =>
      this.#integrateLocked(worktree, signal),
    );
    this.#integrateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #integrateLocked(
    worktree: TaskWorktree,
    signal?: AbortSignal,
  ): Promise<WorktreeIntegrateResult> {
    const cwd = this.repoRoot;

    const branchExists = await tryGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`],
      { cwd, operation: "integrate.verify", signal },
    );
    if (branchExists.exitCode !== 0) {
      return {
        merged: false,
        conflictFiles: [],
        reason: "error",
        detail: `branch ${worktree.branch} does not exist`,
      };
    }

    // No commits beyond the base: nothing to merge, so the base is left alone.
    const ahead = await runGit(
      ["rev-list", "--count", `${worktree.baseCommit}..${worktree.branch}`],
      { cwd, operation: "integrate.rev-list", signal },
    );
    if (Number.parseInt(ahead.stdout.trim(), 10) === 0) {
      const head = await runGit(["rev-parse", "HEAD"], {
        cwd,
        operation: "integrate.head",
        signal,
      });
      return { merged: true, commit: head.stdout.trim(), conflictFiles: [] };
    }

    const dirty = await this.#dirtyPaths(signal);
    if (dirty.length > 0) {
      // Naming the paths isn't enough on its own to unblock the merge; say
      // what to do about them too, since they are real user files by the
      // time they reach here (kapel's own `.agent/` state never counts, see
      // `#dirtyPaths`).
      return {
        merged: false,
        conflictFiles: [],
        reason: "dirty-base",
        detail: `base working tree has uncommitted changes: ${dirty
          .slice(0, 10)
          .join(
            ", ",
          )}; commit or stash them, or add generated files to .gitignore`,
      };
    }

    const merge = await tryGit(
      [
        "merge",
        "--no-ff",
        "-m",
        `merge agent task ${worktree.taskId}`,
        worktree.branch,
      ],
      { cwd, operation: "integrate.merge", signal, env: commitEnv() },
    );

    if (merge.exitCode === 0) {
      const head = await runGit(["rev-parse", "HEAD"], {
        cwd,
        operation: "integrate.head",
        signal,
      });
      return { merged: true, commit: head.stdout.trim(), conflictFiles: [] };
    }

    const unmerged = await tryGit(["diff", "--name-only", "--diff-filter=U"], {
      cwd,
      operation: "integrate.conflicts",
      signal,
    });
    const conflictFiles = splitLines(unmerged.stdout);
    // Always leave the base clean: no merge in progress after a failed merge.
    await tryGit(["merge", "--abort"], {
      cwd,
      operation: "integrate.abort",
      signal,
    });

    const detail = `${merge.stdout}${merge.stderr}`.trim();
    if (conflictFiles.length > 0 || merge.stdout.includes("CONFLICT")) {
      return {
        merged: false,
        conflictFiles,
        reason: "conflicts",
        ...(detail === "" ? {} : { detail }),
      };
    }
    return {
      merged: false,
      conflictFiles: [],
      reason: "error",
      ...(detail === "" ? {} : { detail }),
    };
  }

  /**
   * Unregisters and deletes the checkout, and (unless `keepBranch`) deletes the
   * task branch. Already-removed worktrees and branches are tolerated.
   */
  async remove(
    worktree: TaskWorktree,
    opts?: RemoveOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const cwd = this.repoRoot;
    await tryGit(["worktree", "remove", "--force", worktree.path], {
      cwd,
      operation: "remove.worktree",
      signal,
    });
    await rm(worktree.path, { recursive: true, force: true });
    // Drops the registration when the directory was deleted out from under git.
    await tryGit(["worktree", "prune"], {
      cwd,
      operation: "remove.prune",
      signal,
    });
    if (opts?.keepBranch !== true) {
      await tryGit(["branch", "-D", worktree.branch], {
        cwd,
        operation: "remove.branch",
        signal,
      });
    }
    // Tidy the per-run directory when it is empty; ignore anything else.
    await rmdir(dirname(worktree.path)).catch(() => undefined);
  }

  /**
   * Crash cleanup: prunes stale registrations, removes every worktree under the
   * worktrees directory, and reports `agent-task/*` branches — deleting the ones
   * that are no longer checked out when `removeBranches` is set. Branches outside
   * the `agent-task/` namespace are never touched.
   */
  static async recover(
    repoRoot: string,
    opts?: RecoverOptions,
  ): Promise<RecoveryReport> {
    const cwd = resolve(repoRoot);
    const worktreesDir =
      opts?.worktreesDir === undefined
        ? join(cwd, DEFAULT_WORKTREES_DIR)
        : resolve(opts.worktreesDir);
    const realWorktreesDir = await realPathOrSelf(worktreesDir);
    const realRepoRoot = await realPathOrSelf(cwd);

    await runGit(["worktree", "prune"], { cwd, operation: "recover.prune" });

    const listed = await runGit(["worktree", "list", "--porcelain"], {
      cwd,
      operation: "recover.list",
    });
    const prunedWorktrees: string[] = [];
    for (const entry of parseWorktreeList(listed.stdout)) {
      const real = await realPathOrSelf(entry.path);
      if (real === realRepoRoot || !isUnder(realWorktreesDir, real)) {
        continue;
      }
      await tryGit(["worktree", "remove", "--force", entry.path], {
        cwd,
        operation: "recover.remove",
      });
      await rm(entry.path, { recursive: true, force: true });
      prunedWorktrees.push(entry.path);
    }
    await runGit(["worktree", "prune"], { cwd, operation: "recover.prune" });

    const refs = await runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${WORKTREE_BRANCH_PREFIX}/`,
      ],
      { cwd, operation: "recover.branches" },
    );
    const remaining = await runGit(["worktree", "list", "--porcelain"], {
      cwd,
      operation: "recover.list",
    });
    const checkedOut = new Set(
      parseWorktreeList(remaining.stdout)
        .map((entry) => entry.branch)
        .filter((branch): branch is string => branch !== undefined),
    );

    const removedBranches: string[] = [];
    const kept: string[] = [];
    for (const branch of splitLines(refs.stdout)) {
      if (opts?.removeBranches !== true || checkedOut.has(branch)) {
        kept.push(branch);
        continue;
      }
      const deleted = await tryGit(["branch", "-D", branch], {
        cwd,
        operation: "recover.branch-delete",
      });
      if (deleted.exitCode === 0) {
        removedBranches.push(branch);
      } else {
        kept.push(branch);
      }
    }

    return { prunedWorktrees, removedBranches, kept };
  }

  async #requireRepoHead(signal?: AbortSignal): Promise<string> {
    const inside = await tryGit(["rev-parse", "--git-dir"], {
      cwd: this.repoRoot,
      operation: "create.verify-repo",
      signal,
    });
    if (inside.exitCode !== 0) {
      throw new WorktreeError({
        operation: "create.verify-repo",
        message: `${this.repoRoot} is not a git repository`,
        stderr: inside.stderr.trim() || undefined,
      });
    }
    const head = await tryGit(["rev-parse", "HEAD"], {
      cwd: this.repoRoot,
      operation: "create.head",
      signal,
    });
    if (head.exitCode !== 0) {
      throw new WorktreeError({
        operation: "create.head",
        message: `${this.repoRoot} has no commits yet; commit before creating task worktrees`,
        stderr: head.stderr.trim() || undefined,
      });
    }
    return head.stdout.trim();
  }

  async #removeLeftovers(
    path: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await tryGit(["worktree", "remove", "--force", path], {
      cwd: this.repoRoot,
      operation: "create.cleanup-worktree",
      signal,
    });
    await rm(path, { recursive: true, force: true });
    await tryGit(["worktree", "prune"], {
      cwd: this.repoRoot,
      operation: "create.prune",
      signal,
    });
    await tryGit(["branch", "-D", branch], {
      cwd: this.repoRoot,
      operation: "create.cleanup-branch",
      signal,
    });
  }

  /**
   * Uncommitted paths in the base checkout that would make a merge unsafe.
   *
   * Two things are excluded, and only two. The worktrees directory, because
   * task checkouts nested inside the repository always look untracked to git.
   * And the rest of `.agent/`, because that is kapel's own state — the
   * template `kapel init` writes, and the `sessions.db` the REPL opens the
   * moment a conversation starts. Neither is the user's work, both are
   * routinely untracked (or tracked and modified, as `sessions.db` is once
   * someone commits it), and letting either veto the merge meant that on a
   * fresh repository *every* task came back "dirty-base" and every completed
   * task's work was thrown away. kapel-owned state must never block a merge;
   * anything else in the tree still does.
   */
  async #dirtyPaths(signal?: AbortSignal): Promise<string[]> {
    const status = await runGit(
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      { cwd: this.repoRoot, operation: "integrate.status", signal },
    );
    const ignored = this.#worktreesPrefix();
    const paths: string[] = [];
    for (const record of splitNul(status.stdout)) {
      const path =
        record.length > 3 && record[2] === " " ? record.slice(3) : record;
      if (ignored !== undefined && path.startsWith(ignored)) {
        continue;
      }
      if (isAgentStatePath(path)) {
        continue;
      }
      paths.push(path);
    }
    return paths;
  }

  /** Repo-relative, slash-separated prefix of the worktrees dir, when nested inside. */
  #worktreesPrefix(): string | undefined {
    const rel = relative(this.repoRoot, this.worktreesDir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return undefined;
    }
    return `${rel.split(sep).join("/")}/`;
  }
}

/**
 * True for a repo-relative path inside kapel's own `.agent/` state directory
 * (or for the directory entry itself, which is what `git status` reports when
 * `.agent/` is ignored wholesale).
 */
function isAgentStatePath(path: string): boolean {
  return (
    path === AGENT_STATE_DIR ||
    path === `${AGENT_STATE_DIR}/` ||
    path.startsWith(`${AGENT_STATE_DIR}/`)
  );
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated after ${MAX_DIFF_CHARS} characters]\n`;
}
