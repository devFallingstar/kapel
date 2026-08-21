import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  OrchestrationPolicy,
  PolicyCompileResult,
  PolicyCompiler,
} from "@agent/coding-agent";
import { parseLockfile } from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CompilerFactory,
  DelegatedCompilerFactory,
  PolicyOutput,
} from "../src/policy.js";
import {
  runPolicyCheck,
  runPolicyCompile,
  runPolicyDiff,
  runPolicyExplain,
} from "../src/policy.js";

// Session-provided scratch dir when set (keeps CI and local machines on
// the OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

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

/**
 * A policy written as prose — kapel's own wording before the canonical form
 * existed, kept here because prose is what {@link runPolicyCompile}'s model
 * path is *for*, and the shipped template no longer is any.
 *
 * Line 5 is load-bearing: the source-location tests quote a phrase from it.
 */
const PROSE_POLICY_SOURCE = `# Orchestration Policy

Use \`lead\` as the main orchestrator. The orchestrator should focus on planning, decomposition, architectural judgment, delegation, and final validation rather than routine implementation.

Use \`senior\` for complex or architectural implementation work. Use \`coder\` for normal implementation work. Use \`junior\` for trivial single-function changes. Use \`explorer\` for inexpensive read-only repository exploration. Use \`reviewer\` for independent review.

Authentication, authorization, payment, secrets, and database migration changes require a blocking independent review before completion.

Retry a failed worker once. If the second attempt fails, escalate the task one tier up (\`junior\` to \`coder\`, \`coder\` to \`senior\`).
`;

/**
 * Copies the repo's `templates/default/.agent` fixture into
 * `<workspacePath>/.agent`, then replaces its policy with prose.
 *
 * The replacement is what keeps these tests testing what they were written to
 * test: the shipped policy is canonical now, so a compile against it never
 * reaches a compiler at all and every injected `compilerFactory` here would
 * go unused. {@link copyCanonicalTemplateAgentDir} is the fixture for that
 * path.
 */
async function copyTemplateAgentDir(workspacePath: string): Promise<void> {
  await copyCanonicalTemplateAgentDir(workspacePath);
  await writeFile(
    path.join(workspacePath, ".agent", "orchestration.md"),
    PROSE_POLICY_SOURCE,
    "utf8",
  );
}

