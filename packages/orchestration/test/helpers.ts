import type {
  ModelDefinition,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@agent/ai";
import { type OrchestrationPolicy, PolicySchema } from "@agent/policy";
import type {
  ExecutionPlan,
  PlannedTask,
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutionContext,
  WorkerExecutor,
} from "../src/index.js";

export const fakeModel: ModelDefinition = {
  provider: "fake",
  id: "fake-planner-1",
  capabilities: {
    tools: true,
    reasoning: false,
    vision: false,
    structuredOutput: true,
  },
};

/** One scripted turn: the events the provider yields for that request. */
export type Turn = readonly ModelEvent[];

/**
 * A provider that replays scripted turns and records every request it saw.
 * `onStream` runs before the turn is yielded, so a test can abort mid-flight.
 */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly requests: ModelRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  readonly #turns: readonly Turn[];
  readonly #onStream: ((index: number) => void) | undefined;

  constructor(turns: readonly Turn[], onStream?: (index: number) => void) {
    this.#turns = turns;
    this.#onStream = onStream;
  }

  supports(_model: ModelDefinition): boolean {
    return true;
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    this.signals.push(signal);
    this.#onStream?.(index);

    const turn = this.#turns[index];
    if (turn === undefined)
      throw new Error(`FakeProvider: no scripted turn for request ${index}`);
    for (const event of turn) {
      if (signal?.aborted === true) return;
      yield event;
    }
  }
}

export function toolTurn(input: unknown, id = "call_1"): Turn {
  return [
    { type: "tool.call", id, name: "emit_plan", input },
    { type: "usage", inputTokens: 100, outputTokens: 50 },
    { type: "done", finishReason: "tool_use" },
  ];
}

export function textTurn(text: string): Turn {
  return [
    { type: "text.delta", text },
    { type: "done", finishReason: "end_turn" },
  ];
}

export const KNOWN_AGENTS = ["architect", "implementer", "reviewer"] as const;

export const OBJECTIVE = "Add rate limiting to the public API";

/** A minimal, valid emit_plan payload. */
export const VALID_PLAN_INPUT = {
  objective: OBJECTIVE,
  tasks: [
    {
      id: "T01",
      title: "Survey the request pipeline",
      goal: "Map where requests enter packages/api and where a limiter could sit.",
      type: "exploration",
      complexity: "normal",
      dependencies: [],
      affectedAreas: ["packages/api/src"],
      risk: { level: "low", categories: [] },
    },
    {
      id: "T02",
      title: "Implement the token bucket limiter",
      goal: "Add a per-key token bucket limiter in packages/api/src/limit.ts and wire it into the router.",
      type: "implementation",
      complexity: "complex",
      dependencies: ["T01"],
      suggestedAgent: "implementer",
      affectedAreas: ["packages/api/src/limit.ts"],
      risk: { level: "high", categories: ["auth"] },
    },
  ],
};

export function makePolicy(
  overrides: Record<string, unknown> = {},
): OrchestrationPolicy {
  return PolicySchema.parse({
    version: 1,
    orchestrator: "architect",
    ...overrides,
  });
}

export function makeTask(
  overrides: Partial<PlannedTask> & { readonly id: string },
): PlannedTask {
  return {
    title: `Task ${overrides.id}`,
    goal: `Do the work for ${overrides.id}`,
    type: "implementation",
    complexity: "normal",
    dependencies: [],
    affectedAreas: [],
    ...overrides,
    risk: overrides.risk ?? { level: "low", categories: [] },
  };
}

export function makePlan(
  tasks: readonly PlannedTask[],
  objective = OBJECTIVE,
): ExecutionPlan {
  return { objective, tasks };
}

export function makeResult(
  taskId: string,
  status: TaskResult["status"] = "success",
  overrides: Partial<TaskResult> = {},
): TaskResult {
  return {
    taskId,
    status,
    summary: `${taskId}: ${status}`,
    decisions: [],
    changedFiles: [],
    tests: { passed: 0, failed: 0, commands: [] },
    unresolvedIssues: [],
    confidence: status === "success" ? 0.9 : 0.1,
    ...overrides,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkerCall {
  readonly taskId: string;
  readonly agent: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly context?: WorkerExecutionContext;
  finishedAt?: number;
}

export type WorkerHandler = (
  call: WorkerCall,
  task: RuntimeTask,
  signal?: AbortSignal,
) => Promise<TaskResult> | TaskResult;

/** Records call timing and concurrency so tests can assert on scheduling. */
export class ScriptedWorker implements WorkerExecutor {
  readonly calls: WorkerCall[] = [];
  peakConcurrency = 0;
  #running = 0;
  readonly #handler: WorkerHandler;
  readonly #start = Date.now();
  readonly #models?: Readonly<Record<string, string>>;

  /**
   * `models` maps an agent name to the model {@link describeAgent} reports
   * for it — mirroring what `AgentLoopWorkerExecutor` derives from a real
   * project. Omitted entirely, `describeAgent` reports nothing for any
   * agent, matching an executor that cannot say ahead of time.
   */
  constructor(
    handler: WorkerHandler,
    models?: Readonly<Record<string, string>>,
  ) {
    this.#handler = handler;
    this.#models = models;
  }

  describeAgent(agent: string): WorkerAgentDescription | undefined {
    const model = this.#models?.[agent];
    return model === undefined ? undefined : { model };
  }

  /** Calls for a task id, in dispatch order. */
  callsFor(taskId: string): readonly WorkerCall[] {
    return this.calls.filter((call) => call.taskId === taskId);
  }

  async execute(
    task: RuntimeTask,
    agent: string,
    signal?: AbortSignal,
    context?: WorkerExecutionContext,
  ): Promise<TaskResult> {
    const call: WorkerCall = {
      taskId: task.spec.id,
      agent,
      attempt: task.attempts,
      startedAt: Date.now() - this.#start,
      ...(context !== undefined ? { context } : {}),
    };
    this.calls.push(call);
    this.#running += 1;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.#running);
    try {
      return await this.#handler(call, task, signal);
    } finally {
      this.#running -= 1;
      call.finishedAt = Date.now() - this.#start;
    }
  }
}
