import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  DeterministicScheduler,
  PolicyRouter,
  type SchedulerOptions,
  TaskGraph,
} from "../src/index.js";
import {
  makePlan,
  makePolicy,
  makeResult,
  makeTask,
  ScriptedWorker,
} from "./helpers.js";

class RecordingSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }

  ofType(type: string): readonly AgentEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  types(): readonly string[] {
    return this.events.map((event) => event.type);
  }
}

function scheduler(
  worker: ScriptedWorker,
  events?: EventSink,
  options?: SchedulerOptions,
): DeterministicScheduler {
  return new DeterministicScheduler(
    new PolicyRouter(),
    worker,
    events,
    options,
  );
}

describe("DeterministicScheduler / confidence-based escalation", () => {
  it("redoes a low-confidence success, escalating to the rule's toAgent, and accepts the redo", async () => {
    const worker = new ScriptedWorker((call) =>
      call.agent === "implementer"
        ? makeResult(call.taskId, "success", { confidence: 0.2 })
        : makeResult(call.taskId, "success", { confidence: 0.95 }),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "low-conf",
          fromAgent: "implementer",
          toAgent: "architect",
          confidenceBelow: 0.5,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    const task = graph.get("T01");
    expect(task.status).toBe("completed");
    expect(task.assignedAgent).toBe("architect");
    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "architect",
    ]);

    expect(events.types()).toEqual([
      "task.started",
      "task.low_confidence",
      "task.completed",
      "task.escalated",
      "task.started",
      "task.completed",
    ]);

    expect(events.ofType("task.low_confidence")[0]?.data).toEqual({
      taskId: "T01",
      agent: "implementer",
      confidence: 0.2,
      threshold: 0.5,
      rule: "low-conf",
    });
    expect(events.ofType("task.completed")[0]?.data).toMatchObject({
      final: false,
    });
    expect(events.ofType("task.escalated")[0]?.data).toEqual({
      from: "implementer",
      to: "architect",
      rule: "low-conf",
    });
    expect(events.ofType("task.completed")[1]?.data).toMatchObject({
      final: true,
    });
  });

  it("accepts a low-confidence success once attempts are exhausted, marking the event accepted", async () => {
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "success", { confidence: 0.2 }),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 1,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "low-conf",
          fromAgent: "implementer",
          toAgent: "architect",
          confidenceBelow: 0.5,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    const task = graph.get("T01");
    expect(task.status).toBe("completed");
    expect(task.assignedAgent).toBe("implementer");
    expect(worker.calls).toHaveLength(1);
    expect(events.ofType("task.escalated")).toHaveLength(0);
    expect(events.ofType("task.low_confidence")[0]?.data).toEqual({
      taskId: "T01",
      agent: "implementer",
      confidence: 0.2,
      threshold: 0.5,
      rule: "low-conf",
      accepted: true,
    });
    expect(events.ofType("task.completed")[0]?.data).toMatchObject({
      final: true,
    });
  });

  it("matches a confidenceBelow-only rule (no afterFailures) on a failed attempt's first retry", async () => {
    const worker = new ScriptedWorker((call) =>
      call.agent === "implementer"
        ? makeResult(call.taskId, "failed", { confidence: 0.1 })
        : makeResult(call.taskId, "success"),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "low-conf-fail",
          fromAgent: "implementer",
          toAgent: "reviewer",
          confidenceBelow: 0.5,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "reviewer",
    ]);
    expect(events.ofType("task.escalated")[0]?.data).toEqual({
      from: "implementer",
      to: "reviewer",
      rule: "low-conf-fail",
    });
    expect(graph.get("T01").status).toBe("completed");
  });

  it("escalates on either condition when a rule sets both afterFailures and confidenceBelow (OR semantics)", async () => {
    // afterFailures requires 3 failures, but confidenceBelow (0.5) is
    // undercut by the very first failure's confidence (0.1), so the OR
    // means escalation fires on the first retry rather than waiting for
    // the third failure.
    const worker = new ScriptedWorker((call) =>
      call.agent === "implementer"
        ? makeResult(call.taskId, "failed", { confidence: 0.1 })
        : makeResult(call.taskId, "success"),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "either",
          fromAgent: "implementer",
          toAgent: "reviewer",
          afterFailures: 3,
          confidenceBelow: 0.5,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "reviewer",
    ]);
    expect(events.ofType("task.escalated")).toHaveLength(1);
  });

  it("picks the lexicographically lowest rule id when multiple rules match", async () => {
    const worker = new ScriptedWorker((call) =>
      call.agent === "implementer"
        ? makeResult(call.taskId, "failed", { confidence: 0.1 })
        : makeResult(call.taskId, "success"),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "z-rule",
          fromAgent: "implementer",
          toAgent: "reviewer",
          afterFailures: 1,
        },
        {
          id: "a-rule",
          fromAgent: "implementer",
          toAgent: "architect",
          afterFailures: 1,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "architect",
    ]);
    expect(events.ofType("task.escalated")[0]?.data).toMatchObject({
      rule: "a-rule",
    });
  });

  it("treats a thrown-error attempt's confidence as 0 for confidenceBelow matching", async () => {
    const worker = new ScriptedWorker((call) => {
      if (call.agent === "implementer") throw new Error("boom");
      return makeResult(call.taskId, "success");
    });
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "on-throw",
          fromAgent: "implementer",
          toAgent: "architect",
          confidenceBelow: 0.01,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "architect",
    ]);
    expect(events.ofType("task.escalated")[0]?.data).toMatchObject({
      rule: "on-throw",
    });
  });

  it("records lastEscalation on the runtime task when an escalation reroutes it", async () => {
    const worker = new ScriptedWorker((call) =>
      call.agent === "implementer"
        ? makeResult(call.taskId, "failed")
        : makeResult(call.taskId, "success"),
    );
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "stuck",
          fromAgent: "implementer",
          toAgent: "architect",
          afterFailures: 1,
        },
      ],
    });

    await scheduler(worker).run("run-1", graph, policy);

    expect(graph.get("T01").lastEscalation).toEqual({
      rule: "stuck",
      from: "implementer",
      to: "architect",
    });
  });

  it("escalates when afterFailures equals maxAttempts, which the shipped template compiles to", async () => {
    // "Retry a failed worker once. If the second attempt fails, escalate one
    // tier up" is defaultMaxAttempts 2 + afterFailures 2 — a rule that only
    // becomes true after the last ordinary attempt, and so was unreachable
    // until a matching rule started granting the attempt it needs.
    const worker = new ScriptedWorker((call) =>
      call.agent === "coder"
        ? makeResult(call.taskId)
        : makeResult(call.taskId, "failed"),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-junior", agent: "junior", strength: "hard" }],
      escalation: [
        {
          id: "tier-up",
          fromAgent: "junior",
          toAgent: "coder",
          afterFailures: 2,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls.map((call) => call.agent)).toEqual([
      "junior",
      "junior",
      "coder",
    ]);
    expect(graph.get("T01").status).toBe("completed");
    expect(events.ofType("task.escalated")).toHaveLength(1);
    expect(events.ofType("task.escalated")[0]?.data).toEqual({
      from: "junior",
      to: "coder",
      rule: "tier-up",
    });
  });

  it("climbs the junior → coder → senior ladder, one granted attempt per rule", async () => {
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "failed"),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-junior", agent: "junior", strength: "hard" }],
      escalation: [
        {
          id: "e1-junior",
          fromAgent: "junior",
          toAgent: "coder",
          afterFailures: 2,
        },
        {
          id: "e2-coder",
          fromAgent: "coder",
          toAgent: "senior",
          afterFailures: 2,
        },
        {
          id: "e3-senior",
          fromAgent: "senior",
          toAgent: "architect",
          afterFailures: 2,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    // Two ordinary attempts, then one granted attempt per rule — and no more,
    // because every rule has spent its single grant.
    expect(worker.calls.map((call) => call.agent)).toEqual([
      "junior",
      "junior",
      "coder",
      "senior",
      "architect",
    ]);
    expect(events.ofType("task.escalated").map((event) => event.data)).toEqual([
      { from: "junior", to: "coder", rule: "e1-junior" },
      { from: "coder", to: "senior", rule: "e2-coder" },
      { from: "senior", to: "architect", rule: "e3-senior" },
    ]);
    expect(graph.get("T01").status).toBe("failed");
    expect([...(graph.get("T01").escalationsGranted ?? [])]).toEqual([
      "e1-junior",
      "e2-coder",
      "e3-senior",
    ]);
  });

  it("grants each rule at most once, so a rule pointing back at itself cannot loop", async () => {
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "failed"),
    );
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 1,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "self",
          fromAgent: "implementer",
          toAgent: "implementer",
          afterFailures: 1,
        },
      ],
    });

    await scheduler(worker).run("run-1", graph, policy);

    expect(worker.calls).toHaveLength(2);
    expect(graph.get("T01").status).toBe("failed");
  });

  it("grants nothing when there is no matching rule left", async () => {
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "failed"),
    );
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 2,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        // Hands off from an agent this task never ran as.
        {
          id: "elsewhere",
          fromAgent: "reviewer",
          toAgent: "architect",
          afterFailures: 1,
        },
      ],
    });

    await scheduler(worker).run("run-1", graph, policy);

    expect(worker.calls).toHaveLength(2);
    expect(graph.get("T01").status).toBe("failed");
    expect(graph.get("T01").escalationsGranted).toBeUndefined();
  });

  it("does not grant an escalated attempt to an aborted run", async () => {
    const controller = new AbortController();
    const worker = new ScriptedWorker((call) => {
      controller.abort();
      return makeResult(call.taskId, "failed");
    });
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 1,
      routing: [{ id: "all-junior", agent: "junior", strength: "hard" }],
      escalation: [
        {
          id: "tier-up",
          fromAgent: "junior",
          toAgent: "coder",
          afterFailures: 1,
        },
      ],
    });

    await scheduler(worker, events).run(
      "run-1",
      graph,
      policy,
      controller.signal,
    );

    expect(worker.calls).toHaveLength(1);
    expect(graph.get("T01").status).toBe("cancelled");
    expect(events.ofType("task.escalated")).toHaveLength(0);
    expect(graph.get("T01").escalationsGranted).toBeUndefined();
  });

  it("still accepts a low-confidence success once attempts are exhausted rather than granting one", async () => {
    // The grant is for tasks that would otherwise be *failed*. A
    // low-confidence success is accepted work, and that decision is unchanged.
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "success", { confidence: 0.2 }),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 1,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "low-conf",
          fromAgent: "implementer",
          toAgent: "architect",
          confidenceBelow: 0.5,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls).toHaveLength(1);
    expect(graph.get("T01").status).toBe("completed");
    expect(events.ofType("task.low_confidence")[0]?.data).toMatchObject({
      accepted: true,
    });
  });

  it("leaves lastEscalation unset when no escalation ever reroutes the task", async () => {
    const worker = new ScriptedWorker((call) => makeResult(call.taskId));
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run("run-1", graph, makePolicy());

    expect(graph.get("T01").lastEscalation).toBeUndefined();
  });
});
