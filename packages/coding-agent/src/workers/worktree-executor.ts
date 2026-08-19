import {
  MUTATING_TASK_TYPES,
  type RuntimeTask,
  type TaskResult,
  type WorkerExecutionContext,
  type WorkerExecutor,
} from "@agent/orchestration";
import type { EventSink } from "@agent/protocol";
import type {
  TaskWorktree,
  WorktreeCollectResult,
  WorktreeIntegrateResult,
} from "@agent/workspace";
import { TaskWorktreeManager } from "@agent/workspace";
import { failedTaskResult } from "./normalize.js";

/** How many conflicting/changed paths a message names before it says "and N more". */
const MAX_LISTED_FILES = 10;

/** Builds the inner executor for one workspace root. */
export type WorkspaceExecutorFactory = (
  workspacePath: string,
) => WorkerExecutor;

export interface WorktreeIsolatedExecutorOptions {
  /** The orchestration workspace root; must be a git repository with a commit. */
  readonly repoRoot: string;
  /** Builds the executor that actually runs the task, rooted at a given path. */
  readonly createExecutor: WorkspaceExecutorFactory;
  /** Defaults to a {@link TaskWorktreeManager} over `repoRoot`. */
  readonly manager?: TaskWorktreeManager;
  readonly events?: EventSink;
  readonly runId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listFiles(files: readonly string[]): string {
  if (files.length === 0) return "(no files reported)";
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  return files.length <= MAX_LISTED_FILES
    ? shown
    : `${shown} (and ${files.length - MAX_LISTED_FILES} more)`;
}

function keptBranchIssue(branch: string): string {
  return `The task branch ${branch} was kept for inspection; merge or delete it by hand.`;
}

interface Outcome {
  readonly status?: TaskResult["status"];
  readonly changedFiles: readonly string[];
  /** Replaces the inner result's commit; dropped entirely when undefined. */
  readonly commit?: string | undefined;
  readonly issues?: readonly string[];
}

/**
 * Rebuilds the inner result with the worktree's verdict.
 *
 * `changedFiles` and `commit` are always taken from this layer: the inner
 * executor inspected an isolated checkout, so its idea of "what changed" is
 * relative to a tree the caller never sees, and its `commit` is the base commit
 * the worktree started from rather than anything the task produced.
 */
function finalize(inner: TaskResult, outcome: Outcome): TaskResult {
  const issues = outcome.issues ?? [];
  return {
    taskId: inner.taskId,
    status: outcome.status ?? inner.status,
    summary: inner.summary,
    decisions: inner.decisions,
    changedFiles: outcome.changedFiles,
    ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
    tests: inner.tests,
    unresolvedIssues:
      issues.length === 0
        ? inner.unresolvedIssues
        : [...inner.unresolvedIssues, ...issues],
    confidence: inner.confidence,
  };
}

/**
 * Runs mutating tasks in a private git worktree and merges the result back.
 *
 * The point is that two workers editing the same repository at the same time
 * cannot see each other's half-finished edits: every mutating task gets its own
 * checkout on its own `agent-task/<runId>/<taskId>` branch, and the changes only
 * reach the base branch through a serialized merge once the task has finished.
 * Read-only task types (`exploration`, `review`) skip all of that and run
 * directly in the repository — there is nothing to isolate, and a checkout per
 * question is pure overhead.
 *
 * Collection is unconditional: a worker that fails or crashes can still have
 * left real edits behind, and losing them silently would be worse than
 * reporting a partial result. Nothing here rejects — every worktree failure is
 * folded into a `failed`/`partial` {@link TaskResult}, because the scheduler
 * treats a thrown error as a crashed run.
 */
export class WorktreeIsolatedExecutor implements WorkerExecutor {
  readonly #options: WorktreeIsolatedExecutorOptions;
  readonly #manager: TaskWorktreeManager;

  constructor(options: WorktreeIsolatedExecutorOptions) {
    this.#options = options;
    this.#manager =
      options.manager ??
      new TaskWorktreeManager({ repoRoot: options.repoRoot });
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const taskId = task.spec.id;

    if (!MUTATING_TASK_TYPES.has(task.spec.type)) {
      return this.#options
        .createExecutor(this.#options.repoRoot)
        .execute(task, agent, signal, context);
    }

    let worktree: TaskWorktree;
    try {
      worktree = await this.#manager.create(
        this.#options.runId,
        taskId,
        signal,
      );
    } catch (error) {
      return failedTaskResult(
        taskId,
        `Could not create an isolated worktree for ${taskId}: ${errorMessage(error)}`,
      );
    }
    await this.#emit("worktree.created", taskId, {
      taskId,
      branch: worktree.branch,
      path: worktree.path,
    });

