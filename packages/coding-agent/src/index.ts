import {
  DeterministicScheduler,
  type ExecutionPlan,
  PolicyRouter,
  TaskGraph,
  type WorkerExecutor,
} from "@agent/orchestration";
import type { OrchestrationPolicy, PolicyCompiler } from "@agent/policy";
import { PolicySchema, validatePolicy } from "@agent/policy";
import { type EventBus, InMemoryEventBus } from "@agent/protocol";
import type { SessionStore } from "@agent/session";

export interface Planner {
  plan(
    objective: string,
    policy: OrchestrationPolicy,
    signal?: AbortSignal,
  ): Promise<ExecutionPlan>;
}

export interface RuntimeOptions {
  readonly policyCompiler: PolicyCompiler;
  readonly planner: Planner;
  readonly worker: WorkerExecutor;
  readonly sessions: SessionStore;
  readonly events?: EventBus;
  readonly knownAgents: ReadonlySet<string>;
}

export class CodingAgentRuntime {
  readonly #events: EventBus;

  constructor(private readonly options: RuntimeOptions) {
    this.#events = options.events ?? new InMemoryEventBus();
    this.#events.subscribe((event) => options.sessions.appendEvent(event));
  }

  events(): EventBus {
    return this.#events;
  }

  async compilePolicy(
    markdown: string,
    signal?: AbortSignal,
  ): Promise<OrchestrationPolicy> {
    const compiled = await this.options.policyCompiler.compile(
      markdown,
      signal,
    );
    const policy = PolicySchema.parse(compiled.policy);
    const issues = validatePolicy(policy, this.options.knownAgents);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0)
      throw new Error(errors.map((issue) => issue.message).join("\n"));
    return policy;
  }

  async run(
    objective: string,
    policy: OrchestrationPolicy,
    signal?: AbortSignal,
  ): Promise<string> {
    const runId = crypto.randomUUID();
    await this.options.sessions.createRun({
      id: runId,
      objective,
      createdAt: Date.now(),
      policySnapshot: policy,
    });
    await this.#events.emit({
      id: crypto.randomUUID(),
      runId,
      timestamp: Date.now(),
      type: "run.started",
      data: { objective },
    });

    const plan = await this.options.planner.plan(objective, policy, signal);
    const graph = new TaskGraph(plan);
    const scheduler = new DeterministicScheduler(
      new PolicyRouter(),
      this.options.worker,
      this.#events,
    );
    await scheduler.run(runId, graph, policy, signal);

    await this.#events.emit({
      id: crypto.randomUUID(),
      runId,
      timestamp: Date.now(),
      type: "run.completed",
      data: { tasks: graph.all() },
    });
    return runId;
  }
}

export * from "@agent/orchestration";
export * from "@agent/policy";
export * from "./backends/index.js";
export * from "./chat.js";
export * from "./loop.js";
export * from "./permissions.js";
export * from "./platform/index.js";
export * from "./project/index.js";
export * from "./tools/index.js";
export * from "./validation/index.js";
export * from "./workers/index.js";