/** The template exactly as it ships — policy included, and therefore canonical. */
async function copyCanonicalTemplateAgentDir(
  workspacePath: string,
): Promise<void> {
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
  // "senior" (a worker-role agent) is deliberate: an orchestrator-role
  // target like "lead" now triggers the compile-time warning covered below,
  // and this fixture is reused by every "clean success" test in the file.
  escalation: [
    {
      id: "esc-retry",
      fromAgent: "coder",
      toAgent: "senior",
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

describe("kapel policy", () => {
  let workspace: string;
  const originalKeys = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };

  beforeEach(async () => {
    // The native model/provider resolution step runs before the injected
    // compiler factory does; a fake key is enough to satisfy it since the
    // fake compiler never actually calls the provider.
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace();
    await copyTemplateAgentDir(workspace);
  });

  afterEach(async () => {
    if (originalKeys.anthropic === undefined)
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKeys.anthropic;
    if (originalKeys.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKeys.openai;
    await cleanupWorkspace(workspace);
  });

  /** Records what the CLI asked the delegated compiler for. */
  function recordingDelegatedFactory(result: PolicyCompileResult): {
    factory: DelegatedCompilerFactory;
    calls: Parameters<DelegatedCompilerFactory>[0][];
  } {
    const calls: Parameters<DelegatedCompilerFactory>[0][] = [];
    return {
      calls,
      factory: (args) => {
        calls.push(args);
        return { compile: async () => result };
      },
    };
  }

  describe("compile — the canonical path", () => {
    /** Fails the test if anything reaches a model. */
    const forbiddenCompiler: CompilerFactory = () => ({
      compile: async () => {
        throw new Error("a canonical policy must not reach a compiler");
      },
    });

    beforeEach(async () => {
      await rm(path.join(workspace, ".agent"), {
        recursive: true,
        force: true,
      });
      await copyCanonicalTemplateAgentDir(workspace);
    });

    it("compiles the shipped policy without calling a model", async () => {
      const { output, lines, errLines } = capture();

      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        { output, compilerFactory: forbiddenCompiler },
      );

      expect(code).toBe(0);
      expect(errLines).toEqual([]);
      const text = lines.join("\n");
      expect(text).toContain("no model call");
      // Nothing was spent, so nothing claims to have been.
      expect(text).not.toContain("tokens —");

      const lock = parseLockfile(
        await readFile(path.join(workspace, ".agent", LOCK_FILE_NAME), "utf8"),
      );
      expect(lock.model).toBe("canonical");
      expect(lock.policy.orchestrator).toBe("lead");
      expect(lock.warnings).toEqual([]);
    });

    it("needs no provider credential at all", async () => {
      // The prose path resolves a model before it compiles; this one never
      // does, which is what lets a machine with no backend set itself up.
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const { output, lines } = capture();

      expect(
        await runPolicyCompile(
          { cwd: workspace, json: false, backend: "native" },
          { output },
        ),
      ).toBe(0);
      expect(lines.join("\n")).toContain("no model call");
    });

    it("reports the path it took in --json mode", async () => {
      const { output, lines } = capture();

      expect(
        await runPolicyCompile(
          { cwd: workspace, json: true, backend: "native" },
          { output, compilerFactory: forbiddenCompiler },
        ),
      ).toBe(0);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        ok: true,
        source: "canonical",
      });
    });

    it("diffs against the lock for free", async () => {
      const { output: first } = capture();
      await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        { output: first },
      );

      const { output, lines } = capture();
      expect(
        await runPolicyDiff(
          { cwd: workspace, json: false, backend: "native" },
          { output, compilerFactory: forbiddenCompiler },
        ),
      ).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("No changes from the locked policy.");
      expect(text).not.toContain("tokens —");
    });

    it("falls back to the model when a hand edit breaks the form, and says which line", async () => {
      const policyPath = path.join(workspace, ".agent", "orchestration.md");
      const source = await readFile(policyPath, "utf8");
      await writeFile(
        policyPath,
        source.replace(
          "- Run at most 4 agents at a time.",
          "- Run whenever you feel like it.",
        ),
        "utf8",
      );

      const { output, lines, errLines } = capture();
      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
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
      // The edit is reported rather than swallowed: it just cost a model call
      // the file existed to avoid.
      expect(errLines.join("\n")).toMatch(
        /no longer fits that form at line \d+/,
      );
      expect(lines.join("\n")).not.toContain("no model call");
    });

    it("treats a policy rewritten as prose as prose, with nothing to report", async () => {
      await writeFile(
        path.join(workspace, ".agent", "orchestration.md"),
        "Send everything to `coder`.\n",
        "utf8",
      );

      const { output, lines, errLines } = capture();
      expect(
        await runPolicyCompile(
          { cwd: workspace, json: false, backend: "native" },
          {
            output,
            compilerFactory: fixedCompilerFactory({
              policy: VALID_POLICY,
              warnings: [],
              ambiguities: [],
            }),
          },
        ),
      ).toBe(0);
      // Dropping the marker is how someone chooses prose — not a mistake, so
      // it is not reported as one.
      expect(errLines).toEqual([]);
      expect(lines.join("\n")).not.toContain("no model call");
    });
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
        { cwd: workspace, json: false, backend: "native" },
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
      // P1-1 (leftover): the compile call's own spend is attributed and
      // printed, same shape as `orchestrate`'s usage line. The fixed fake
      // compiler above never touches the provider it's handed, so the
      // figures are zero here — `usageRecordingProvider` wrapping the
      // provider that streams the tokens is already covered offline in
      // `packages/ai/test/usage.test.ts`; a compiler that actually drained a
      // real streamed provider here would have to reach the network to do
      // it, which these tests must not depend on.
      expect(text).toMatch(/tokens — input: 0, output: 0/);
    });

    it("annotates a warning/ambiguity with its orchestration.md line when the quoted phrase resolves", async () => {
      // templates/default/.agent/orchestration.md line 5 quotes verbatim here.
      const { output, lines } = capture();
      const compilerFactory = fixedCompilerFactory({
        policy: VALID_POLICY,
        warnings: [
          'assumed default cadence for "inexpensive read-only repository exploration"',
        ],
        ambiguities: ['"as needed" review cadence was not mapped'],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        { output, compilerFactory },
      );

      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("[orchestration.md:5]");
      // The ambiguity's quoted phrase is not present anywhere in the
      // template source, so it must carry no location — never a wrong one.
      const ambiguityLine = lines.find((line) =>
        line.includes('"as needed" review cadence was not mapped'),
      );
      expect(ambiguityLine).not.toContain("orchestration.md");
    });

    it("reports warningLocations/ambiguityLocations as a parallel array in --json mode", async () => {
      const { output, lines } = capture();
      const compilerFactory = fixedCompilerFactory({
        policy: VALID_POLICY,
        warnings: [
          'assumed default cadence for "inexpensive read-only repository exploration"',
        ],
        ambiguities: ['"as needed" review cadence was not mapped'],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: true, backend: "native" },
        { output, compilerFactory },
      );

      expect(code).toBe(0);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.warningLocations).toEqual([
        { file: "orchestration.md", line: 5 },
      ]);
      expect(parsed.ambiguityLocations).toEqual([null]);
    });

    it("emits one JSON object on success in --json mode", async () => {
      const { output, lines } = capture();
      const compilerFactory = fixedCompilerFactory({
        policy: VALID_POLICY,
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: true, backend: "native" },
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
        { cwd: workspace, json: false, backend: "native" },
        { output, compilerFactory },
      );

      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("nobody");

      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      await expect(readFile(lockPath, "utf8")).rejects.toThrow();
    });

    it("warns (but does not block) when an escalation rule targets an orchestrator-role agent", async () => {
      // The template's "lead" is role: orchestrator; escalating to it is
      // legal but stalls under a delegated backend (item 4).
      const policy: OrchestrationPolicy = {
        ...VALID_POLICY,
        escalation: [
          { id: "senior-to-lead", fromAgent: "senior", toAgent: "lead" },
        ],
      };
      const { output, lines } = capture();
      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain(
        'warning: escalation rule senior-to-lead targets "lead", an orchestrator-role agent — under codex/claude-code backends it runs without tool scoping',
      );
      // A warning, not a rejection: the lock is still written.
      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      await expect(readFile(lockPath, "utf8")).resolves.toBeDefined();
    });

    it("warns when a routing rule targets an orchestrator-role agent", async () => {
      const policy: OrchestrationPolicy = {
        ...VALID_POLICY,
        routing: [
          {
            id: "route-lead",
            taskTypes: [],
            riskCategories: [],
            complexity: [],
            agent: "lead",
            strength: "hard",
            weight: 1,
          },
        ],
      };
      const { output, lines } = capture();
      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        'warning: routing rule route-lead targets "lead", an orchestrator-role agent — under codex/claude-code backends it runs without tool scoping',
      );
    });

    it("does not warn about the designated orchestrator field itself, only routing/escalation targets", async () => {
      // VALID_POLICY.orchestrator is "lead" (role: orchestrator) but names no
      // orchestrator-role agent as a routing or escalation target.
      const { output, lines } = capture();
      const code = await runPolicyCompile(
        { cwd: workspace, json: true, backend: "native" },
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
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.warnings).toEqual([]);
    });

    it("does not warn about an escalation target that is not a known agent (validatePolicy already errors on it)", async () => {
      const policy: OrchestrationPolicy = {
        ...VALID_POLICY,
        escalation: [
          { id: "esc-ghost", fromAgent: "coder", toAgent: "nobody" },
        ],
      };
      const { output, errLines } = capture();
      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(1);
      expect(errLines.join("\n")).not.toContain("orchestrator-role");
    });

    it("fails with a friendly message when no .agent directory exists", async () => {
      const bare = await mkdtemp(path.join(SCRATCHPAD, "cli-policy-bare-"));
      try {
        const { output, errLines } = capture();
        const code = await runPolicyCompile(
          { cwd: bare, json: false, backend: "native" },
          { output },
        );
        expect(code).toBe(1);
        expect(errLines.join("\n")).toContain("kapel init");
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    });

    it("compiles with no credentials at all under a delegating backend", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const { output, lines } = capture();
      const { factory, calls } = recordingDelegatedFactory({
        policy: VALID_POLICY,
        warnings: ["assumed default retry policy"],
        ambiguities: ['"as needed" review cadence was not mapped'],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "claude-code" },
        {
          output,
          delegatedCompilerFactory: factory,
          compilerFactory: () => {
            throw new Error("the native compiler must not be built here");
          },
        },
      );

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.backend).toBe("claude-code");
      expect(calls[0]?.workspacePath).toBe(path.resolve(workspace));
      // Nothing named a model, so the CLI picks its own.
      expect(calls[0]?.model).toBeUndefined();
      expect(calls[0]?.knownAgents).toContain("coder");

      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      const lock = parseLockfile(await readFile(lockPath, "utf8"));
      expect(lock.policy.orchestrator).toBe("lead");
      // Warnings and ambiguities survive the delegated compile.
      expect(lock.warnings).toEqual(["assumed default retry policy"]);
      expect(lock.ambiguities).toEqual([
        '"as needed" review cadence was not mapped',
      ]);
      // The lockfile's model is informational, so the placeholder is honest.
      expect(lock.model).toBe("<claude-code default>");
      expect(lines.join("\n")).toContain(
        "Compiled policy using <claude-code default> (anthropic)",
      );
    });

    it("forwards -m to the delegating CLI verbatim and records it", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const { output, lines } = capture();
      const { factory, calls } = recordingDelegatedFactory({
        policy: VALID_POLICY,
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyCompile(
        {
          cwd: workspace,
          json: false,
          backend: "codex",
          model: "gpt-5-codex",
        },
        { output, delegatedCompilerFactory: factory },
      );

      expect(code).toBe(0);
      expect(calls[0]?.model).toBe("gpt-5-codex");
      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      const lock = parseLockfile(await readFile(lockPath, "utf8"));
      expect(lock.model).toBe("gpt-5-codex");
      expect(lines.join("\n")).toContain(
        "Compiled policy using gpt-5-codex (openai)",
      );
    });

    it("reports what the delegating CLI said it spent, and says so when it said nothing", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const { output, lines } = capture();
      const { factory, calls } = recordingDelegatedFactory({
        policy: VALID_POLICY,
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "codex" },
        { output, delegatedCompilerFactory: factory },
      );

      expect(code).toBe(0);
      // The compiler is handed the seam it reports usage through: the ledger,
      // the stand-in model identity, and the same `policy` attribution the
      // native path uses through `usageRecordingProvider`.
      expect(calls[0]?.usage?.recorder).toBeDefined();
      expect(calls[0]?.usage?.model.id).toBe("<codex default>");
      expect(calls[0]?.usage?.tags).toEqual({ agent: "policy" });
      // This fake never recorded anything, and a subscription CLI that
      // reports no tokens did not therefore spend none — so the line must not
      // read as `input: 0, output: 0`.
      expect(lines.join("\n")).toContain(
        "tokens — none reported by the codex CLI",
      );
    });

    it("prints the delegated compile's tokens when the CLI does report them", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const { output, lines } = capture();
      const factory: DelegatedCompilerFactory = (args) => ({
        compile: async () => {
          args.usage?.recorder.record(
            args.usage.model,
            { inputTokens: 1200, outputTokens: 340 },
            args.usage.tags,
          );
          return { policy: VALID_POLICY, warnings: [], ambiguities: [] };
        },
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "claude-code" },
        { output, delegatedCompilerFactory: factory },
      );

      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("tokens — input: 1200, output: 340");
      // The delegated model carries no pricing, so no cost is invented.
      expect(text).not.toContain("~$");
    });

    it("still uses the native compiler under --backend native", async () => {
      const { output } = capture();
      const { factory, calls } = recordingDelegatedFactory({
        policy: VALID_POLICY,
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyCompile(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          delegatedCompilerFactory: factory,
          compilerFactory: fixedCompilerFactory({
            policy: VALID_POLICY,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      const lock = parseLockfile(await readFile(lockPath, "utf8"));
      // The native path still records the resolved provider model.
      expect(lock.model).not.toContain("default>");
    });
  });

  describe("check", () => {
    async function compileFixture(workspacePath: string): Promise<void> {
      const { output } = capture();
      const code = await runPolicyCompile(
        { cwd: workspacePath, json: false, backend: "native" },
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
      expect(errLines.join("\n")).toContain("kapel policy compile");
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
        { cwd: workspacePath, json: false, backend: "native" },
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
      expect(errLines.join("\n")).toContain("kapel policy compile");
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
        expect(errLines.join("\n")).toContain("kapel init");
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    });
  });

  describe("diff", () => {
    async function compileFixture(
      workspacePath: string,
      policy: OrchestrationPolicy = VALID_POLICY,
    ): Promise<void> {
      const { output } = capture();
      const code = await runPolicyCompile(
        { cwd: workspacePath, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy,
            warnings: [],
            ambiguities: [],
          }),
        },
      );
      expect(code).toBe(0);
    }

    it("fails with compile-first guidance when no lock exists", async () => {
      const { output, errLines } = capture();
      const code = await runPolicyDiff(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: VALID_POLICY,
            warnings: [],
            ambiguities: [],
          }),
        },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("kapel policy compile");
    });

    it("recompiles through the delegating CLI, with no credentials at all", async () => {
      // `diff` makes the same compile call `compile` does, so it has to reach
      // the same backend: a delegated project must be able to preview a
      // policy change without an API key it does not have.
      await compileFixture(workspace);
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const { output, lines } = capture();
      const { factory, calls } = recordingDelegatedFactory({
        policy: { ...VALID_POLICY, maxConcurrency: 8 },
        warnings: [],
        ambiguities: [],
      });

      const code = await runPolicyDiff(
        { cwd: workspace, json: false, backend: "codex" },
        {
          output,
          delegatedCompilerFactory: factory,
          compilerFactory: () => {
            throw new Error("the native compiler must not be built here");
          },
        },
      );

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.backend).toBe("codex");
      const text = lines.join("\n");
      expect(text).toContain("Policy diff (locked -> recompiled):");
      expect(text).toContain("maxConcurrency:");
      expect(text).toContain("tokens — none reported by the codex CLI");
      // The lock is untouched by a diff, delegated or not.
      const lock = parseLockfile(
        await readFile(path.join(workspace, ".agent", LOCK_FILE_NAME), "utf8"),
      );
      expect(lock.policy.maxConcurrency).toBe(VALID_POLICY.maxConcurrency);
    });

    it("reports 'No changes.' when the recompiled policy matches the lock", async () => {
      await compileFixture(workspace);
      const { output, lines } = capture();

      const code = await runPolicyDiff(
        { cwd: workspace, json: false, backend: "native" },
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
      const text = lines.join("\n");
      expect(text).toContain("No changes from the locked policy.");
    });

    it("shows an added routing rule and a field-level change together", async () => {
      await compileFixture(workspace);

      const recompiled: OrchestrationPolicy = {
        ...VALID_POLICY,
        maxConcurrency: 8,
        routing: [
          {
            ...VALID_POLICY.routing[0],
            agent: "reviewer",
          } as OrchestrationPolicy["routing"][number],
          {
            id: "route-explorer",
            taskTypes: ["exploration"],
            riskCategories: [],
            complexity: [],
            agent: "explorer",
            strength: "preference",
            weight: 1,
          },
        ],
      };

      const { output, lines } = capture();
      const code = await runPolicyDiff(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: recompiled,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("Policy diff (locked -> recompiled):");
      expect(text).toContain("Defaults:");
      expect(text).toContain("maxConcurrency: 4 -> 8");
      expect(text).toContain("Routing rules:");
      expect(text).toContain("~ route-coder:");
      expect(text).toContain("agent: coder -> reviewer");
      expect(text).toContain("+ route-explorer:");
      expect(text).toContain("Run `kapel policy compile` to update the lock.");
    });

    it("warns about a recompiled policy's orchestrator-role targets, same as compile", async () => {
      await compileFixture(workspace);

      const recompiled: OrchestrationPolicy = {
        ...VALID_POLICY,
        escalation: [
          { id: "senior-to-lead", fromAgent: "senior", toAgent: "lead" },
        ],
      };

      const { output, lines } = capture();
      const code = await runPolicyDiff(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: recompiled,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(
        'warning: escalation rule senior-to-lead targets "lead", an orchestrator-role agent — under codex/claude-code backends it runs without tool scoping',
      );
    });

    it("emits {ok, unchanged, defaults, routing, review, escalation} in --json mode", async () => {
      await compileFixture(workspace);

      const recompiled: OrchestrationPolicy = {
        ...VALID_POLICY,
        review: [],
      };

      const { output, lines } = capture();
      const code = await runPolicyDiff(
        { cwd: workspace, json: true, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: recompiled,
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "{}");
      expect(parsed.ok).toBe(true);
      expect(parsed.unchanged).toBe(false);
      expect(parsed.routing).toEqual([]);
      expect(parsed.review).toHaveLength(1);
      expect(parsed.review[0].kind).toBe("removed");
      expect(parsed.review[0].id).toBe("review-sensitive");
    });

    it("does not write or otherwise modify the existing lock", async () => {
      await compileFixture(workspace);
      const lockPath = path.join(workspace, ".agent", LOCK_FILE_NAME);
      const before = await readFile(lockPath, "utf8");

      const { output } = capture();
      await runPolicyDiff(
        { cwd: workspace, json: false, backend: "native" },
        {
          output,
          compilerFactory: fixedCompilerFactory({
            policy: { ...VALID_POLICY, maxConcurrency: 9 },
            warnings: [],
            ambiguities: [],
          }),
        },
      );

      const after = await readFile(lockPath, "utf8");
      expect(after).toBe(before);
    });
  });
});
