import { UsageTracker } from "@agent/ai";
import { PlanError } from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelegatedPlanner } from "../../src/planning/delegated-planner.js";
import {
  cleanup,
  makeTempDir,
  writeFakeClaude,
} from "../backends/test-helpers.js";
import {
  claudeReply,
  codexReply,
  fakeBackendFactory,
  json,
  writeScriptedCli,
} from "./delegated-cli-harness.js";

const POLICY: OrchestrationPolicy = {
  version: 1,
  orchestrator: "lead",
  maxConcurrency: 2,
  parallelizeIndependentTasks: true,
  routing: [],
  review: [],
  escalation: [],
  defaultMaxAttempts: 1,
};

const KNOWN_AGENTS = ["lead", "coder"] as const;

/** The stand-in identity a delegated step attributes its spend to. */
const DELEGATED_MODEL = {
  provider: "openai",
  id: "gpt-5-codex",
  capabilities: {
    tools: false,
    reasoning: false,
    vision: false,
    structuredOutput: false,
  },
} as const;

const VALID_PLAN = {
  objective: "add a health endpoint",
  tasks: [
    {
      id: "T01",
      title: "Add the endpoint",
      goal: "Add GET /health returning 200 with a JSON body.",
      type: "implementation",
      complexity: "normal",
      dependencies: [],
      suggestedAgent: "coder",
      affectedAreas: ["src/server.ts"],
      risk: { level: "low", categories: [] },
    },
  ],
};

/** Same plan, but pointed at an agent this project has never heard of. */
const UNKNOWN_AGENT_PLAN = {
  ...VALID_PLAN,
  tasks: [{ ...VALID_PLAN.tasks[0], suggestedAgent: "ghost" }],
};

describe("DelegatedPlanner", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("delegated-planner-");
    workspace = await makeTempDir("delegated-planner-ws-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("plans through Claude Code in plan mode, without a model when none was given", async () => {
    const cli = await writeScriptedCli(dir, "claude-code", [
      claudeReply(json(VALID_PLAN)),
    ]);
    const planner = new DelegatedPlanner({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const plan = await planner.plan("add a health endpoint", POLICY);

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.suggestedAgent).toBe("coder");

    const argv = await cli.argv(1);
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--model");

    // The brief and the output contract both reach the CLI.
    const prompt = await cli.prompt(1);
    expect(prompt).toContain(
      "You are the planner for a multi-agent coding runtime",
    );
    expect(prompt).toContain("single JSON object");
    expect(prompt).toContain("add a health endpoint");
  });

  it("plans through Codex read-only and forwards the model", async () => {
    const cli = await writeScriptedCli(dir, "codex", [
      codexReply(json(VALID_PLAN)),
    ]);
    const planner = new DelegatedPlanner({
      backend: "codex",
      workspacePath: workspace,
      model: "gpt-5-codex",
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const plan = await planner.plan("add a health endpoint", POLICY);

    expect(plan.objective).toBe("add a health endpoint");
    const argv = await cli.argv(1);
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv).not.toContain("--full-auto");
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5-codex");
  });

  it("accepts a fenced reply", async () => {
    const cli = await writeScriptedCli(dir, "claude-code", [
      claudeReply(`\`\`\`json\n${json(VALID_PLAN)}\n\`\`\``),
    ]);
    const planner = new DelegatedPlanner({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    await expect(
      planner.plan("add a health endpoint", POLICY),
    ).resolves.toMatchObject({ objective: "add a health endpoint" });
  });

  it("accepts a reply wrapped in prose", async () => {
    const cli = await writeScriptedCli(dir, "codex", [
      codexReply(`Sure — here is the plan:\n${json(VALID_PLAN)}\nLet me know.`),
    ]);
    const planner = new DelegatedPlanner({
      backend: "codex",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    await expect(
      planner.plan("add a health endpoint", POLICY),
    ).resolves.toMatchObject({ objective: "add a health endpoint" });
  });

  it("retries with the validation issues and accepts the correction", async () => {
    const cli = await writeScriptedCli(dir, "claude-code", [
      claudeReply(json(UNKNOWN_AGENT_PLAN)),
      claudeReply(json(VALID_PLAN)),
    ]);
    const planner = new DelegatedPlanner({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const plan = await planner.plan("add a health endpoint", POLICY);
    expect(plan.tasks[0]?.suggestedAgent).toBe("coder");

    const second = await cli.prompt(2);
    expect(second).toContain("Your previous reply was not a usable plan");
    expect(second).toContain('Unknown agent "ghost"');
    // The rejected reply is quoted back so the model can see what it sent.
    expect(second).toContain("ghost");
  });

  it("throws PlanError with the attempts and last issues once exhausted", async () => {
    const cli = await writeScriptedCli(dir, "codex", [
      codexReply("I would rather write you a poem."),
    ]);
    const planner = new DelegatedPlanner({
      backend: "codex",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      maxAttempts: 2,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const error = await planner
      .plan("add a health endpoint", POLICY)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PlanError);
    const planError = error as PlanError;
    expect(planError.attempts).toBe(2);
    expect(planError.lastIssues?.[0]?.message).toContain("no JSON object");
    // Exactly `maxAttempts` CLI invocations, no more.
    await expect(cli.argv(2)).resolves.toBeDefined();
    await expect(cli.argv(3)).rejects.toThrow();
  });

  it("counts a failed CLI run as an attempt and reports its summary", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stderr: "the model refused the request\n",
      exitCode: 3,
    });

    const planner = new DelegatedPlanner({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      maxAttempts: 1,
      createBackend: fakeBackendFactory(binaryPath),
    });

    const error = await planner
      .plan("add a health endpoint", POLICY)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).lastIssues?.[0]?.message).toContain(
      "exited with code 3",
    );
  });

  it("records what the CLI reported spending, and nothing when it reported none", async () => {
    const spent = new UsageTracker();
    const silent = new UsageTracker();
    const reply = json(VALID_PLAN);
    const withUsage = await writeScriptedCli(dir, "codex", [
      `${json({
        type: "turn.completed",
        usage: { input_tokens: 4_000, output_tokens: 500 },
      })}\n${codexReply(reply)}`,
    ]);
    const quietDir = await makeTempDir("delegated-planner-quiet-");
    const withoutUsage = await writeScriptedCli(quietDir, "codex", [
      codexReply(reply),
    ]);

    const plannerFor = (
      cliPath: string,
      usage: UsageTracker,
    ): DelegatedPlanner =>
      new DelegatedPlanner({
        backend: "codex",
        workspacePath: workspace,
        knownAgents: KNOWN_AGENTS,
        createBackend: fakeBackendFactory(cliPath),
        usage: {
          recorder: usage,
          model: DELEGATED_MODEL,
          tags: { agent: "planner" },
        },
      });

    await plannerFor(withUsage.binaryPath, spent).plan(
      "add an endpoint",
      POLICY,
    );
    await plannerFor(withoutUsage.binaryPath, silent).plan(
      "add an endpoint",
      POLICY,
    );

    expect(spent.totals().usage).toEqual({
      inputTokens: 4_000,
      outputTokens: 500,
    });
    expect([...spent.breakdownBy("agent").keys()]).toEqual(["planner"]);
    // A CLI that reported nothing leaves no sample at all — "no usage" must
    // stay distinguishable from "zero tokens".
    expect([...silent.breakdownBy("agent").values()]).toEqual([]);

    await cleanup(quietDir);
  });
});
