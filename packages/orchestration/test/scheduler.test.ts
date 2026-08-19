import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  DeterministicScheduler,
  PolicyRouter,
  type RuntimeTask,
  TaskGraph,
  type TaskResult,
} from "../src/index.js";
import {
  makePlan,
  makePolicy,
  makeResult,
  makeTask,
  ScriptedWorker,
  sleep,
  type WorkerCall,
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
): DeterministicScheduler {
  return new DeterministicScheduler(new PolicyRouter(), worker, events);
}

/** Sleeps `ms`, then succeeds. */
function timed(durations: Readonly<Record<string, number>>) {
  return async (call: WorkerCall): Promise<TaskResult> => {
    await sleep(durations[call.taskId] ?? 5);
    return makeResult(call.taskId);
  };
}

describe("DeterministicScheduler", () => {
  it("runs a linear plan and reports completion", async () => {
    const worker = new ScriptedWorker((call) => makeResult(call.taskId));
    const events = new RecordingSink();
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02", dependencies: ["T01"] }),
      ]),
    );

    await scheduler(worker, events).run("run-1", graph, makePolicy());

    expect(graph.all().map((task) => task.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(worker.calls.map((call) => call.taskId)).toEqual(["T01", "T02"]);
    expect(events.types()).toEqual([
      "task.started",
      "task.completed",
      "task.started",
      "task.completed",
    ]);
    expect(events.ofType("task.started")[0]?.data).toEqual({
      agent: "architect",
      attempt: 1,
    });
  });

  it("fills a freed slot immediately instead of waiting for the wave", async () => {
    // T01 is slow; T02 is quick and unblocks T03. A wave scheduler would hold
    // T03 back until T01 finished.
    const worker = new ScriptedWorker(timed({ T01: 80, T02: 10, T03: 10 }));
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02" }),
        makeTask({ id: "T03", dependencies: ["T02"] }),
      ]),
    );

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({ maxConcurrency: 2 }),
    );

    const t01 = worker.callsFor("T01")[0];
    const t03 = worker.callsFor("T03")[0];
    expect(t01?.finishedAt).toBeGreaterThanOrEqual(70);
    expect(t03?.startedAt).toBeLessThan(t01?.finishedAt ?? 0);
    expect(worker.peakConcurrency).toBe(2);
    expect(graph.all().every((task) => task.status === "completed")).toBe(true);
  });

  it("never runs more than maxConcurrency tasks at once", async () => {
    const worker = new ScriptedWorker(timed({}));
    const graph = new TaskGraph(
      makePlan(
        ["T01", "T02", "T03", "T04", "T05"].map((id) => makeTask({ id })),
      ),
    );

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({ maxConcurrency: 2 }),
    );

    expect(worker.peakConcurrency).toBe(2);
    expect(worker.calls).toHaveLength(5);
  });

  it("serializes everything when parallelizeIndependentTasks is false", async () => {
    const worker = new ScriptedWorker(timed({ T01: 20, T02: 10, T03: 10 }));
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02" }),
        makeTask({ id: "T03" }),
      ]),
    );

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({ maxConcurrency: 4, parallelizeIndependentTasks: false }),
    );

    expect(worker.peakConcurrency).toBe(1);
    for (let index = 1; index < worker.calls.length; index += 1) {
      const previous = worker.calls[index - 1];
      const current = worker.calls[index];
      expect(current?.startedAt).toBeGreaterThanOrEqual(
        previous?.finishedAt ?? 0,
      );
    }
  });

  it("retries a failed attempt and completes on the retry", async () => {
    const worker = new ScriptedWorker((call) =>
      call.attempt === 1
        ? makeResult(call.taskId, "failed")
        : makeResult(call.taskId),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker, events).run(
      "run-1",
      graph,
      makePolicy({ defaultMaxAttempts: 2 }),
    );

    const task = graph.get("T01");
    expect(task.status).toBe("completed");
    expect(task.attempts).toBe(2);
    expect(worker.calls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(
      events
        .ofType("task.started")
        .map((event) => (event.data as { attempt: number }).attempt),
    ).toEqual([1, 2]);
    const completions = events.ofType("task.completed");
    expect(completions).toHaveLength(2);
    expect(completions[0]?.data).toMatchObject({ final: false });
    expect(completions[1]?.data).toMatchObject({ final: true });
  });

  it("treats a partial result as a failed attempt", async () => {
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "partial"),
    );
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({ defaultMaxAttempts: 1 }),
    );

    expect(graph.get("T01").status).toBe("failed");
  });

  it("escalates the retry to the rule's target agent", async () => {
    const worker = new ScriptedWorker((call) =>
      call.agent === "architect"
        ? makeResult(call.taskId)
        : makeResult(call.taskId, "failed"),
    );
    const events = new RecordingSink();
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

    await scheduler(worker, events).run("run-1", graph, policy);

    const task = graph.get("T01");
    expect(task.status).toBe("completed");
    expect(task.assignedAgent).toBe("architect");
    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "architect",
    ]);
    expect(events.ofType("task.escalated")[0]?.data).toEqual({
      from: "implementer",
      to: "architect",
      rule: "stuck",
    });
  });

  it("waits for the rule's failure threshold before escalating", async () => {
    const worker = new ScriptedWorker((call) =>
      call.attempt === 3
        ? makeResult(call.taskId)
        : makeResult(call.taskId, "failed"),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const policy = makePolicy({
      defaultMaxAttempts: 3,
      routing: [{ id: "all-impl", agent: "implementer", strength: "hard" }],
      escalation: [
        {
          id: "stuck",
          fromAgent: "implementer",
          toAgent: "reviewer",
          afterFailures: 2,
        },
      ],
    });

    await scheduler(worker, events).run("run-1", graph, policy);

    expect(worker.calls.map((call) => call.agent)).toEqual([
      "implementer",
      "implementer",
      "reviewer",
    ]);
    expect(events.ofType("task.escalated")).toHaveLength(1);
  });

  it("cancels every transitive dependent when a task exhausts its attempts", async () => {
    const worker = new ScriptedWorker((call) =>
      call.taskId === "T01"
        ? makeResult(call.taskId, "failed")
        : makeResult(call.taskId),
    );
    const events = new RecordingSink();
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02", dependencies: ["T01"] }),
        makeTask({ id: "T03", dependencies: ["T02"] }),
        makeTask({ id: "T04" }),
      ]),
    );

    await scheduler(worker, events).run(
      "run-1",
      graph,
      makePolicy({ defaultMaxAttempts: 1, maxConcurrency: 1 }),
    );

    expect(graph.get("T01").status).toBe("failed");
    expect(graph.get("T02").status).toBe("cancelled");
    expect(graph.get("T03").status).toBe("cancelled");
    expect(graph.get("T04").status).toBe("completed");
    expect(worker.calls.map((call) => call.taskId)).toEqual(["T01", "T04"]);

    const cancellations = events.ofType("task.cancelled");
    expect(cancellations.map((event) => event.taskId)).toEqual(["T02", "T03"]);
    expect(cancellations[0]?.data).toEqual({
      reason: "dependency-failed",
      dependency: "T01",
    });
    expect(cancellations[1]?.data).toEqual({
      reason: "dependency-failed",
      dependency: "T02",
    });
  });

  it("turns a throwing worker into a failed attempt", async () => {
    const worker = new ScriptedWorker(() => {
      throw new Error("worker exploded");
    });
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({ defaultMaxAttempts: 1 }),
    );

    const task = graph.get("T01");
    expect(task.status).toBe("failed");
    expect(task.result).toMatchObject({
      taskId: "T01",
      status: "failed",
      summary: "worker exploded",
      decisions: [],
      changedFiles: [],
      unresolvedIssues: [],
      confidence: 0,
      tests: { passed: 0, failed: 0, commands: [] },
    });
  });

  it("retries a throwing worker like any other failure", async () => {
    const worker = new ScriptedWorker((call) => {
      if (call.attempt === 1) throw new Error("transient");
      return makeResult(call.taskId);
    });
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({ defaultMaxAttempts: 2 }),
    );

    expect(graph.get("T01").status).toBe("completed");
  });

  it("hands the abort signal to the worker", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const worker = new ScriptedWorker((call, _task, signal) => {
      seen.push(signal);
      return makeResult(call.taskId);
    });
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy(),
      controller.signal,
    );

    expect(seen).toEqual([controller.signal]);
  });

  it("cancels the pending tasks when the run is aborted mid-flight", async () => {
    const controller = new AbortController();
    const worker = new ScriptedWorker(async (call) => {
      if (call.taskId === "T01") {
        await sleep(10);
        controller.abort();
      }
      return makeResult(call.taskId);
    });
    const events = new RecordingSink();
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01" }),
        makeTask({ id: "T02" }),
        makeTask({ id: "T03", dependencies: ["T02"] }),
      ]),
    );

    await expect(
      scheduler(worker, events).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 1 }),
        controller.signal,
      ),
    ).resolves.toBeUndefined();

    expect(graph.get("T01").status).toBe("completed");
    expect(graph.get("T02").status).toBe("cancelled");
    expect(graph.get("T03").status).toBe("cancelled");
    expect(worker.calls.map((call) => call.taskId)).toEqual(["T01"]);
    expect(events.ofType("task.cancelled").map((event) => event.data)).toEqual([
      { reason: "aborted" },
      { reason: "aborted" },
    ]);
  });

  it("cancels rather than retries an in-flight task that fails after an abort", async () => {
    const controller = new AbortController();
    const worker = new ScriptedWorker(async () => {
      controller.abort();
      await sleep(5);
      throw new Error("aborted by the caller");
    });
    const events = new RecordingSink();
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker, events).run(
      "run-1",
      graph,
      makePolicy({ defaultMaxAttempts: 3 }),
      controller.signal,
    );

    expect(graph.get("T01").status).toBe("cancelled");
    expect(graph.get("T01").attempts).toBe(1);
    expect(events.ofType("task.cancelled")[0]?.data).toEqual({
      reason: "aborted",
    });
  });

  it("does nothing but cancel when the signal is aborted before the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = new ScriptedWorker((call) => makeResult(call.taskId));
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy(),
      controller.signal,
    );

    expect(worker.calls).toHaveLength(0);
    expect(graph.get("T01").status).toBe("cancelled");
  });

  it("throws when unfinished tasks exist but none can run", async () => {
    const worker = new ScriptedWorker((call) => makeResult(call.taskId));
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
    const blocked: RuntimeTask = graph.get("T01");
    blocked.status = "blocked";

    await expect(
      scheduler(worker).run("run-1", graph, makePolicy()),
    ).rejects.toThrow("Scheduler deadlock");
  });

  it("records the assigned agent and result on the runtime task", async () => {
    const worker = new ScriptedWorker((call) =>
      makeResult(call.taskId, "success", { changedFiles: ["a.ts"] }),
    );
    const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

    await scheduler(worker).run(
      "run-1",
      graph,
      makePolicy({
        routing: [
          {
            id: "impl",
            taskTypes: ["implementation"],
            agent: "implementer",
            strength: "hard",
          },
        ],
      }),
    );

    const task = graph.get("T01");
    expect(task.assignedAgent).toBe("implementer");
    expect(task.result?.changedFiles).toEqual(["a.ts"]);
    expect(task.attempts).toBe(1);
  });
});
