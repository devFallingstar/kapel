import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  OrchestrationPolicy,
  PolicyCompileResult,
  PolicyCompiler,
} from "@agent/coding-agent";
import { parseLockfile } from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompilerFactory, PolicyOutput } from "../src/policy.js";
import {
  runPolicyCheck,
  runPolicyCompile,
  runPolicyExplain,
} from "../src/policy.js";

const SCRATCHPAD =
  "/tmp/claude-0/-home-user-multi-model-orchestration-agent/475a4108-ea0d-56a1-9770-14d838a0e5f8/scratchpad";

const TEMPLATE_AGENT_DIR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "templates",
  "default",
  ".agent",
);

const LOCK_FILE_NAME = "orchestration.lock.json";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(SCRATCHPAD, "cli-policy-test-"));
}

async function cleanupWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

/** Copies the repo's `templates/default/.agent` fixture into `<workspacePath>/.agent`. */
async function copyTemplateAgentDir(workspacePath: string): Promise<void> {
  await cp(TEMPLATE_AGENT_DIR, path.join(workspacePath, ".agent"), {
    recursive: true,
  });
}

/** A valid policy referencing only agents the template ships (lead/coder/explorer/reviewer). */
const VALID_POLICY: OrchestrationPolicy = {
  version: 1,
  orchestrator: "lead",
  maxConcurrency: 4,
  parallelizeIndependentTasks: true,
  routing: [
    {
      id: "route-coder",
      taskTypes: [],
      riskCategories: [],
      complexity: [],
      agent: "coder",
      strength: "hard",
      weight: 1,
    },
  ],
  review: [
    {
      id: "review-sensitive",
      riskCategories: ["auth"],
      reviewer: "reviewer",
      blocking: true,
      strength: "hard",
    },
  ],
  escalation: [
    {
      id: "esc-retry",
      fromAgent: "coder",
      toAgent: "lead",
      afterFailures: 2,
    },
  ],
  defaultMaxAttempts: 2,
};

/** A policy that references an agent the template does not define. */
const INVALID_POLICY: OrchestrationPolicy = {
  ...VALID_POLICY,
  routing: [
    {
      id: "route-ghost",
      taskTypes: [],
      riskCategories: [],
      complexity: [],
      agent: "nobody",
      strength: "hard",
      weight: 1,
    },
  ],
};

function fixedCompilerFactory(result: PolicyCompileResult): CompilerFactory {
  return (): PolicyCompiler => ({
    compile: async () => result,
  });
}

function capture(): {
  output: PolicyOutput;
  lines: string[];
  errLines: string[];
} {
  const lines: string[] = [];
  const errLines: string[] = [];
  return {
    output: {
      log: (line) => lines.push(line),
      error: (line) => errLines.push(line),
    },
    lines,
    errLines,
  };
}

