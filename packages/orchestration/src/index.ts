import type { OrchestrationPolicy } from "@agent/policy";
import type { EventSink } from "@agent/protocol";

export type TaskType = "exploration" | "architecture" | "implementation" | "testing" | "review" | "documentation";
export type TaskComplexity = "trivial" | "normal" | "complex" | "architectural";
export type TaskStatus = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly type: TaskType;
  readonly complexity: TaskComplexity;
  readonly dependencies: readonly string[];
  readonly suggestedAgent?: string;
  readonly affectedAreas: readonly string[];
  readonly risk: {
    readonly level: "low" | "medium" | "high";
    readonly categories: readonly string[];
  };
}

export interface ExecutionPlan {
  readonly objective: string;
  readonly tasks: readonly PlannedTask[];
}

export interface TaskResult {
  readonly taskId: string;
  readonly status: "success" | "failed" | "partial";
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly changedFiles: readonly string[];
  readonly commit?: string;
  readonly tests: {
    readonly passed: number;
    readonly failed: number;
    readonly commands: readonly string[];
  };
  readonly unresolvedIssues: readonly string[];
  readonly confidence: number;
}

export interface RuntimeTask {
  readonly spec: PlannedTask;
  status: TaskStatus;
  assignedAgent?: string;
  workerId?: string;
  attempts: number;
  result?: TaskResult;
}

export class TaskGraph {
  readonly #tasks = new Map<string, RuntimeTask>();

  constructor(plan: ExecutionPlan) {
    for (const spec of plan.tasks) {
      if (this.#tasks.has(spec.id)) throw new Error(`Duplicate task id: ${spec.id}`);
      this.#tasks.set(spec.id, { spec, status: "pending", attempts: 0 });
    }
    this.#assertDependenciesExist();
    this.#assertAcyclic();
  }

  all(): readonly RuntimeTask[] {
    return [...this.#tasks.values()];
  }

  get(id: string): RuntimeTask {
    const task = this.#tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  ready(): readonly RuntimeTask[] {
    const completed = new Set(this.all().filter((t) => t.status === "completed").map((t) => t.spec.id));
    return this.all().filter((task) =>
      (task.status === "pending" || task.status === "ready") &&
      task.spec.dependencies.every((dependency) => completed.has(dependency)),
    );
  }

  done(): boolean {
    return this.all().every((task) => ["completed", "failed", "cancelled"].includes(task.status));
  }

  #assertDependenciesExist(): void {
    for (const task of this.all()) {
      for (const dependency of task.spec.dependencies) {
        if (!this.#tasks.has(dependency)) throw new Error(`Task ${task.spec.id} depends on missing task ${dependency}`);
      }
    }
  }

  #assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Task graph contains a cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.get(id).spec.dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of this.all()) visit(task.spec.id);
  }
}

export interface AgentRouter {
  route(task: PlannedTask, policy: OrchestrationPolicy): string;
}

export class PolicyRouter implements AgentRouter {
  route(task: PlannedTask, policy: OrchestrationPolicy): string {
    const hard = policy.routing.find((rule) =>
      rule.strength === "hard" && matches(rule.taskTypes, task.type) && matches(rule.riskCategories, task.risk.categories),
    );
    if (hard) return hard.agent;

    const candidates = policy.routing
      .filter((rule) => matches(rule.taskTypes, task.type) && matches(rule.riskCategories, task.risk.categories))
      .sort((a, b) => b.weight - a.weight);
    return candidates[0]?.agent ?? task.suggestedAgent ?? policy.orchestrator;
  }
}

function matches(expected: readonly string[], actual: string | readonly string[]): boolean {
  if (expected.length === 0) return true;
  const values: readonly string[] = typeof actual === "string" ? [actual] : actual;
  return expected.some((value) => values.includes(value));
}

export interface WorkerExecutor {
  execute(task: RuntimeTask, agent: string, signal?: AbortSignal): Promise<TaskResult>;
}

export class DeterministicScheduler {
  constructor(
    private readonly router: AgentRouter,
    private readonly worker: WorkerExecutor,
    private readonly events?: EventSink,
  ) {}

  async run(runId: string, graph: TaskGraph, policy: OrchestrationPolicy, signal?: AbortSignal): Promise<void> {
    while (!graph.done()) {
      const ready = graph.ready().slice(0, policy.maxConcurrency);
      if (ready.length === 0) {
        const unfinished = graph.all().filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
        if (unfinished.length > 0) throw new Error("Scheduler deadlock: unfinished tasks exist but none are runnable.");
        return;
      }

      await Promise.all(ready.map(async (task) => {
        const agent = this.router.route(task.spec, policy);
        task.assignedAgent = agent;
        task.status = "running";
        task.attempts += 1;
        await this.events?.emit(event(runId, "task.started", task.spec.id, { agent, attempt: task.attempts }));
        const result = await this.worker.execute(task, agent, signal);
        task.result = result;
        task.status = result.status === "success" ? "completed" : "failed";
        await this.events?.emit(event(runId, "task.completed", task.spec.id, { agent, result }));
      }));
    }
  }
}

function event(runId: string, type: string, taskId: string, data: unknown) {
  return { id: crypto.randomUUID(), runId, timestamp: Date.now(), type, taskId, data };
}
