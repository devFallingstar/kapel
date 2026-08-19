import type { ExecutionPlan, RuntimeTask } from "./types.js";

export class TaskGraph {
  readonly #tasks = new Map<string, RuntimeTask>();

  constructor(plan: ExecutionPlan) {
    for (const spec of plan.tasks) {
      if (this.#tasks.has(spec.id))
        throw new Error(`Duplicate task id: ${spec.id}`);
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
    const completed = new Set(
      this.all()
        .filter((t) => t.status === "completed")
        .map((t) => t.spec.id),
    );
    return this.all().filter(
      (task) =>
        (task.status === "pending" || task.status === "ready") &&
        task.spec.dependencies.every((dependency) => completed.has(dependency)),
    );
  }

  done(): boolean {
    return this.all().every((task) =>
      ["completed", "failed", "cancelled"].includes(task.status),
    );
  }

  /** Tasks that declare `id` as a direct dependency. */
  dependentsOf(id: string): readonly RuntimeTask[] {
    return this.all().filter((task) => task.spec.dependencies.includes(id));
  }

  #assertDependenciesExist(): void {
    for (const task of this.all()) {
      for (const dependency of task.spec.dependencies) {
        if (!this.#tasks.has(dependency))
          throw new Error(
            `Task ${task.spec.id} depends on missing task ${dependency}`,
          );
      }
    }
  }

  #assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id))
        throw new Error(`Task graph contains a cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.get(id).spec.dependencies)
        visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of this.all()) visit(task.spec.id);
  }
}
