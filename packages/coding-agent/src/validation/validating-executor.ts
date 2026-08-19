import {
  MUTATING_TASK_TYPES,
  type RuntimeTask,
  type TaskResult,
  type WorkerExecutionContext,
  type WorkerExecutor,
} from "@agent/orchestration";
import type { EventSink } from "@agent/protocol";
import type { ProjectValidator } from "../project/index.js";
import type { ValidationReport, ValidatorOutcome } from "./runner.js";
import { runValidators } from "./runner.js";

/** How much of a failing validator's output is quoted onto the task result. */
const MAX_ISSUE_OUTPUT_CHARS = 1000;

/**
 * Confidence attached to a result that validation rejected.
 *
 * Low, but not as low as a crashed worker (0.1): the work exists and may be
 * most of the way there, it just does not build/test clean.
 */
const FAILED_VALIDATION_CONFIDENCE = 0.2;

export interface ValidatingExecutorOptions {
  /** The executor that actually runs the task, rooted at `workspacePath`. */
  readonly inner: WorkerExecutor;
  readonly validators: readonly ProjectValidator[];
  /**
   * The directory the validators run in.
   *
   * Passed explicitly rather than inferred because this decorator has to sit
   * *inside* worktree isolation — see the class doc.
   */
  readonly workspacePath: string;
  readonly events?: EventSink;
  readonly runId?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/** One `unresolvedIssues` line per failing validator. */
function describeFailure(outcome: ValidatorOutcome): string {
  const how = outcome.timedOut
    ? "timed out"
    : `exit code ${outcome.exitCode === null ? "unknown" : String(outcome.exitCode)}`;
  const output =
    outcome.output.trim() === ""
      ? "(no output)"
      : truncate(outcome.output, MAX_ISSUE_OUTPUT_CHARS);
  return `Validator "${outcome.name}" failed (${how}) running \`${outcome.command}\`: ${output}`;
}

function withFailedValidation(
  result: TaskResult,
  report: ValidationReport,
): TaskResult {
  const failures = report.outcomes.filter((outcome) => !outcome.passed);
  return {
    ...result,
    status: "failed",
    tests: {
      passed: report.outcomes.length - failures.length,
      failed: failures.length,
      commands: report.outcomes.map((outcome) => outcome.command),
    },
    unresolvedIssues: [
      ...result.unresolvedIssues,
      ...failures.map(describeFailure),
    ],
    confidence: FAILED_VALIDATION_CONFIDENCE,
  };
}

function withPassedValidation(
  result: TaskResult,
  report: ValidationReport,
): TaskResult {
  return {
    ...result,
    tests: {
      passed: report.outcomes.length,
      failed: 0,
      commands: report.outcomes.map((outcome) => outcome.command),
    },
  };
}

/**
 * Wraps a worker executor so that a mutating task only counts as successful
 * once the project's `validation:` commands agree.
 *
 * ## Where this sits in the chain
 *
 * Validation has to happen **inside** worktree isolation: the point is to
 * decide whether the worktree may be merged, so it must run against the task's
 * own checkout, before {@link WorktreeIsolatedExecutor} integrates it. Because
 * executors are composed by path through a `WorkspaceExecutorFactory`, that
 * means wrapping the *per-workspace* executor rather than the worktree
 * executor, and handing this decorator the same path:
 *
 * ```ts
 * new WorktreeIsolatedExecutor({
 *   repoRoot,
 *   runId,
 *   createExecutor: (path) =>
 *     new ValidatingExecutor({
 *       inner: baseFactory(path),
 *       validators: project.config.validators,
 *       workspacePath: path,
 *       events,
 *       runId,
 *     }),
 * });
 * ```
 *
 * A failed validation therefore turns into a `failed` inner result, which the
 * worktree executor already knows not to merge.
 *
 * ## When validators run
 *
 * Only when the inner result is a `success` *and* the task type is mutating.
 * A read-only task (`exploration`, `review`) changed nothing, so running the
 * suite would only measure the state the task inherited; and a task that
 * already failed does not need a second opinion — re-running the suite on a
 * half-finished edit is minutes of work to confirm what is already known.
 *
 * Nothing here rejects. The scheduler treats a thrown error as a crashed run,
 * so a validator harness that breaks reports a `failed` task instead.
 */
export class ValidatingExecutor implements WorkerExecutor {
  readonly #options: ValidatingExecutorOptions;

  constructor(options: ValidatingExecutorOptions) {
    this.#options = options;
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const result = await this.#options.inner.execute(
      task,
      agent,
      signal,
      context,
    );

    if (result.status !== "success") return result;
    if (!MUTATING_TASK_TYPES.has(task.spec.type)) return result;

    let report: ValidationReport;
    try {
      report = await runValidators(
        this.#options.validators,
        this.#options.workspacePath,
        {
          ...(signal === undefined ? {} : { signal }),
          ...(this.#options.events === undefined
            ? {}
            : { events: this.#options.events }),
          ...(this.#options.runId === undefined
            ? {}
            : { runId: this.#options.runId }),
          taskId: task.spec.id,
        },
      );
    } catch (error) {
      // `runValidators` is written not to throw; if it does anyway, an
      // unvalidated success is exactly the outcome this class exists to
      // prevent, so the task fails.
      return {
        ...result,
        status: "failed",
        unresolvedIssues: [
          ...result.unresolvedIssues,
          `Validation could not be run: ${errorMessage(error)}`,
        ],
        confidence: FAILED_VALIDATION_CONFIDENCE,
      };
    }

    return report.passed
      ? withPassedValidation(result, report)
      : withFailedValidation(result, report);
  }
}
