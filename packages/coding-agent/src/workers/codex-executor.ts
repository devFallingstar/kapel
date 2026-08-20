import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
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
import { applyReviewVerdict, reviewVerdictFromRun } from "./review.js";

export interface CodexWorkerExecutorOptions {
  readonly workspacePath: string;
  readonly runId: string;
  readonly events?: EventSink;
  readonly taskTimeoutMs?: number;
  /**
   * Passed through to {@link CodexBackend}. `events` and `timeoutMs` here are
   * overridden by the executor-level options above when those are set, and
   * `model` is overridden per task by {@link resolveAgentModel} when that
   * resolver has an answer for the routed agent.
   */
  readonly backendOptions?: CodexBackendOptions;
  /**
   * Looks up the model the routed agent is configured for, typically
   * {@link createDelegatedModelResolver} bound to the run's `AgentProject`.
   *
   * A per-task result overrides `backendOptions.model` for that task — the
   * router picked this agent for a reason, and an agent-specific model is a
   * more specific choice than a run-wide default — while `undefined` (agent
   * unknown, alias unresolved, or `config.yaml` says "default") leaves
   * `backendOptions.model` as the fallback so a run-wide `-m` still applies.
   */
  readonly resolveAgentModel?: (agent: string) => string | undefined;
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

  /**
   * The model {@link resolveAgentModel} would resolve for `agent`, falling
   * back to `backendOptions.model` — the same precedence {@link execute}
   * applies when it builds the {@link CodexBackend} for a task, exposed here
   * so it can be reported before the task actually runs.
   */
  #modelFor(agent: string): string | undefined {
    return (
      this.#options.resolveAgentModel?.(agent) ??
      this.#options.backendOptions?.model
    );
  }

  describeAgent(agent: string): WorkerAgentDescription | undefined {
    const model = this.#modelFor(agent);
    return model === undefined ? undefined : { model };
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const taskId = task.spec.id;
    const { workspacePath, runId } = this.#options;
    const model = this.#modelFor(agent);

    const backend = new CodexBackend({
      ...this.#options.backendOptions,
      ...(model === undefined ? {} : { model }),
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
        {
          instruction: buildTaskBriefing(task.spec, agent, context, {
            reviewContract: "json-reply",
          }),
        },
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
    const result = normalizeTaskResult({ taskId, loop: run, inspection });

    // Same contract as the native loop and the Claude Code executor: the
    // verdict decides the review, and a reply with no readable verdict fails
    // it rather than passing on a zero exit code.
    if (task.spec.type !== "review") return result;
    return applyReviewVerdict(result, reviewVerdictFromRun(run));
  }
}
