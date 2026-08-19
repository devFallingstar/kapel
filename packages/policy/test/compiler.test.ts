import type { ModelMessage, ModelRequest } from "@agent/ai";
import { describe, expect, it } from "vitest";
import {
  EMIT_POLICY_TOOL_NAME,
  emitPolicyTool,
  LlmPolicyCompiler,
  PolicyCompileError,
  PolicySchema,
} from "../src/index.js";
import {
  FakeProvider,
  fakeModel,
  KNOWN_AGENTS,
  SAMPLE_MARKDOWN,
  textTurn,
  toolTurn,
  VALID_INPUT,
} from "./fake-provider.js";

function compiler(
  provider: FakeProvider,
  maxAttempts?: number,
): LlmPolicyCompiler {
  return new LlmPolicyCompiler({
    provider,
    model: fakeModel,
    knownAgents: [...KNOWN_AGENTS],
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

function allText(request: ModelRequest | undefined): string {
  if (request === undefined) throw new Error("no request recorded");
  return request.messages
    .map((message: ModelMessage) => message.content)
    .join("\n");
}

describe("emitPolicyTool", () => {
  it("exposes a $schema-free JSON schema whose policy fields mirror PolicySchema", () => {
    const schema = emitPolicyTool.inputSchema as Record<string, unknown>;
    expect(emitPolicyTool.name).toBe(EMIT_POLICY_TOOL_NAME);
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.required).toEqual(["policy", "warnings", "ambiguities"]);

    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const policy = properties.policy as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(Object.keys(policy.properties).sort()).toEqual(
      Object.keys(PolicySchema.shape).sort(),
    );
    // Only the fields with no default are demanded of the model.
    expect([...policy.required].sort()).toEqual(["orchestrator", "version"]);
  });
});

describe("LlmPolicyCompiler", () => {
  it("forces the emit_policy tool call and applies IR defaults to the result", async () => {
    const provider = new FakeProvider([toolTurn(VALID_INPUT)]);
    const result = await compiler(provider).compile(SAMPLE_MARKDOWN);

    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0];
    if (request === undefined) throw new Error("no request recorded");
    expect(request.model).toBe(fakeModel);
    expect(request.tools).toEqual([emitPolicyTool]);
    expect(request.toolChoice).toEqual({
      type: "tool",
      name: EMIT_POLICY_TOOL_NAME,
    });

    const system = request.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("architect, implementer, reviewer");
    expect(system?.content).toContain("maxConcurrency");
    expect(request.messages[1]?.content).toContain(
      "Anything touching auth requires a blocking review",
    );

    expect(result.policy).toEqual({
      version: 1,
      orchestrator: "architect",
      maxConcurrency: 3,
      // defaults filled in by PolicySchema, not by the model
      parallelizeIndependentTasks: true,
      defaultMaxAttempts: 2,
      routing: [
        {
          id: "route-refactors",
          taskTypes: ["refactor"],
          riskCategories: [],
          complexity: [],
          agent: "implementer",
          strength: "preference",
          weight: 1,
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
    });
    expect(result.warnings).toEqual([
      "Mapped 'three workers' to maxConcurrency 3.",
    ]);
    expect(result.ambiguities).toEqual([
      "'ship it when it feels right' — no measurable condition.",
    ]);
  });

  it("passes the caller's abort signal through to the provider", async () => {
    const provider = new FakeProvider([toolTurn(VALID_INPUT)]);
    const controller = new AbortController();
    await compiler(provider).compile(SAMPLE_MARKDOWN, controller.signal);
    expect(provider.signals[0]).toBe(controller.signal);
  });

  it("re-asks with the zod issues when the first output is invalid", async () => {
    const broken = {
      policy: {
        version: 1,
        // orchestrator missing
        routing: [
          {
            id: "route-refactors",
            agent: "implementer",
            strength: "mandatory", // not a RuleStrength
          },
        ],
      },
      warnings: [],
      ambiguities: [],
    };
    const provider = new FakeProvider([
      toolTurn(broken, "call_bad"),
      toolTurn(VALID_INPUT, "call_good"),
    ]);

    const result = await compiler(provider).compile(SAMPLE_MARKDOWN);
    expect(result.policy.orchestrator).toBe("architect");
    expect(provider.requests).toHaveLength(2);

    const retry = provider.requests[1];
    if (retry === undefined) throw new Error("no retry recorded");
    // The failed call is replayed as an assistant tool call...
    const assistant = retry.messages[2];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.toolCalls?.[0]?.name).toBe(EMIT_POLICY_TOOL_NAME);
    expect(assistant?.toolCalls?.[0]?.id).toBe("call_bad");
    // ...and answered with a tool result quoting the zod issues.
    const feedback = retry.messages[3];
    expect(feedback?.role).toBe("tool");
    expect(feedback?.toolCallId).toBe("call_bad");
    expect(feedback?.isError).toBe(true);
    expect(feedback?.content).toContain("policy.orchestrator");
    expect(feedback?.content).toContain("policy.routing.0.strength");
    expect(feedback?.content).toContain(EMIT_POLICY_TOOL_NAME);
  });

  it("throws PolicyCompileError once the attempts run out", async () => {
    const broken = { policy: { version: 1 }, warnings: [], ambiguities: [] };
    const provider = new FakeProvider([
      toolTurn(broken, "c1"),
      toolTurn(broken, "c2"),
    ]);

    const error = await compiler(provider, 2)
      .compile(SAMPLE_MARKDOWN)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(PolicyCompileError);
    const compileError = error as PolicyCompileError;
    expect(compileError.attempts).toBe(2);
    expect(compileError.lastIssues).toEqual([
      { path: "policy.orchestrator", message: expect.any(String) },
    ]);
    expect(compileError.message).toContain("after 2 attempt(s)");
    expect(provider.requests).toHaveLength(2);
  });

  it("retries, then fails, when the model answers with prose instead of a tool call", async () => {
    const provider = new FakeProvider([
      textTurn("I think the policy is mostly fine as prose."),
      textTurn("Still prose."),
    ]);

    const error = await compiler(provider, 2)
      .compile(SAMPLE_MARKDOWN)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(PolicyCompileError);
    expect((error as PolicyCompileError).lastIssues).toEqual([
      {
        path: "(root)",
        message: `no ${EMIT_POLICY_TOOL_NAME} tool call in the response`,
      },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(allText(provider.requests[1])).toContain(
      `You did not call ${EMIT_POLICY_TOOL_NAME}`,
    );
    expect(allText(provider.requests[1])).toContain("mostly fine as prose");
  });

  it("rejects without calling the provider when the signal is already aborted", async () => {
    const provider = new FakeProvider([toolTurn(VALID_INPUT)]);
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));

    await expect(
      compiler(provider).compile(SAMPLE_MARKDOWN, controller.signal),
    ).rejects.toThrow("user cancelled");
    expect(provider.requests).toHaveLength(0);
  });

  it("propagates an abort raised mid-stream instead of retrying", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider(
      [toolTurn(VALID_INPUT), toolTurn(VALID_INPUT)],
      () => controller.abort(new Error("aborted mid-stream")),
    );

    await expect(
      compiler(provider).compile(SAMPLE_MARKDOWN, controller.signal),
    ).rejects.toThrow("aborted mid-stream");
    expect(provider.requests).toHaveLength(1);
  });
});
