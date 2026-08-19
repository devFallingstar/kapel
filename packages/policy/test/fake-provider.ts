import type {
  ModelDefinition,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from "@agent/ai";

export const fakeModel: ModelDefinition = {
  provider: "fake",
  id: "fake-compiler-1",
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
    if (turn === undefined) {
      throw new Error(`FakeProvider: no scripted turn for request ${index}`);
    }
    for (const event of turn) {
      // Mirror the real providers: stop silently once aborted.
      if (signal?.aborted === true) return;
      yield event;
    }
  }
}

export function toolTurn(input: unknown, id = "call_1"): Turn {
  return [
    { type: "tool.call", id, name: "emit_policy", input },
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

export const SAMPLE_MARKDOWN = `# Orchestration

The architect plans the work. Prefer the implementer for refactors.
Anything touching auth requires a blocking review by the reviewer.
Run at most three workers concurrently; retry once, then escalate.
`;

export const KNOWN_AGENTS = ["architect", "implementer", "reviewer"] as const;

/** A minimal, valid emit_policy payload. */
export const VALID_INPUT = {
  policy: {
    version: 1,
    orchestrator: "architect",
    maxConcurrency: 3,
    routing: [
      {
        id: "route-refactors",
        taskTypes: ["refactor"],
        agent: "implementer",
        strength: "preference",
      },
    ],
    review: [
      {
        id: "review-auth",
        riskCategories: ["auth"],
        reviewer: "reviewer",
        blocking: true,
        strength: "hard",
      },
    ],
    escalation: [
      {
        id: "escalate-stuck",
        fromAgent: "implementer",
        toAgent: "architect",
        afterFailures: 2,
      },
    ],
    defaultMaxAttempts: 2,
  },
  warnings: ["Mapped 'three workers' to maxConcurrency 3."],
  ambiguities: ["'ship it when it feels right' — no measurable condition."],
};
