import type { ModelMessage, ModelRequest } from "@agent/ai";
import { describe, expect, it } from "vitest";
import {
  EMIT_PLAN_TOOL_NAME,
  emitPlanTool,
  LlmPlanner,
  PlanError,
} from "../src/index.js";
import {
  FakeProvider,
  fakeModel,
  KNOWN_AGENTS,
  makePolicy,
  OBJECTIVE,
  textTurn,
  toolTurn,
  VALID_PLAN_INPUT,
} from "./helpers.js";

function planner(provider: FakeProvider, maxAttempts?: number): LlmPlanner {
  return new LlmPlanner({
    provider,
    model: fakeModel,
    knownAgents: [...KNOWN_AGENTS],
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

const policy = makePolicy({
  maxConcurrency: 3,
  routing: [
    {
      id: "route-auth",
      riskCategories: ["auth"],
      agent: "reviewer",
      strength: "hard",
    },
  ],
  review: [
    {
      id: "review-payments",
      riskCategories: ["payments"],
      reviewer: "reviewer",
      blocking: true,
      strength: "hard",
    },
  ],
});

function systemText(request: ModelRequest | undefined): string {
  return (
    request?.messages.find((message) => message.role === "system")?.content ??
    ""
  );
}

function allText(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .map((message: ModelMessage) => message.content)
    .join("\n");
}

describe("LlmPlanner", () => {
  it("returns the plan from a single forced tool call", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    const plan = await planner(provider).plan(OBJECTIVE, policy);

    expect(provider.requests).toHaveLength(1);
    expect(plan.objective).toBe(OBJECTIVE);
    expect(plan.tasks.map((task) => task.id)).toEqual(["T01", "T02"]);
    expect(plan.tasks[1]).toMatchObject({
      dependencies: ["T01"],
      suggestedAgent: "implementer",
      type: "implementation",
      risk: { level: "high", categories: ["auth"] },
    });
    expect(plan.tasks[0]).not.toHaveProperty("suggestedAgent");
  });

  it("forces the emit_plan tool with a $schema-free input schema", () => {
    const schema = emitPlanTool.inputSchema as Record<string, unknown>;
    expect(emitPlanTool.name).toBe(EMIT_PLAN_TOOL_NAME);
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.required).toEqual(["objective", "tasks"]);
    expect(JSON.stringify(schema)).toContain("suggestedAgent");
  });

  it("sends the tool, the tool choice and the objective", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    await planner(provider).plan(OBJECTIVE, policy);

    const request = provider.requests[0];
    expect(request?.model).toBe(fakeModel);
    expect(request?.tools).toEqual([emitPlanTool]);
    expect(request?.toolChoice).toEqual({
      type: "tool",
      name: EMIT_PLAN_TOOL_NAME,
    });
    expect(allText(request)).toContain(OBJECTIVE);
  });

  it("names the known agents and the policy's risk vocabulary in the prompt", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    await planner(provider).plan(OBJECTIVE, policy);

    const system = systemText(provider.requests[0]);
    for (const agent of KNOWN_AGENTS) expect(system).toContain(agent);
    expect(system).toContain("auth");
    expect(system).toContain("payments");
    expect(system).toContain(EMIT_PLAN_TOOL_NAME);
    // parallelizeIndependentTasks defaults to true.
    expect(system).toContain("concurrently");
  });

  it("passes maxOutputTokens through and omits it when unset", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    await new LlmPlanner({
      provider,
      model: fakeModel,
      knownAgents: [...KNOWN_AGENTS],
      maxOutputTokens: 4096,
    }).plan(OBJECTIVE, policy);
    expect(provider.requests[0]?.maxOutputTokens).toBe(4096);

    const bare = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    await planner(bare).plan(OBJECTIVE, policy);
    expect(bare.requests[0]).not.toHaveProperty("maxOutputTokens");
  });

  it("re-asks with the zod issues when the payload does not match the schema", async () => {
    const broken = {
      objective: OBJECTIVE,
      tasks: [
        {
          id: "task-one",
          title: "Do it",
          goal: "Do the thing",
          type: "implementation",
          complexity: "normal",
          risk: { level: "high" },
        },
      ],
    };
    const provider = new FakeProvider([
      toolTurn(broken, "call_a"),
      toolTurn(VALID_PLAN_INPUT, "call_b"),
    ]);

    const plan = await planner(provider).plan(OBJECTIVE, policy);
    expect(plan.tasks).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);

    const retry = provider.requests[1]?.messages ?? [];
    const assistant = retry.find((message) => message.role === "assistant");
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: "call_a",
      name: EMIT_PLAN_TOOL_NAME,
    });
    const toolResult = retry.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ toolCallId: "call_a", isError: true });
    expect(toolResult?.content).toContain("tasks.0.id");
  });

  it("re-asks when a dependency points at a task that does not exist", async () => {
    const dangling = {
      objective: OBJECTIVE,
      tasks: [
        {
          id: "T01",
          title: "Do it",
          goal: "Do the thing",
          type: "implementation",
          complexity: "normal",
          dependencies: ["T07"],
          risk: { level: "low", categories: [] },
        },
      ],
    };
    const provider = new FakeProvider([
      toolTurn(dangling),
      toolTurn(VALID_PLAN_INPUT),
    ]);

    await planner(provider).plan(OBJECTIVE, policy);
    expect(allText(provider.requests[1])).toContain('unknown task "T07"');
  });

  it("re-asks when the plan is cyclic", async () => {
    const cyclic = {
      objective: OBJECTIVE,
      tasks: [
        {
          id: "T01",
          title: "A",
          goal: "A",
          type: "implementation",
          complexity: "normal",
          dependencies: ["T02"],
          risk: { level: "low", categories: [] },
        },
        {
          id: "T02",
          title: "B",
          goal: "B",
          type: "implementation",
          complexity: "normal",
          dependencies: ["T01"],
          risk: { level: "low", categories: [] },
        },
      ],
    };
    const provider = new FakeProvider([
      toolTurn(cyclic),
      toolTurn(VALID_PLAN_INPUT),
    ]);

    await planner(provider).plan(OBJECTIVE, policy);
    expect(allText(provider.requests[1])).toContain("cycle");
  });

  it("re-asks when a task suggests an agent that does not exist", async () => {
    const ghost = {
      ...VALID_PLAN_INPUT,
      tasks: [
        { ...VALID_PLAN_INPUT.tasks[0] },
        { ...VALID_PLAN_INPUT.tasks[1], suggestedAgent: "ghost-agent" },
      ],
    };
    const provider = new FakeProvider([
      toolTurn(ghost),
      toolTurn(VALID_PLAN_INPUT),
    ]);

    const plan = await planner(provider).plan(OBJECTIVE, policy);
    expect(plan.tasks[1]?.suggestedAgent).toBe("implementer");

    const feedback = allText(provider.requests[1]);
    expect(feedback).toContain("ghost-agent");
    expect(feedback).toContain("implementer");
  });

  it("re-asks when the model answers with prose instead of a tool call", async () => {
    const provider = new FakeProvider([
      textTurn("Here is my plan in bullet points."),
      toolTurn(VALID_PLAN_INPUT),
    ]);

    await planner(provider).plan(OBJECTIVE, policy);
    const retry = provider.requests[1]?.messages ?? [];
    expect(retry.at(-2)?.content).toContain("bullet points");
    expect(retry.at(-1)?.content).toContain("did not call");
  });

  it("throws PlanError once the attempts are exhausted", async () => {
    const broken = { objective: OBJECTIVE, tasks: [] };
    const provider = new FakeProvider([
      toolTurn(broken),
      toolTurn(broken),
      toolTurn(broken),
    ]);

    const error = await planner(provider)
      .plan(OBJECTIVE, policy)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PlanError);
    expect(provider.requests).toHaveLength(3);
    const planError = error as PlanError;
    expect(planError.attempts).toBe(3);
    expect(planError.lastIssues?.[0]?.path).toBe("tasks");
    expect(planError.message).toContain("3 attempt(s)");
  });

  it("honours a custom maxAttempts", async () => {
    const provider = new FakeProvider([toolTurn({ tasks: [] })]);
    await expect(planner(provider, 1).plan(OBJECTIVE, policy)).rejects.toThrow(
      PlanError,
    );
    expect(provider.requests).toHaveLength(1);
  });

  it("passes the caller's abort signal through to the provider", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    const controller = new AbortController();
    await planner(provider).plan(OBJECTIVE, policy, controller.signal);
    expect(provider.signals[0]).toBe(controller.signal);
  });

  it("rejects without calling the provider when the signal is already aborted", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));

    await expect(
      planner(provider).plan(OBJECTIVE, policy, controller.signal),
    ).rejects.toThrow("user cancelled");
    expect(provider.requests).toHaveLength(0);
  });

  it("propagates an abort raised mid-stream instead of retrying", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider(
      [toolTurn(VALID_PLAN_INPUT), toolTurn(VALID_PLAN_INPUT)],
      () => controller.abort(new Error("aborted mid-stream")),
    );

    await expect(
      planner(provider).plan(OBJECTIVE, policy, controller.signal),
    ).rejects.toThrow("aborted mid-stream");
    expect(provider.requests).toHaveLength(1);
  });

  it("describes a serial policy differently in the prompt", async () => {
    const provider = new FakeProvider([toolTurn(VALID_PLAN_INPUT)]);
    await planner(provider).plan(
      OBJECTIVE,
      makePolicy({ parallelizeIndependentTasks: false }),
      undefined,
    );
    expect(systemText(provider.requests[0])).toContain("one at a time");
  });
});
