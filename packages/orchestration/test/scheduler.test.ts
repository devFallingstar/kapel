import type { AgentEvent, EventSink } from "@agent/protocol";
import { describe, expect, it } from "vitest";
import {
  DeterministicScheduler,
  PolicyRouter,
  type RuntimeTask,
  type SchedulerOptions,
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
  options?: SchedulerOptions,
): DeterministicScheduler {
  return new DeterministicScheduler(
    new PolicyRouter(),
    worker,
    events,
    options,
  );
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
      routing: { reason: "orchestrator" },
    });
  });

  describe("task.started routing and model", () => {
    it("reports the winning rule and the agent's model when a routing rule matches", async () => {
      const worker = new ScriptedWorker((call) => makeResult(call.taskId), {
        implementer: "claude-haiku-4-5",
      });
      const events = new RecordingSink();
      const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
      const policy = makePolicy({
        routing: [
          {
            id: "implementation",
            taskTypes: ["implementation"],
            agent: "implementer",
            strength: "hard",
          },
        ],
      });

      await scheduler(worker, events).run("run-1", graph, policy);

      expect(events.ofType("task.started")[0]?.data).toEqual({
        agent: "implementer",
        attempt: 1,
        model: "claude-haiku-4-5",
        routing: { rule: "implementation", reason: "rule" },
      });
    });

    it("reports the orchestrator fallback with no rule id when nothing matched", async () => {
      const worker = new ScriptedWorker((call) => makeResult(call.taskId), {
        architect: "claude-opus-4-5",
      });
      const events = new RecordingSink();
      const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));

      await scheduler(worker, events).run("run-1", graph, makePolicy());

      expect(events.ofType("task.started")[0]?.data).toEqual({
        agent: "architect",
        attempt: 1,
        model: "claude-opus-4-5",
        routing: { reason: "orchestrator" },
      });
    });

    it("reports the task's suggestedAgent fallback when no rule matches but a suggestion exists", async () => {
      const worker = new ScriptedWorker((call) => makeResult(call.taskId));
      const events = new RecordingSink();
      const graph = new TaskGraph(
        makePlan([makeTask({ id: "T01", suggestedAgent: "implementer" })]),
      );

      await scheduler(worker, events).run("run-1", graph, makePolicy());

      expect(events.ofType("task.started")[0]?.data).toEqual({
        agent: "implementer",
        attempt: 1,
        routing: { reason: "suggestedAgent" },
      });
    });

    it("reports reason 'escalation' and the escalation rule id, plus the new model, on the escalated attempt", async () => {
      const worker = new ScriptedWorker(
        (call) =>
          call.agent === "architect"
            ? makeResult(call.taskId)
            : makeResult(call.taskId, "failed"),
        { implementer: "claude-haiku-4-5", architect: "claude-opus-4-5" },
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

      const started = events.ofType("task.started");
      expect(started[0]?.data).toEqual({
        agent: "implementer",
        attempt: 1,
        model: "claude-haiku-4-5",
        routing: { rule: "all-impl", reason: "rule" },
      });
      expect(started[1]?.data).toEqual({
        agent: "architect",
        attempt: 2,
        model: "claude-opus-4-5",
        routing: { rule: "stuck", reason: "escalation" },
      });
    });
  });

  it("fills a freed slot immediately instead of waiting for the wave", async () => {
    // T01 is slow; T02 is quick and unblocks T03. A wave scheduler would hold
    // T03 back until T01 finished. Areas are disjoint so this exercises pure
    // slot-filling, not the affected-area conflict gating.
    const worker = new ScriptedWorker(timed({ T01: 80, T02: 10, T03: 10 }));
    const graph = new TaskGraph(
      makePlan([
        makeTask({ id: "T01", affectedAreas: ["areaT01"] }),
        makeTask({ id: "T02", affectedAreas: ["areaT02"] }),
        makeTask({
          id: "T03",
          dependencies: ["T02"],
          affectedAreas: ["areaT03"],
        }),
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
        // Disjoint areas: this test is about the concurrency limit, not
        // affected-area conflict gating.
        ["T01", "T02", "T03", "T04", "T05"].map((id) =>
          makeTask({ id, affectedAreas: [`area-${id}`] }),
        ),
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

  describe("affected-area conflict gating", () => {
    it("serializes two mutating tasks whose affected areas overlap, holding the second until the first frees its slot", async () => {
      const worker = new ScriptedWorker(timed({ T01: 30, T02: 5 }));
      const events = new RecordingSink();
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "implementation",
            affectedAreas: ["src/api"],
          }),
          makeTask({
            id: "T02",
            type: "testing",
            affectedAreas: ["src/api/handler.ts"],
          }),
        ]),
      );

      await scheduler(worker, events).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 2 }),
      );

      expect(worker.peakConcurrency).toBe(1);
      const t01 = worker.callsFor("T01")[0];
      const t02 = worker.callsFor("T02")[0];
      expect(t02?.startedAt).toBeGreaterThanOrEqual(t01?.finishedAt ?? 0);
      expect(graph.all().every((task) => task.status === "completed")).toBe(
        true,
      );

      const held = events.ofType("task.held");
      expect(held).toHaveLength(1);
      expect(held[0]?.data).toEqual({ taskId: "T02", conflictsWith: "T01" });
    });

    it("emits task.held at most once per (task, blocking task) pair", async () => {
      // T02 is quick and will observe the same running T01 as a blocker on
      // several dispatch passes while T01 is still in flight.
      const worker = new ScriptedWorker(timed({ T01: 40, T02: 5 }));
      const events = new RecordingSink();
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "implementation",
            affectedAreas: ["src"],
          }),
          makeTask({
            id: "T02",
            type: "implementation",
            affectedAreas: ["src/x"],
          }),
        ]),
      );

      await scheduler(worker, events).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 2 }),
      );

      expect(events.ofType("task.held")).toHaveLength(1);
    });

    it("runs two mutating tasks with disjoint affected areas fully in parallel", async () => {
      const worker = new ScriptedWorker(timed({ T01: 30, T02: 30 }));
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "implementation",
            affectedAreas: ["src/api"],
          }),
          makeTask({
            id: "T02",
            type: "implementation",
            affectedAreas: ["src/web"],
          }),
        ]),
      );

      await scheduler(worker).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 2 }),
      );

      expect(worker.peakConcurrency).toBe(2);
      expect(graph.all().every((task) => task.status === "completed")).toBe(
        true,
      );
    });

    it("does not serialize a read-only exploration task against an overlapping mutating task", async () => {
      const worker = new ScriptedWorker(timed({ T01: 30, T02: 30 }));
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "exploration",
            affectedAreas: ["src/api"],
          }),
          makeTask({
            id: "T02",
            type: "implementation",
            affectedAreas: ["src/api"],
          }),
        ]),
      );

      await scheduler(worker).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 2 }),
      );

      expect(worker.peakConcurrency).toBe(2);
    });

    it("does not serialize two read-only tasks against each other", async () => {
      const worker = new ScriptedWorker(timed({ T01: 30, T02: 30 }));
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "exploration",
            affectedAreas: ["src/api"],
          }),
          makeTask({
            id: "T02",
            type: "review",
            affectedAreas: ["src/api"],
          }),
        ]),
      );

      await scheduler(worker).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 2 }),
      );

      expect(worker.peakConcurrency).toBe(2);
    });

    it("restores the old fully-parallel behavior when serializeOverlappingAreas is false", async () => {
      const worker = new ScriptedWorker(timed({ T01: 30, T02: 30 }));
      const events = new RecordingSink();
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "implementation",
            affectedAreas: ["src/api"],
          }),
          makeTask({
            id: "T02",
            type: "implementation",
            affectedAreas: ["src/api"],
          }),
        ]),
      );

      await scheduler(worker, events, {
        serializeOverlappingAreas: false,
      }).run("run-1", graph, makePolicy({ maxConcurrency: 2 }));

      expect(worker.peakConcurrency).toBe(2);
      expect(events.ofType("task.held")).toHaveLength(0);
    });

    it("does not deadlock when every ready task is held back by one running task", async () => {
      // T01 claims the whole repo; T02 and T03 are ready immediately but both
      // conflict with it, so the dispatch loop must not mistake "nothing
      // dispatchable this tick" for "unrunnable forever".
      const worker = new ScriptedWorker(timed({ T01: 20, T02: 5, T03: 5 }));
      const graph = new TaskGraph(
        makePlan([
          makeTask({
            id: "T01",
            type: "implementation",
            affectedAreas: ["**"],
          }),
          makeTask({
            id: "T02",
            type: "implementation",
            affectedAreas: ["src/a"],
          }),
          makeTask({
            id: "T03",
            type: "implementation",
            affectedAreas: ["src/b"],
          }),
        ]),
      );

      await expect(
        scheduler(worker).run(
          "run-1",
          graph,
          makePolicy({ maxConcurrency: 3 }),
        ),
      ).resolves.toBeUndefined();

      expect(graph.all().every((task) => task.status === "completed")).toBe(
        true,
      );
      expect(worker.calls).toHaveLength(3);
    });

    it("still throws the original deadlock error when nothing is running and nothing can dispatch", async () => {
      const worker = new ScriptedWorker((call) => makeResult(call.taskId));
      const graph = new TaskGraph(makePlan([makeTask({ id: "T01" })]));
      const blocked: RuntimeTask = graph.get("T01");
      blocked.status = "blocked";

      await expect(
        scheduler(worker).run("run-1", graph, makePolicy()),
      ).rejects.toThrow("Scheduler deadlock");
    });
  });

  describe("dependency-result context", () => {
    it("gives a root task an empty dependencyResults array", async () => {
      const worker = new ScriptedWorker((call) => makeResult(call.taskId));
      const graph = new TaskGraph(
        makePlan([makeTask({ id: "T01", affectedAreas: ["areaA"] })]),
      );

      await scheduler(worker).run("run-1", graph, makePolicy());

      expect(worker.callsFor("T01")[0]?.context?.dependencyResults).toEqual([]);
    });

    it("delivers a dependent task its dependencies' results", async () => {
      const worker = new ScriptedWorker((call) =>
        makeResult(call.taskId, "success", {
          summary: `${call.taskId}: done`,
        }),
      );
      const graph = new TaskGraph(
        makePlan([
          makeTask({ id: "T01", affectedAreas: ["areaA"] }),
          makeTask({
            id: "T02",
            dependencies: ["T01"],
            affectedAreas: ["areaB"],
          }),
        ]),
      );

      await scheduler(worker).run("run-1", graph, makePolicy());

      const context = worker.callsFor("T02")[0]?.context;
      expect(context?.dependencyResults).toHaveLength(1);
      expect(context?.dependencyResults[0]).toMatchObject({
        taskId: "T01",
        summary: "T01: done",
      });
    });

    it("orders dependencyResults to match dependency-declaration order, not completion order", async () => {
      // T02 is faster than T01 and finishes first, so if the scheduler used
      // completion order this would come out as [T02, T01] instead.
      const worker = new ScriptedWorker(timed({ T01: 30, T02: 5 }));
      const graph = new TaskGraph(
        makePlan([
          makeTask({ id: "T01", affectedAreas: ["areaA"] }),
          makeTask({ id: "T02", affectedAreas: ["areaB"] }),
          makeTask({
            id: "T03",
            dependencies: ["T01", "T02"],
            affectedAreas: ["areaC"],
          }),
        ]),
      );

      await scheduler(worker).run(
        "run-1",
        graph,
        makePolicy({ maxConcurrency: 2 }),
      );

      const context = worker.callsFor("T03")[0]?.context;
      expect(context?.dependencyResults.map((result) => result.taskId)).toEqual(
        ["T01", "T02"],
      );
    });
  });
});
