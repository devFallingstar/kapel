import type { EscalationRule, OrchestrationPolicy } from "@agent/policy";
import type {
  AgentEventBody,
  AgentEventData,
  EventSink,
} from "@agent/protocol";
import { agentEvent } from "@agent/protocol";
import { tasksConflict } from "./conflicts.js";
import type { TaskGraph } from "./graph.js";
import type { AgentRouter, RoutingDecision, RoutingReason } from "./router.js";
import type {
  PlannedTask,
  WorkerExecutionContext,
  WorkerExecutor,
} from "./types.js";
import { isTerminal, type RuntimeTask, type TaskResult } from "./types.js";

/**
 * The routing rationale attached to a `task.started` event's payload.
 *
 * An alias of the protocol's own payload type rather than a second copy of it:
 * the event schema is the definition, and this name is what the scheduler
 * calls it. Before the events were typed the two *were* separate declarations,
 * which is how `routing` came to be emitted with nothing checking it.
 */
export type TaskStartedRouting = NonNullable<
  AgentEventData<"task.started">["routing"]
>;

/**
 * Why an attempt was dispatched to the agent it was — carried on
 * `task.started`. A superset of {@link RoutingReason}: an escalated attempt
 * bypasses the router entirely. `#attempt` assigns a router `reason` straight
 * into a {@link TaskStartedRouting}, so a `RoutingReason` the event schema
 * does not know about fails to compile there.
 */
export type TaskStartedReason = TaskStartedRouting["reason"];

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
export type TaskCancelReason = AgentEventData<"task.cancelled">["reason"];

/** An escalation rule that disqualifies a success, with the threshold it tripped. */
interface LowConfidenceMatch {
  readonly rule: EscalationRule;
  readonly threshold: number;
}

