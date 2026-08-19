import type { EscalationRule, OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { tasksConflict } from "./conflicts.js";
import type { TaskGraph } from "./graph.js";
import type { AgentRouter } from "./router.js";
import type { WorkerExecutionContext, WorkerExecutor } from "./types.js";
import { isTerminal, type RuntimeTask, type TaskResult } from "./types.js";

/** Optional knobs; every field has a policy-derived default. */
export interface SchedulerOptions {
  /**
   * Attempts a single task gets before it is declared failed. Defaults to
   * `policy.defaultMaxAttempts`.
   */
  readonly maxAttempts?: number;
  /**
   * When true (the default), a ready task whose affected areas overlap a
   * currently-running task's is held back rather than dispatched, so two
   * tasks that may write to the same part of the repo never run at once.
   */
  readonly serializeOverlappingAreas?: boolean;
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
    const serializeOverlappingAreas =
      this.options?.serializeOverlappingAreas ?? true;
    const running = new Map<number, Promise<number>>();
    const runningTasks = new Map<number, RuntimeTask>();
    const heldPairsEmitted = new Set<string>();
    let sequence = 0;

    for (;;) {
      const aborted = signal?.aborted === true;

      if (!aborted) {
        while (running.size < limit) {
          const next = await this.#nextDispatchable(
            runId,
            graph,
            serializeOverlappingAreas,
            runningTasks,
            heldPairsEmitted,
          );
          if (next === undefined) break;
          const key = sequence;
          sequence += 1;
          runningTasks.set(key, next);
          running.set(
            key,
            this.#attempt(runId, next, graph, policy, signal).then(() => {
              runningTasks.delete(key);
              return key;
            }),
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

  /**
   * The next ready task that is safe to dispatch: the first one (in
   * `graph.ready()` order) that does not conflict with any currently
   * running task. Ready tasks held back by a running conflict each emit
   * `task.held` at most once per (task, blocking task) pair.
   */
  async #nextDispatchable(
    runId: string,
    graph: TaskGraph,
    serializeOverlappingAreas: boolean,
    runningTasks: ReadonlyMap<number, RuntimeTask>,
    heldPairsEmitted: Set<string>,
  ): Promise<RuntimeTask | undefined> {
    const ready = graph.ready();
    if (!serializeOverlappingAreas) return ready[0];

    const runningList = [...runningTasks.values()];
    for (const candidate of ready) {
      const blocker = runningList.find((other) =>
        tasksConflict(candidate.spec, other.spec),
      );
      if (blocker === undefined) return candidate;

      const pairKey = `${candidate.spec.id}:${blocker.spec.id}`;
      if (!heldPairsEmitted.has(pairKey)) {
        heldPairsEmitted.add(pairKey);
        await this.#emit(runId, "task.held", candidate.spec.id, {
          taskId: candidate.spec.id,
          conflictsWith: blocker.spec.id,
        });
      }
    }
    return undefined;
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
      // #escalationFor only returns a rule once `previousAgent` is known to
      // be defined (it requires task.attempts > 0, which in turn requires a
      // prior attempt to have set assignedAgent), so this is safe.
      const from = previousAgent as string;
      task.lastEscalation = { rule: escalation.id, from, to: agent };
      await this.#emit(runId, "task.escalated", task.spec.id, {
        from,
        to: agent,
        rule: escalation.id,
      });
    }
    await this.#emit(runId, "task.started", task.spec.id, {
      agent,
      attempt: task.attempts,
    });

    const context = this.#dependencyContext(graph, task);
    const result = await this.#execute(task, agent, signal, context);
    task.result = result;

    const maxAttempts = this.#maxAttemptsFor(policy);
    const canRetry = task.attempts < maxAttempts && signal?.aborted !== true;

    if (result.status === "success") {
      const lowConfidenceRule = this.#lowConfidenceRuleFor(
        agent,
        result.confidence,
        policy,
      );
      if (lowConfidenceRule !== undefined) {
        const accepted = !canRetry;
        await this.#emit(runId, "task.low_confidence", task.spec.id, {
          taskId: task.spec.id,
          agent,
          confidence: result.confidence,
          threshold: lowConfidenceRule.confidenceBelow,
          rule: lowConfidenceRule.id,
          ...(accepted ? { accepted: true } : {}),
        });
        if (!accepted) {
          // Not accepted: this success is treated as a failed attempt for
          // scheduling purposes so the retry/escalation flow below picks it
          // up and reroutes to the rule's toAgent on the next dispatch.
          task.status = "pending";
          await this.#emit(runId, "task.completed", task.spec.id, {
            agent,
            result,
            attempt: task.attempts,
            final: false,
          });
          return;
        }
        // Attempts are exhausted: accept the low-confidence result rather
        // than fail a task the policy can no longer improve on. Falls
        // through to the normal success-completion path below.
      }
      task.status = "completed";
      await this.#emit(runId, "task.completed", task.spec.id, {
        agent,
        result,
        attempt: task.attempts,
        final: true,
      });
      return;
    }

    const retry = canRetry;
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

  /**
   * The results of `task`'s direct dependencies, in dependency-declaration
   * order. Dependencies with no recorded result (should not happen for a
   * task that reached "ready", but the graph does not guarantee it) are
   * skipped rather than filled with a placeholder.
   */
  #dependencyContext(
    graph: TaskGraph,
    task: RuntimeTask,
  ): WorkerExecutionContext {
    const dependencyResults: TaskResult[] = [];
    for (const dependencyId of task.spec.dependencies) {
      const result = graph.get(dependencyId).result;
      if (result !== undefined) dependencyResults.push(result);
    }
    return { dependencyResults };
  }

  /** A worker that throws counts as a failed attempt, not a crashed run. */
  async #execute(
    task: RuntimeTask,
    agent: string,
    signal: AbortSignal | undefined,
    context: WorkerExecutionContext,
  ): Promise<TaskResult> {
    try {
      return await this.worker.execute(task, agent, signal, context);
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
   * it must hand off from the agent that just ran, and either its failure
   * threshold or its confidence threshold must be met — the two conditions
   * are OR'd, so a rule with only `confidenceBelow` set matches on
   * confidence alone, with no `afterFailures` required. When several rules
   * match, the one with the lexicographically lowest `id` wins, so escalation
   * target selection is deterministic regardless of policy authoring order.
   */
  #escalationFor(
    task: RuntimeTask,
    policy: OrchestrationPolicy,
  ): EscalationRule | undefined {
    const from = task.assignedAgent;
    if (from === undefined || task.attempts === 0) return undefined;
    // The result may be absent in principle (it is always set after a real
    // attempt, including a thrown-error attempt, which records confidence
    // 0); the fallback keeps this defensive rather than load-bearing.
    const confidence = task.result?.confidence ?? 0;
    const matches = policy.escalation.filter(
      (rule) =>
        rule.fromAgent === from &&
        ((rule.afterFailures !== undefined &&
          task.attempts >= rule.afterFailures) ||
          (rule.confidenceBelow !== undefined &&
            confidence < rule.confidenceBelow)),
    );
    return pickLowestId(matches);
  }

  /**
   * The escalation rule that disqualifies a "success" result from being
   * accepted outright, if any: it must hand off from the agent that just
   * produced the result and the result's confidence must fall below the
   * rule's `confidenceBelow` threshold. Unlike `#escalationFor`,
   * `afterFailures` plays no part here — a rule that only sets
   * `afterFailures` has nothing to say about a confident-or-not success. Lowest
   * `id` wins when several rules match, matching `#escalationFor`'s tie-break.
   */
  #lowConfidenceRuleFor(
    agent: string,
    confidence: number,
    policy: OrchestrationPolicy,
  ): EscalationRule | undefined {
    const matches = policy.escalation.filter(
      (rule) =>
        rule.fromAgent === agent &&
        rule.confidenceBelow !== undefined &&
        confidence < rule.confidenceBelow,
    );
    return pickLowestId(matches);
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

/** The rule with the lexicographically lowest `id`, or undefined if empty. */
function pickLowestId(
  rules: readonly EscalationRule[],
): EscalationRule | undefined {
  return rules.reduce<EscalationRule | undefined>(
    (best, rule) => (best === undefined || rule.id < best.id ? rule : best),
    undefined,
  );
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
