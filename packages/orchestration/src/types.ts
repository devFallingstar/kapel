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
  /**
   * The most recent escalation that rerouted this task, if any. Set whenever
   * the scheduler dispatches an attempt to a rule's `toAgent` instead of the
   * router's normal pick, and left in place afterwards as a record of the
   * last reroute (it is not cleared on a later non-escalated attempt).
   */
  lastEscalation?: {
    readonly rule: string;
    readonly from: string;
    readonly to: string;
  };
  /**
   * Ids of escalation rules that have already bought this task an attempt it
   * would not otherwise have had (see the scheduler's `#grantEscalatedAttempt`).
   * Each rule may do so at most once per task, which is what keeps a chain of
   * escalations finite: junior→coder→senior is three agents and two rules, so
   * it walks to the top and stops, and a policy whose rules point back at each
   * other runs out of unused rules instead of retrying forever.
   */
  escalationsGranted?: Set<string>;
}

/** Results a task's direct dependencies produced, handed to its worker. */
export interface WorkerExecutionContext {
  /** Results of the task's direct dependencies, in dependency-declaration order. */
  readonly dependencyResults: readonly TaskResult[];
}

/** What an executor can say about an agent ahead of actually running it. */
export interface WorkerAgentDescription {
  /** The model id the agent would run with, when the executor can tell without executing. */
  readonly model?: string;
}

export interface WorkerExecutor {
  execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult>;
  /**
   * Best-effort, synchronous lookup of what `agent` would run with — used to
   * surface the model in `task.started` before the task actually executes.
   * Optional: an executor that cannot answer without running the task (or
   * that has nothing to say) simply omits it, and callers treat a missing
   * answer, or `undefined` back, as "unknown".
   */
  describeAgent?(agent: string): WorkerAgentDescription | undefined;
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
