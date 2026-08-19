import type {
  RuntimeTask,
  TaskResult,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import type { EventSink } from "@agent/protocol";
import type { CodexBackendOptions } from "../backends/codex.js";
import { CodexBackend } from "../backends/codex.js";
import { buildTaskBriefing } from "./briefing.js";
import {
  inspectWorkspaceChanges,
  type NormalizableRun,
  normalizeTaskResult,
} from "./normalize.js";

export interface CodexWorkerExecutorOptions {
  readonly workspacePath: string;
  readonly runId: string;
  readonly events?: EventSink;
  readonly taskTimeoutMs?: number;
  /**
   * Passed through to {@link CodexBackend}. `events` and `timeoutMs` here are
   * overridden by the executor-level options above when those are set.
   */
  readonly backendOptions?: CodexBackendOptions;
}

/**
 * Runs orchestration tasks through the official Codex CLI instead of the
 * in-process agent loop.
 *
 * Codex owns its own agent loop, tools and sandbox, so this executor is a thin
 * adapter: same task briefing in, same workspace inspection out. Permissions
 * and tool selection are Codex's business (see `--sandbox` / `--full-auto` in
 * {@link CodexBackendOptions}), not this layer's.
 */
export class CodexWorkerExecutor implements WorkerExecutor {
  readonly #options: CodexWorkerExecutorOptions;

  constructor(options: CodexWorkerExecutorOptions) {
    this.#options = options;
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const taskId = task.spec.id;
    const { workspacePath, runId } = this.#options;

    const backend = new CodexBackend({
      ...this.#options.backendOptions,
      ...(this.#options.events === undefined
        ? {}
        : { events: this.#options.events }),
      ...(this.#options.taskTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.#options.taskTimeoutMs }),
    });

    let run: NormalizableRun;
    try {
      run = await backend.run(
        { instruction: buildTaskBriefing(task.spec, agent, context) },
        {
          runId,
          taskId,
          workspacePath,
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error) {
      run = {
        status: "failed",
        summary: `Codex backend crashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    return normalizeTaskResult({ taskId, loop: run, inspection });
  }
}
