import { PolicyCompileError } from "@agent/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelegatedPolicyCompiler } from "../../src/planning/delegated-policy-compiler.js";
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

const KNOWN_AGENTS = ["lead", "coder", "reviewer"] as const;

const MARKDOWN = `# Orchestration

The lead plans. Route everything to coder. Reviewer must review auth work.
`;

/** A draft in `emit_policy` shape: the policy plus its warnings/ambiguities. */
const VALID_OUTPUT = {
  policy: {
    version: 1,
    orchestrator: "lead",
    maxConcurrency: 3,
    routing: [
      {
        id: "route-coder",
        agent: "coder",
        strength: "hard",
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
  },
  warnings: ["assumed a blocking review for auth"],
  ambiguities: ['"as needed" review cadence was not mapped'],
};

/**
 * Same output with an orchestrator the draft schema rejects. Unknown *agent
 * names* are not the compiler's business — `validatePolicy` catches those in
 * the CLI, on both the native and the delegated path — so the retry loop is
 * exercised with a shape violation, which is what it actually guards.
 */
const INVALID_OUTPUT = {
  ...VALID_OUTPUT,
  policy: { ...VALID_OUTPUT.policy, orchestrator: 7 },
};

describe("DelegatedPolicyCompiler", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("delegated-policy-");
    workspace = await makeTempDir("delegated-policy-ws-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("compiles through Claude Code in plan mode, without a model when none was given", async () => {
    const cli = await writeScriptedCli(dir, "claude-code", [
      claudeReply(json(VALID_OUTPUT)),
    ]);
    const compiler = new DelegatedPolicyCompiler({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const result = await compiler.compile(MARKDOWN);

    expect(result.policy.orchestrator).toBe("lead");
    expect(result.policy.maxConcurrency).toBe(3);
    expect(result.policy.routing[0]?.agent).toBe("coder");
    // Defaults the model omitted are re-applied by `PolicySchema`.
    expect(result.policy.defaultMaxAttempts).toBe(2);
    expect(result.policy.escalation).toEqual([]);
    // Warnings and ambiguities survive the CLI boundary intact.
    expect(result.warnings).toEqual(["assumed a blocking review for auth"]);
    expect(result.ambiguities).toEqual([
      '"as needed" review cadence was not mapped',
    ]);

    const argv = await cli.argv(1);
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--model");

    // The brief, the output contract and the policy source all reach the CLI.
    const prompt = await cli.prompt(1);
    expect(prompt).toContain(
      "You are the policy compiler for a multi-agent coding runtime",
    );
    expect(prompt).toContain("single JSON object");
    expect(prompt).toContain("warnings and ambiguities");
    expect(prompt).toContain("Reviewer must review auth work.");
  });

  it("compiles through Codex read-only and forwards the model", async () => {
    const cli = await writeScriptedCli(dir, "codex", [
      codexReply(json(VALID_OUTPUT)),
    ]);
    const compiler = new DelegatedPolicyCompiler({
      backend: "codex",
      workspacePath: workspace,
      model: "gpt-5-codex",
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const result = await compiler.compile(MARKDOWN);

    expect(result.policy.review[0]?.reviewer).toBe("reviewer");
    const argv = await cli.argv(1);
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv).not.toContain("--full-auto");
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5-codex");
  });

  it("accepts a fenced reply", async () => {
    const cli = await writeScriptedCli(dir, "claude-code", [
      claudeReply(`\`\`\`json\n${json(VALID_OUTPUT)}\n\`\`\``),
    ]);
    const compiler = new DelegatedPolicyCompiler({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    await expect(compiler.compile(MARKDOWN)).resolves.toMatchObject({
      policy: { orchestrator: "lead" },
    });
  });

  it("accepts a reply wrapped in prose", async () => {
    const cli = await writeScriptedCli(dir, "codex", [
      codexReply(
        `Sure — here is the compiled policy:\n${json(VALID_OUTPUT)}\nLet me know.`,
      ),
    ]);
    const compiler = new DelegatedPolicyCompiler({
      backend: "codex",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    await expect(compiler.compile(MARKDOWN)).resolves.toMatchObject({
      policy: { orchestrator: "lead" },
    });
  });

  it("retries with the validation issues and accepts the correction", async () => {
    const cli = await writeScriptedCli(dir, "claude-code", [
      claudeReply(json(INVALID_OUTPUT)),
      claudeReply(json(VALID_OUTPUT)),
    ]);
    const compiler = new DelegatedPolicyCompiler({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const result = await compiler.compile(MARKDOWN);
    expect(result.policy.orchestrator).toBe("lead");

    const second = await cli.prompt(2);
    expect(second).toContain("Your previous reply was not a usable policy");
    expect(second).toContain("policy.orchestrator");
    // The rejected reply is quoted back so the model can see what it sent.
    expect(second).toContain('"orchestrator":7');
  });

  it("throws PolicyCompileError with the attempts and last issues once exhausted", async () => {
    const cli = await writeScriptedCli(dir, "codex", [
      codexReply("I would rather write you a poem."),
    ]);
    const compiler = new DelegatedPolicyCompiler({
      backend: "codex",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      maxAttempts: 2,
      createBackend: fakeBackendFactory(cli.binaryPath),
    });

    const error = await compiler
      .compile(MARKDOWN)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyCompileError);
    const compileError = error as PolicyCompileError;
    expect(compileError.message).toContain("after 2 attempt(s)");
    expect(compileError.attempts).toBe(2);
    expect(compileError.lastIssues?.[0]?.message).toContain("no JSON object");
    // Exactly `maxAttempts` CLI invocations, no more.
    await expect(cli.argv(2)).resolves.toBeDefined();
    await expect(cli.argv(3)).rejects.toThrow();
  });

  it("counts a failed CLI run as an attempt and reports its summary", async () => {
    const binaryPath = await writeFakeClaude(dir, {
      stderr: "the model refused the request\n",
      exitCode: 3,
    });

    const compiler = new DelegatedPolicyCompiler({
      backend: "claude-code",
      workspacePath: workspace,
      knownAgents: KNOWN_AGENTS,
      maxAttempts: 1,
      createBackend: fakeBackendFactory(binaryPath),
    });

    const error = await compiler
      .compile(MARKDOWN)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PolicyCompileError);
    expect((error as PolicyCompileError).lastIssues?.[0]?.message).toContain(
      "exited with code 3",
    );
  });
});
