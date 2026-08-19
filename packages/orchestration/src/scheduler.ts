import type { EscalationRule, OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent, EventSink } from "@agent/protocol";
import type { TaskGraph } from "./graph.js";
import type { AgentRouter } from "./router.js";
import type { WorkerExecutor } from "./types.js";
import { isTerminal, type RuntimeTask, type TaskResult } from "./types.js";

/** Optional knobs; every field has a policy-derived default. */
export interface SchedulerOptions {
  /**
   * Attempts a single task gets before it is declared failed. Defaults to
   * `policy.defaultMaxAttempts`.
   */
  readonly maxAttempts?: number;
}

/** Why a task was cancelled rather than run to completion. */
export type TaskCancelReason = "dependency-failed" | "aborted";

/**
 * Runs a task graph with rolling concurrency: a free slot is filled the moment
 * one opens, so a long task never holds back the tasks that became ready
 * behind it. Retries, escalation, dependency cancellation and abort are all
 * handled here; the router decides *who* runs a task and the worker decides
 * *what* happens when it does.
 */
export class DeterministicScheduler {
  constructor(
    private readonly router: AgentRouter,
    private readonly worker: WorkerExecutor,
    private readonly events?: EventSink,
    private readonly options?: SchedulerOptions,
  ) {}

  async run(
    runId: string,
    graph: TaskGraph,
    policy: OrchestrationPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const limit =
      policy.parallelizeIndependentTasks === false
        ? 1
        : Math.max(1, policy.maxConcurrency);
    const running = new Map<number, Promise<number>>();
    let sequence = 0;

    for (;;) {
      const aborted = signal?.aborted === true;

      if (!aborted) {
        while (running.size < limit) {
          const next = graph.ready()[0];
          if (next === undefined) break;
          const key = sequence;
          sequence += 1;
          running.set(
            key,
            this.#attempt(runId, next, graph, policy, signal).then(() => key),
          );
        }
      }

      if (running.size === 0) {
        if (aborted) {
          await this.#cancelRemaining(runId, graph, "aborted");
          return;
        }
        if (graph.done()) return;
        throw new Error(
          "Scheduler deadlock: unfinished tasks exist but none are runnable.",
        );
      }

      const finished = await Promise.race(running.values());
      running.delete(finished);
    }
  }

  /** Runs one attempt of `task` and settles it: retried, failed or completed. */
  async #attempt(
    runId: string,
    task: RuntimeTask,
    graph: TaskGraph,
    policy: OrchestrationPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const previousAgent = task.assignedAgent;
    const escalation = this.#escalationFor(task, policy);
    const agent =
      escalation === undefined
        ? this.router.route(task.spec, policy)
        : escalation.toAgent;

    task.assignedAgent = agent;
    task.status = "running";
    task.attempts += 1;

    if (escalation !== undefined) {
      await this.#emit(runId, "task.escalated", task.spec.id, {
        from: previousAgent,
        to: agent,
        rule: escalation.id,
      });
    }
    await this.#emit(runId, "task.started", task.spec.id, {
      agent,
      attempt: task.attempts,
    });

    const result = await this.#execute(task, agent, signal);
    task.result = result;

    if (result.status === "success") {
      task.status = "completed";
      await this.#emit(runId, "task.completed", task.spec.id, {
        agent,
        result,
        attempt: task.attempts,
        final: true,
      });
      return;
    }

    const maxAttempts = this.#maxAttemptsFor(policy);
    const retry = task.attempts < maxAttempts && signal?.aborted !== true;
    task.status = retry ? "pending" : "failed";
    await this.#emit(runId, "task.completed", task.spec.id, {
      agent,
      result,
      attempt: task.attempts,
      final: !retry,
    });
    if (retry) return;

    if (signal?.aborted === true) {
      // The run is being torn down; the pending sweep reports the rest.
      task.status = "cancelled";
      await this.#emit(runId, "task.cancelled", task.spec.id, {
        reason: "aborted" satisfies TaskCancelReason,
      });
      return;
    }
    await this.#cancelDependents(runId, graph, task.spec.id);
  }

  /** A worker that throws counts as a failed attempt, not a crashed run. */
  async #execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    try {
      return await this.worker.execute(task, agent, signal);
    } catch (error) {
      return {
        taskId: task.spec.id,
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        decisions: [],
        changedFiles: [],
        tests: { passed: 0, failed: 0, commands: [] },
        unresolvedIssues: [],
        confidence: 0,
      };
    }
  }

  #maxAttemptsFor(policy: OrchestrationPolicy): number {
    return Math.max(1, this.options?.maxAttempts ?? policy.defaultMaxAttempts);
  }

  /**
   * The escalation rule that redirects the *next* attempt of `task`, if any:
   * it must hand off from the agent that just failed and its failure threshold
   * must already be met.
   */
  #escalationFor(
    task: RuntimeTask,
    policy: OrchestrationPolicy,
  ): EscalationRule | undefined {
    const from = task.assignedAgent;
    if (from === undefined || task.attempts === 0) return undefined;
    return policy.escalation.find(
      (rule) =>
        rule.fromAgent === from && task.attempts >= (rule.afterFailures ?? 1),
    );
  }

  /** Cancels everything that (transitively) depended on a dead task. */
  async #cancelDependents(
    runId: string,
    graph: TaskGraph,
    id: string,
  ): Promise<void> {
    const queue = [id];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (current === undefined) continue;
      for (const dependent of graph.dependentsOf(current)) {
        if (isTerminal(dependent.status)) continue;
        dependent.status = "cancelled";
        await this.#emit(runId, "task.cancelled", dependent.spec.id, {
          reason: "dependency-failed" satisfies TaskCancelReason,
          dependency: current,
        });
        queue.push(dependent.spec.id);
      }
    }
  }

  async #cancelRemaining(
    runId: string,
    graph: TaskGraph,
    reason: TaskCancelReason,
  ): Promise<void> {
    for (const task of graph.all()) {
      if (isTerminal(task.status)) continue;
      task.status = "cancelled";
      await this.#emit(runId, "task.cancelled", task.spec.id, { reason });
    }
  }

  async #emit(
    runId: string,
    type: string,
    taskId: string,
    data: unknown,
  ): Promise<void> {
    await this.events?.emit(event(runId, type, taskId, data));
  }
}

function event(
  runId: string,
  type: string,
  taskId: string,
  data: unknown,
): AgentEvent {
  return {
    id: crypto.randomUUID(),
    runId,
    timestamp: Date.now(),
    type,
    taskId,
    data,
  };
}