/**
 * Runs a task graph with rolling concurrency: a free slot is filled the moment
 * one opens, so a long task never holds back the tasks that became ready
 * behind it. Retries, escalation, dependency cancellation and abort are all
 * handled here; the router decides *who* runs a task and the worker decides
 * *what* happens when it does.
 *
 * ## Attempts, and how escalation earns one
 *
 * Ordinarily a task gets `maxAttempts` attempts (`policy.defaultMaxAttempts`,
 * or the scheduler option) and is declared failed after the last one. On its
 * own that made most escalation rules unreachable: the shipped template says
 * "retry a failed worker once, and if the second attempt fails escalate one
 * tier up", which compiles to `defaultMaxAttempts: 2` with
 * `afterFailures: 2` — and a rule that only becomes true *after* the last
 * attempt has nothing left to reroute. Every escalation ladder written that
 * way was dead code.
 *
 * So a matching escalation rule **grants** the attempt it needs: when a task
 * has failed its last ordinary attempt, `#escalationFor` is consulted, and if
 * a rule matches that has not already granted this task an attempt, the task
 * stays pending and the next dispatch runs it against that rule's `toAgent`.
 * Each rule may grant at most once per task ({@link RuntimeTask.escalationsGranted}),
 * so a ladder climbs one tier per hop — junior→coder→senior is two rules and
 * two grants — and terminates: there are finitely many rules and none is ever
 * spent twice.
 *
 * Two deliberate limits on that. An aborted run never grants anything: the
 * run is being torn down and the task is cancelled, not retried. And a
 * low-confidence *success* with its attempts exhausted is still accepted
 * rather than granted a further attempt — that path is not "the task failed",
 * it is "the policy can no longer improve on work that exists", and turning
 * an accepted result back into another round of work is a different decision
 * from rescuing a dead escalation rule.
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
        await this.#emit(runId, candidate.spec.id, {
          type: "task.held",
          data: {
            taskId: candidate.spec.id,
            conflictsWith: blocker.spec.id,
          },
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
    let agent: string;
    let routing: TaskStartedRouting;
    if (escalation === undefined) {
      const decision = this.#route(task.spec, policy);
      agent = decision.agent;
      routing =
        decision.rule === undefined
          ? { reason: decision.reason }
          : { rule: decision.rule, reason: decision.reason };
    } else {
      agent = escalation.toAgent;
      routing = { rule: escalation.id, reason: "escalation" };
    }

    task.assignedAgent = agent;
    task.status = "running";
    task.attempts += 1;

    if (escalation !== undefined) {
      // #escalationFor only returns a rule once `previousAgent` is known to
      // be defined (it requires task.attempts > 0, which in turn requires a
      // prior attempt to have set assignedAgent), so this is safe.
      const from = previousAgent as string;
      task.lastEscalation = { rule: escalation.id, from, to: agent };
      await this.#emit(runId, task.spec.id, {
        type: "task.escalated",
        data: { from, to: agent, rule: escalation.id },
      });
    }
    const model = this.worker.describeAgent?.(agent)?.model;
    await this.#emit(runId, task.spec.id, {
      type: "task.started",
      data: {
        agent,
        attempt: task.attempts,
        ...(model === undefined ? {} : { model }),
        routing,
      },
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
        await this.#emit(runId, task.spec.id, {
          type: "task.low_confidence",
          data: {
            taskId: task.spec.id,
            agent,
            confidence: result.confidence,
            threshold: lowConfidenceRule.threshold,
            rule: lowConfidenceRule.rule.id,
            ...(accepted ? { accepted: true } : {}),
          },
        });
        if (!accepted) {
          // Not accepted: this success is treated as a failed attempt for
          // scheduling purposes so the retry/escalation flow below picks it
          // up and reroutes to the rule's toAgent on the next dispatch.
          task.status = "pending";
          await this.#emit(runId, task.spec.id, {
            type: "task.completed",
            data: { agent, result, attempt: task.attempts, final: false },
          });
          return;
        }
        // Attempts are exhausted: accept the low-confidence result rather
        // than fail a task the policy can no longer improve on. Falls
        // through to the normal success-completion path below.
      }
      task.status = "completed";
      await this.#emit(runId, task.spec.id, {
        type: "task.completed",
        data: { agent, result, attempt: task.attempts, final: true },
      });
      return;
    }

    // The attempt failed. If the ordinary budget is spent, a matching
    // escalation rule can still buy one more — see the class doc comment.
    const retry = canRetry || this.#grantEscalatedAttempt(task, policy, signal);
    task.status = retry ? "pending" : "failed";
    await this.#emit(runId, task.spec.id, {
      type: "task.completed",
      data: { agent, result, attempt: task.attempts, final: !retry },
    });
    if (retry) return;

    if (signal?.aborted === true) {
      // The run is being torn down; the pending sweep reports the rest.
      task.status = "cancelled";
      await this.#emit(runId, task.spec.id, {
        type: "task.cancelled",
        data: { reason: "aborted" },
      });
      return;
    }
    await this.#cancelDependents(runId, graph, task.spec.id);
  }

  /**
   * The router's decision for a non-escalated attempt, rationale included.
   * Falls back to a bare `route()` call, with `reason` reported as
   * `"orchestrator"`, for a router that only implements the required half of
   * {@link AgentRouter} — the rationale is then genuinely unknown, but that
   * fallback value keeps it in the same closed set `TaskStartedReason` allows
   * rather than inventing a new one.
   */
  #route(task: PlannedTask, policy: OrchestrationPolicy): RoutingDecision {
    if (this.router.decide !== undefined)
      return this.router.decide(task, policy);
    return { agent: this.router.route(task, policy), reason: "orchestrator" };
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
   * Decides whether an escalation rule grants `task` an attempt beyond
   * `maxAttempts`, and records that it did.
   *
   * Called only when the ordinary attempt budget is spent and the task would
   * otherwise be declared failed. The rule consulted is exactly the one
   * `#escalationFor` will pick when the task is dispatched again, so the
   * attempt that is granted is the attempt that actually escalates — a grant
   * never produces a plain same-agent retry. Each rule grants at most once per
   * task, so a ladder advances one rung per failure and then stops.
   *
   * An aborted run grants nothing: the pending sweep is about to cancel this
   * task, and keeping it pending would only put it back in the queue.
   */
  #grantEscalatedAttempt(
    task: RuntimeTask,
    policy: OrchestrationPolicy,
    signal: AbortSignal | undefined,
  ): boolean {
    if (signal?.aborted === true) return false;

    const rule = this.#escalationFor(task, policy);
    if (rule === undefined) return false;

    task.escalationsGranted ??= new Set<string>();
    const granted = task.escalationsGranted;
    if (granted.has(rule.id)) return false;
    granted.add(rule.id);
    return true;
  }

  /**
   * The escalation rule that disqualifies a "success" result from being
   * accepted outright, if any: it must hand off from the agent that just
   * produced the result and the result's confidence must fall below the
   * rule's `confidenceBelow` threshold. Unlike `#escalationFor`,
   * `afterFailures` plays no part here — a rule that only sets
   * `afterFailures` has nothing to say about a confident-or-not success. Lowest
   * `id` wins when several rules match, matching `#escalationFor`'s tie-break.
   *
   * The threshold is returned alongside the rule rather than re-read from it
   * at the call site: only a rule with a `confidenceBelow` can match here, but
   * that is a fact of the filter and not of `EscalationRule`, so the caller
   * would otherwise be emitting `threshold: number | undefined` into an event
   * whose payload promises a number.
   */
  #lowConfidenceRuleFor(
    agent: string,
    confidence: number,
    policy: OrchestrationPolicy,
  ): LowConfidenceMatch | undefined {
    const matches: LowConfidenceMatch[] = [];
    for (const rule of policy.escalation) {
      const threshold = rule.confidenceBelow;
      if (rule.fromAgent !== agent || threshold === undefined) continue;
      if (confidence >= threshold) continue;
      matches.push({ rule, threshold });
    }
    return matches.reduce<LowConfidenceMatch | undefined>(
      (best, match) =>
        best === undefined || match.rule.id < best.rule.id ? match : best,
      undefined,
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
        await this.#emit(runId, dependent.spec.id, {
          type: "task.cancelled",
          data: { reason: "dependency-failed", dependency: current },
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
      await this.#emit(runId, task.spec.id, {
        type: "task.cancelled",
        data: { reason },
      });
    }
  }

  async #emit(
    runId: string,
    taskId: string,
    body: AgentEventBody,
  ): Promise<void> {
    await this.events?.emit(agentEvent({ runId, taskId }, body));
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
