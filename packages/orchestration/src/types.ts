export type TaskType =
  | "exploration"
  | "architecture"
  | "implementation"
  | "testing"
  | "review"
  | "documentation";
export type TaskComplexity = "trivial" | "normal" | "complex" | "architectural";
export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

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

/** Results a task's direct dependencies produced, handed to its worker. */
export interface WorkerExecutionContext {
  /** Results of the task's direct dependencies, in dependency-declaration order. */
  readonly dependencyResults: readonly TaskResult[];
}

export interface WorkerExecutor {
  execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult>;
}

/** Statuses a task can no longer leave. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Ordering used whenever a policy compares complexities. */
const COMPLEXITY_ORDER: readonly TaskComplexity[] = [
  "trivial",
  "normal",
  "complex",
  "architectural",
];

/** Rank of a complexity: trivial < normal < complex < architectural. */
export function complexityRank(complexity: TaskComplexity): number {
  const index = COMPLEXITY_ORDER.indexOf(complexity);
  return index === -1 ? 0 : index;
}