    const inner = await this.#runInner(task, agent, worktree, signal, context);
    return this.#collectAndIntegrate(taskId, task.spec.title, worktree, inner);
  }

  /** Runs the inner executor against the checkout, never letting it throw out. */
  async #runInner(
    task: RuntimeTask,
    agent: string,
    worktree: TaskWorktree,
    signal: AbortSignal | undefined,
    context: WorkerExecutionContext | undefined,
  ): Promise<TaskResult> {
    try {
      return await this.#options
        .createExecutor(worktree.path)
        .execute(task, agent, signal, context);
    } catch (error) {
      return failedTaskResult(
        task.spec.id,
        `Worker crashed inside the task worktree: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * The tail every mutating task runs through: commit whatever is in the
   * checkout, merge it back when the task succeeded, and clean up.
   *
   * The abort signal is deliberately not forwarded past `create`: once a worker
   * has run, collecting and merging its work is exactly what a cancelled run
   * still needs to do, and a git call that aborts halfway would strand the
   * checkout instead of tidying it.
   */
  async #collectAndIntegrate(
    taskId: string,
    title: string,
    worktree: TaskWorktree,
    inner: TaskResult,
  ): Promise<TaskResult> {
    let collected: WorktreeCollectResult;
    try {
      collected = await this.#manager.collect(
        worktree,
        `agent task ${taskId}: ${title}`,
      );
    } catch (error) {
      // The checkout is the only copy of the work at this point, so it is left
      // in place (with its branch) rather than removed along with the edits.
      return finalize(inner, {
        status: inner.status === "failed" ? "failed" : "partial",
        changedFiles: [],
        issues: [
          `Could not collect the task worktree: ${errorMessage(error)}`,
          `The checkout at ${worktree.path} (branch ${worktree.branch}) was left in place.`,
        ],
      });
    }

    if (inner.status !== "success" || !collected.committed) {
      return this.#withoutMerge(taskId, worktree, inner, collected);
    }

    let integrated: WorktreeIntegrateResult;
    try {
      integrated = await this.#manager.integrate(worktree);
    } catch (error) {
      await this.#remove(taskId, worktree, true);
      return finalize(inner, {
        status: "partial",
        changedFiles: collected.changedFiles,
        commit: collected.commit,
        issues: [
          `Could not merge the task branch into the base: ${errorMessage(error)}`,
          keptBranchIssue(worktree.branch),
        ],
      });
    }

    if (integrated.merged) {
      await this.#emit("worktree.integrated", taskId, {
        taskId,
        merged: true,
        ...(integrated.commit === undefined
          ? {}
          : { commit: integrated.commit }),
      });
      await this.#remove(taskId, worktree, false);
      return finalize(inner, {
        changedFiles: collected.changedFiles,
        commit: integrated.commit ?? collected.commit,
      });
    }

    await this.#emit("worktree.integrated", taskId, {
      taskId,
      merged: false,
      conflictFiles: integrated.conflictFiles,
      ...(integrated.reason === undefined ? {} : { reason: integrated.reason }),
    });
    await this.#remove(taskId, worktree, true);
    return finalize(inner, {
      status: "partial",
      changedFiles: collected.changedFiles,
      commit: collected.commit,
      issues: [
        integrated.reason === "conflicts"
          ? `merge conflict with base in: ${listFiles(integrated.conflictFiles)}`
          : `The task branch could not be merged (${integrated.reason ?? "unknown reason"}): ${integrated.detail ?? "no detail reported"}`,
        keptBranchIssue(worktree.branch),
      ],
    });
  }

  /**
   * Finishes a task whose work is not going to be merged: the worker failed,
   * came back partial, or produced nothing at all. A commit that exists is
   * evidence, so its branch survives; an empty checkout leaves nothing behind.
   */
  async #withoutMerge(
    taskId: string,
    worktree: TaskWorktree,
    inner: TaskResult,
    collected: WorktreeCollectResult,
  ): Promise<TaskResult> {
    if (!collected.committed) {
      await this.#remove(taskId, worktree, false);
      return finalize(inner, { changedFiles: [] });
    }

    await this.#remove(taskId, worktree, true);
    return finalize(inner, {
      changedFiles: collected.changedFiles,
      commit: collected.commit,
      issues: [
        `The task did not succeed, so its changes were not merged: ${listFiles(collected.changedFiles)}`,
        keptBranchIssue(worktree.branch),
      ],
    });
  }

  /** Best-effort cleanup: a leaked checkout is recoverable, a thrown error is not. */
  async #remove(
    taskId: string,
    worktree: TaskWorktree,
    keepBranch: boolean,
  ): Promise<void> {
    try {
      await this.#manager.remove(worktree, { keepBranch });
    } catch {
      // `TaskWorktreeManager.recover()` cleans up whatever this leaves behind.
    }
    await this.#emit("worktree.removed", taskId, {
      taskId,
      keptBranch: keepBranch,
      branch: worktree.branch,
    });
  }

  async #emit(
    type: string,
    taskId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const sink = this.#options.events;
    if (sink === undefined) return;
    try {
      await sink.emit({
        id: crypto.randomUUID(),
        runId: this.#options.runId,
        timestamp: Date.now(),
        type,
        taskId,
        data,
      });
    } catch {
      // Event emission is best-effort and must never fail a task.
    }
  }
}