describe("agent policy", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    // The native model/provider resolution step runs before the injected
    // compiler factory does; a fake key is enough to satisfy it since the
    // fake compiler never actually calls the provider.
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace();
    await copyTemplateAgentDir(workspace);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  describe("compile", () => {
    it("writes a fresh, parseable lock and reports warnings/ambiguities on success", async () => {
      const { output, lines } = capture();
      const compilerFactory = fixedCompilerFactory({
        policy: VALID_POLICY,
        warnings: ["assumed default retry policy"],
        ambiguities: ['"as needed" review cadence was not mapped'],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false },
        { output, compilerFactory },
      );

      expect(code).toBe(0);

      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      const lockContent = await readFile(lockPath, "utf8");
      const lock = parseLockfile(lockContent);
      expect(lock.policy.orchestrator).toBe("lead");
      expect(lock.warnings).toEqual(["assumed default retry policy"]);
      expect(lock.ambiguities).toEqual([
        '"as needed" review cadence was not mapped',
      ]);

      const text = lines.join("\n");
      expect(text).toContain(lockPath);
      expect(text).toContain("Warnings:");
      expect(text).toContain("assumed default retry policy");
      expect(text).toContain("Ambiguities:");
      expect(text).toContain('"as needed" review cadence was not mapped');
    });

    it("emits one JSON object on success in --json mode", async () => {
      const { output, lines } = capture();
      const compilerFactory = fixedCompilerFactory({
        policy: VALID_POLICY,
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: true },
        { output, compilerFactory },
      );

      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.ok).toBe(true);
      expect(parsed.policy.orchestrator).toBe("lead");
      expect(parsed.warnings).toEqual([]);
      expect(parsed.ambiguities).toEqual([]);
      expect(typeof parsed.lockPath).toBe("string");
    });

    it("rejects a policy that references an unknown agent, without writing a lock", async () => {
      const { output, errLines } = capture();
      const compilerFactory = fixedCompilerFactory({
        policy: INVALID_POLICY,
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false },
        { output, compilerFactory },
      );

      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("nobody");

      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    });

    it("fails with a friendly message when no .agent directory exists", async () => {
      const bare = await mkdtemp(path.join(SCRATCHPAD, "cli-policy-bare-"));
      try {
        const { output, errLines } = capture();
        const code = await runPolicyCompile(
          { cwd: bare, json: false },
          { output },
        );
        expect(code).toBe(1);
        expect(errLines.join("\n")).toContain("agent init");
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    });
  });

  describe("check", () => {
    async function compileFixture(workspacePath: string): Promise<void> {
      const { output } = capture();
      const code = await runPolicyCompile(
        { cwd: workspacePath, json: false },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: VALID_POLICY,
            warnings: [],
            ambiguities: [],
          }),
        },
      );
      expect(code).toBe(0);
    }

    it("reports missing when no lock has been compiled yet", async () => {
      const { output, errLines } = capture();
      const code = await runPolicyCheck(
        { cwd: workspace, json: false },
        { output },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("agent policy compile");
    });

    it("reports fresh right after a successful compile", async () => {
      await compileFixture(workspace);

      const { output, lines } = capture();
      const code = await runPolicyCheck(
        { cwd: workspace, json: false },
        { output },
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("policy lock is up to date");
    });

    it("reports stale-source once orchestration.md changes after compile", async () => {
      await compileFixture(workspace);

      const orchestrationPath = path.join(
        workspace,
        ".agent",
        "orchestration.md",
      );
      const original = await readFile(orchestrationPath, "utf8");
      await writeFile(
        orchestrationPath,
        `${original}\n\nNever touch the database directly.\n`,
        "utf8",
      );

      const { output, errLines } = capture();
      const code = await runPolicyCheck(
        { cwd: workspace, json: false },
        { output },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("orchestration.md has changed");
    });

    it("reports fresh/stale via --json", async () => {
      await compileFixture(workspace);

      const { output, lines } = capture();
      const code = await runPolicyCheck(
        { cwd: workspace, json: true },
        { output },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.fresh).toBe(true);
    });
  });

  describe("explain", () => {
    async function compileFixture(workspacePath: string): Promise<void> {
      const { output } = capture();
      const code = await runPolicyCompile(
        { cwd: workspacePath, json: false },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: VALID_POLICY,
            warnings: ["a warning"],
            ambiguities: ["an ambiguity"],
          }),
        },
      );
      expect(code).toBe(0);
    }

    it("fails with a suggestion to compile when no lock exists", async () => {
      const { output, errLines } = capture();
      const code = await runPolicyExplain(
        { cwd: workspace, json: false },
        { output },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("agent policy compile");
    });

    it("prints describePolicy output plus warnings/ambiguities from the lock", async () => {
      await compileFixture(workspace);

      const { output, lines } = capture();
      const code = await runPolicyExplain(
        { cwd: workspace, json: false },
        { output },
      );
      expect(code).toBe(0);

      const text = lines.join("\n");
      expect(text).toContain("Orchestrator: lead");
      expect(text).toContain("Routing rules (1):");
      expect(text).toContain("route-coder");
      expect(text).toContain("Warnings:");
      expect(text).toContain("a warning");
      expect(text).toContain("Ambiguities:");
      expect(text).toContain("an ambiguity");
    });

    it("fails with a friendly message when no .agent directory exists", async () => {
      const bare = await mkdtemp(path.join(SCRATCHPAD, "cli-policy-bare-"));
      try {
        const { output, errLines } = capture();
        const code = await runPolicyExplain(
          { cwd: bare, json: false },
          { output },
        );
        expect(code).toBe(1);
        expect(errLines.join("\n")).toContain("agent init");
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    });
  });
});
