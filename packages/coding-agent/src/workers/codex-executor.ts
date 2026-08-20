import type { ModelUsage } from "@agent/ai";
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
import type { DelegatedWorkerUsageSink } from "../planning/delegated-cli.js";
import { recordDelegatedWorkerUsage } from "../planning/delegated-cli.js";
import type { HandoffGuidance } from "../project/index.js";
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
  /**
   * Where to report what Codex said each task attempt spent, when the caller
   * is keeping a ledger (an orchestration run opens one for the whole run).
   * Left out, nothing is recorded — which is not the same as recording zero,
   * mirroring `DelegatedPlannerOptions.usage`.
   */
  readonly usage?: DelegatedWorkerUsageSink;
  /**
   * The project's `.agent/handoff.md` guidance, normally `project.handoff`.
   * Only the briefing's sections apply here — Codex brings its own system
   * prompt, so `## common` has nowhere to go — and the review verdict contract
   * is appended after `## reviewer` either way.
   */
  readonly handoff?: HandoffGuidance | undefined;
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
    // Kept separate from `run` (typed to only the fields normalization reads)
    // so recording usage below does not depend on widening that type.
    let reportedUsage: ModelUsage | undefined;
    try {
      const backendResult = await backend.run(
        {
          instruction: buildTaskBriefing(task.spec, agent, context, {
            reviewContract: "json-reply",
            handoff: this.#options.handoff,
          }),
        },
        {
          runId,
          taskId,
          workspacePath,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      run = backendResult;
      reportedUsage = backendResult.usage;
    } catch (error) {
      run = {
        status: "failed",
        summary: `Codex backend crashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Recorded regardless of outcome, same as the planner's per-attempt
    // recording: a failed or partial task still cost whatever Codex reported.
    recordDelegatedWorkerUsage(
      this.#options.usage,
      { agent, taskId, model },
      reportedUsage,
    );

    const inspection = await inspectWorkspaceChanges(workspacePath, signal);
    const result = normalizeTaskResult({ taskId, loop: run, inspection });

    // Same contract as the native loop and the Claude Code executor: the
    // verdict decides the review, and a reply with no readable verdict fails
    // it rather than passing on a zero exit code.
    if (task.spec.type !== "review") return result;
    return applyReviewVerdict(result, reviewVerdictFromRun(run));
  }
}
