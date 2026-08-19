import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlanError } from "@agent/orchestration";
import type { OrchestrationPolicy } from "@agent/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import { CodexBackend } from "../../src/backends/codex.js";
import type { DelegatedBackendFactory } from "../../src/planning/delegated-planner.js";
import {
  DelegatedPlanner,
  extractJsonObject,
} from "../../src/planning/delegated-planner.js";
import {
  cleanup,
  makeTempDir,
  writeFakeClaude,
  writeFakeCodex,
} from "../backends/test-helpers.js";

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

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** The stdout a fake `claude` prints to deliver `reply` as its final text. */
function claudeReply(reply: string): string {
  return `${json({ type: "result", subtype: "success", result: reply })}\n`;
}

/** The stdout a fake `codex` prints to deliver `reply` as its last message. */
function codexReply(reply: string): string {
  return `${json({
    type: "item.completed",
    item: { type: "agent_message", text: reply },
  })}\n`;
}

interface FakeCli {
  readonly binaryPath: string;
  /** Argv of the nth (1-based) invocation, NUL-separated on disk. */
  argv(attempt: number): Promise<string[]>;
  /** The prompt of the nth invocation: always the trailing argument. */
  prompt(attempt: number): Promise<string>;
}

/**
 * Writes a fake CLI that answers with `replies[n - 1]` on its nth invocation
 * (repeating the last one once exhausted) and dumps each invocation's argv.
 */
async function writeScriptedCli(
  dir: string,
  backend: "codex" | "claude-code",
  replies: readonly string[],
): Promise<FakeCli> {
  const counter = join(dir, "count");
  const replyPaths: string[] = [];
  for (const [index, reply] of replies.entries()) {
    const replyPath = join(dir, `reply.${String(index + 1)}`);
    await writeFile(replyPath, reply, "utf8");
    replyPaths.push(replyPath);
  }

  const branches = replyPaths.map(
    (replyPath, index) =>
      `if [ "$n" -le ${String(index + 1)} ]; then cat ${replyPath}; exit 0; fi`,
  );
  const body = [
    `n=$(cat ${counter} 2>/dev/null || echo 0)`,
    "n=$((n+1))",
    `echo $n > ${counter}`,
    `printf '%s\\0' "$@" > ${join(dir, "argv.")}$n`,
    ...branches,
    `cat ${replyPaths.at(-1) ?? "/dev/null"}`,
    "exit 0",
  ].join("\n");

  const write = backend === "codex" ? writeFakeCodex : writeFakeClaude;
  const binaryPath = await write(
    dir,
    { body },
    backend === "codex" ? "codex" : "claude",
  );

  const argv = async (attempt: number): Promise<string[]> => {
    const raw = await readFile(join(dir, `argv.${String(attempt)}`), "utf8");
    return raw.split("\0").slice(0, -1);
  };
  return {
    binaryPath,
    argv,
    prompt: async (attempt) => (await argv(attempt)).at(-1) ?? "",
  };
}

/**
 * The planner's own backend options, plus the fake binary. Everything the
 * assertions care about — sandboxing, `--model` — is still chosen by the
 * planner, not by this factory.
 */
function fakeBackendFactory(binaryPath: string): DelegatedBackendFactory {
  return (spec) =>
    spec.backend === "codex"
      ? new CodexBackend({ ...spec.options, binaryPath })
      : new ClaudeCodeBackend({ ...spec.options, binaryPath });
}

describe("extractJsonObject", () => {
  it("returns a bare object unchanged", () => {
    expect(extractJsonObject(' {"a":1} ')).toBe('{"a":1}');
  });

  it("unwraps a fenced block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips prose around the object", () => {
    expect(
      extractJsonObject('Here is the plan:\n{"a":1}\nHope that helps!'),
    ).toBe('{"a":1}');
  });

  it("keeps nested braces intact", () => {
    expect(extractJsonObject('x {"a":{"b":2}} y')).toBe('{"a":{"b":2}}');
  });

  it("returns undefined when there is no object at all", () => {
    expect(extractJsonObject("")).toBeUndefined();
    expect(extractJsonObject("I cannot plan this.")).toBeUndefined();
    expect(extractJsonObject("}{")).toBeUndefined();
  });
});

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
});
