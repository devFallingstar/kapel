import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageTracker } from "@agent/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DelegatedWorkerUsageSink } from "../../src/planning/delegated-cli.js";
import {
  CodexWorkerExecutor,
  codexToolScopingFor,
  createCodexToolsResolver,
} from "../../src/workers/codex-executor.js";
import { NO_VERDICT_SUMMARY } from "../../src/workers/review.js";
import { writeFakeCodex } from "../backends/test-helpers.js";
import {
  cleanup,
  initGitRepo,
  makeProject,
  makeProjectAgent,
  makeRuntimeTask,
  makeTaskResult,
  makeTempDir,
  RecordingSink,
} from "./test-helpers.js";

const AGENT_MESSAGE = "Added the retry loop to the uploader.";

/** Reads the NUL-separated argv dump written by the fake codex binary. */
async function readArgv(path: string): Promise<string[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\0").slice(0, -1);
}

/** The value following a flag in an argv array, or `undefined` if absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("codexToolScopingFor", () => {
  it("returns unscoped for an agent with no tools: restriction", () => {
    expect(codexToolScopingFor([])).toBe("unscoped");
  });

  it("returns unscoped when every builtin tool is granted anyway", () => {
    // The same vocabulary `makeProjectAgent`'s default `tools:` uses, which
    // resolves to all seven builtin tools — a restriction in name only.
    expect(
      codexToolScopingFor([
        "read",
        "grep",
        "glob",
        "edit",
        "write",
        "bash",
        "git.*",
      ]),
    ).toBe("unscoped");
  });

  it("maps a restriction that grants no mutating tool onto read-only", () => {
    expect(codexToolScopingFor(["read", "grep", "glob", "git.diff"])).toBe(
      "read-only",
    );
  });

  it("maps a restriction matching nothing at all onto read-only too", () => {
    // No builtin tool answers to `task.*` (the orchestrator's own pattern),
    // so the selected set is empty — no mutating tool in an empty set either,
    // and the safety property `read-only` guarantees (no writes) still holds.
    expect(codexToolScopingFor(["task.*"])).toBe("read-only");
  });

  it("calls a restriction that keeps some but not all mutating tools unsupported", () => {
    expect(codexToolScopingFor(["read", "bash"])).toBe("unsupported");
    expect(codexToolScopingFor(["write"])).toBe("unsupported");
    expect(codexToolScopingFor(["read", "grep", "edit"])).toBe("unsupported");
  });
});

describe("createCodexToolsResolver", () => {
  const project = makeProject([
    makeProjectAgent({ name: "coder" }),
    makeProjectAgent({
      name: "reviewer",
      tools: ["read", "grep", "glob", "git.diff"],
    }),
  ]);

  it("returns a project agent's raw tools patterns, untranslated", () => {
    const resolve = createCodexToolsResolver(project);
    expect(resolve("reviewer")).toEqual(["read", "grep", "glob", "git.diff"]);
  });

  it("returns undefined for an agent the project does not know", () => {
    const resolve = createCodexToolsResolver(project);
    expect(resolve("nobody")).toBeUndefined();
  });
});

describe("CodexWorkerExecutor", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("codex-worker-");
    workspace = await makeTempDir("codex-worker-ws-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("normalizes a successful codex run into a task result", async () => {
    const head = await initGitRepo(workspace);
    const binaryPath = await writeFakeCodex(dir, {
      body: [
        `printf '%s\\n' '${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: AGENT_MESSAGE },
        })}'`,
        'printf "export const retries = 3;\\n" > retry.ts',
        "exit 0",
      ].join("\n"),
    });
    const events = new RecordingSink();
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      events,
      backendOptions: { binaryPath },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("success");
    expect(result.summary).toBe(AGENT_MESSAGE);
    expect(result.taskId).toBe("task-1");
    expect(result.changedFiles).toEqual(["retry.ts"]);
    expect(result.commit).toBe(head);
    expect(result.confidence).toBe(0.8);
    expect(result.tests).toEqual({ passed: 0, failed: 0, commands: [] });

    expect(events.types()).toContain("codex.item.completed");
    expect(
      events.events.every(
        (event) => event.runId === "run-7" && event.taskId === "task-1",
      ),
    ).toBe(true);
  });

  it("passes the same task briefing codex-side", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath },
    });

    await executor.execute(makeRuntimeTask(), "coder");

    const argv = await readArgv(argvFile);
    const prompt = argv.at(-1) ?? "";
    expect(prompt).toContain("Add retry to the uploader");
    expect(prompt).toContain("Retry failed uploads three times with backoff.");
    expect(prompt).toContain("packages/uploader");
    expect(prompt).toContain('acting as the "coder" worker');
    expect(argv).toContain("--cd");
    expect(argv).toContain(workspace);
  });

  it("includes dependency results from the execution context in the prompt", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath },
    });

    await executor.execute(makeRuntimeTask(), "coder", undefined, {
      dependencyResults: [
        makeTaskResult({
          taskId: "T00",
          summary: "Added the /healthz route.",
          changedFiles: ["src/server.ts"],
        }),
      ],
    });

    const prompt = (await readArgv(argvFile)).at(-1) ?? "";
    expect(prompt).toContain("## Results from dependency tasks");
    expect(prompt).toContain("### T00 — success");
    expect(prompt).toContain("  - src/server.ts");
  });

  it("returns a failed result when codex exits non-zero", async () => {
    const binaryPath = await writeFakeCodex(dir, {
      stderr: "codex: something went wrong\n",
      exitCode: 3,
    });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("exited with code 3");
    expect(result.summary).toContain("something went wrong");
    expect(result.confidence).toBe(0.1);
  });

  it("returns a failed result when the codex binary is missing", async () => {
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath: join(dir, "definitely-not-here") },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Codex CLI not found");
    expect(result.changedFiles).toEqual([]);
  });

  it("applies the executor timeout to the codex process", async () => {
    const binaryPath = await writeFakeCodex(dir, { sleepSeconds: 30 });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      taskTimeoutMs: 300,
      backendOptions: { binaryPath, timeoutMs: 60_000 },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timed out after 300ms");
  }, 20_000);

  it("passes the resolveAgentModel result to codex as -m, overriding backendOptions.model", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath, model: "run-wide-default" },
      resolveAgentModel: (agent) =>
        agent === "coder" ? "gpt-5-codex" : undefined,
    });

    await executor.execute(makeRuntimeTask(), "coder");

    const argv = await readArgv(argvFile);
    const modelIndex = argv.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(argv[modelIndex + 1]).toBe("gpt-5-codex");
  });

  it("falls back to backendOptions.model when resolveAgentModel has no answer", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeCodex(dir, { argvFile });
    const executor = new CodexWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath, model: "run-wide-default" },
      resolveAgentModel: () => undefined,
    });

    await executor.execute(makeRuntimeTask(), "coder");

    const argv = await readArgv(argvFile);
    const modelIndex = argv.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(argv[modelIndex + 1]).toBe("run-wide-default");
  });

  describe("tool scoping", () => {
    it("maps a read-only-scoped agent onto --sandbox read-only", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeCodex(dir, { argvFile });
      const project = makeProject([
        makeProjectAgent({
          name: "reviewer",
          tools: ["read", "grep", "glob", "git.diff"],
        }),
      ]);
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        resolveAgentTools: createCodexToolsResolver(project),
      });

      await executor.execute(makeRuntimeTask(), "reviewer");

      const argv = await readArgv(argvFile);
      expect(flagValue(argv, "--sandbox")).toBe("read-only");
      expect(argv).not.toContain("--full-auto");
    });

    it("leaves the sandbox on --full-auto when the agent's tools list is not a meaningful restriction", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeCodex(dir, { argvFile });
      // The default `makeProjectAgent` tools list resolves to every builtin
      // tool, so this is `"unscoped"`, not a restriction.
      const project = makeProject([makeProjectAgent({ name: "coder" })]);
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        resolveAgentTools: createCodexToolsResolver(project),
      });

      await executor.execute(makeRuntimeTask(), "coder");

      const argv = await readArgv(argvFile);
      expect(argv).toContain("--full-auto");
      expect(argv).not.toContain("--sandbox");
    });

    it("does not touch the sandbox at all when no resolver is configured", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeCodex(dir, { argvFile });
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath, sandbox: "danger-full-access" },
      });

      await executor.execute(makeRuntimeTask(), "coder");

      // `backendOptions.sandbox` is honoured as-is: with no `resolveAgentTools`
      // there is nothing to override it with.
      expect(flagValue(await readArgv(argvFile), "--sandbox")).toBe(
        "danger-full-access",
      );
    });

    it("warns once per run when an agent's tools list cannot be mapped onto a sandbox", async () => {
      const binaryPath = await writeFakeCodex(dir);
      const project = makeProject([
        makeProjectAgent({ name: "coder", tools: ["read", "bash"] }),
      ]);
      const resolveAgentTools = createCodexToolsResolver(project);
      const events = new RecordingSink();
      // Mirrors `codexWorkspaceFactory`: one `toolScopingWarned` set shared
      // across every executor built for the run, since a fresh executor is
      // constructed per task worktree in production.
      const toolScopingWarned = new Set<string>();

      const first = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        events,
        backendOptions: { binaryPath },
        resolveAgentTools,
        toolScopingWarned,
      });
      const second = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        events,
        backendOptions: { binaryPath },
        resolveAgentTools,
        toolScopingWarned,
      });

      await first.execute(makeRuntimeTask({ id: "T01" }), "coder");
      await second.execute(makeRuntimeTask({ id: "T02" }), "coder");

      const warnings = events.events.filter(
        (event) => event.type === "backend.tool_scoping_unsupported",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        taskId: "T01",
        data: { backend: "codex", agent: "coder" },
      });
    });

    it("warns independently for two different unmappable agents", async () => {
      const binaryPath = await writeFakeCodex(dir);
      const project = makeProject([
        makeProjectAgent({ name: "coder", tools: ["read", "bash"] }),
        makeProjectAgent({ name: "fixer", tools: ["write"] }),
      ]);
      const events = new RecordingSink();
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        events,
        backendOptions: { binaryPath },
        resolveAgentTools: createCodexToolsResolver(project),
        toolScopingWarned: new Set<string>(),
      });

      await executor.execute(makeRuntimeTask({ id: "T01" }), "coder");
      await executor.execute(makeRuntimeTask({ id: "T02" }), "fixer");

      const agents = events.events
        .filter((event) => event.type === "backend.tool_scoping_unsupported")
        .map((event) =>
          event.type === "backend.tool_scoping_unsupported"
            ? event.data.agent
            : undefined,
        );
      expect(agents).toEqual(["coder", "fixer"]);
    });

    it("does not warn for a read-only mapping or an unscoped agent", async () => {
      const binaryPath = await writeFakeCodex(dir);
      const project = makeProject([
        makeProjectAgent({ name: "reviewer", tools: ["read", "grep"] }),
        makeProjectAgent({ name: "coder" }),
      ]);
      const events = new RecordingSink();
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        events,
        backendOptions: { binaryPath },
        resolveAgentTools: createCodexToolsResolver(project),
        toolScopingWarned: new Set<string>(),
      });

      await executor.execute(makeRuntimeTask({ id: "T01" }), "reviewer");
      await executor.execute(makeRuntimeTask({ id: "T02" }), "coder");

      expect(events.types()).not.toContain("backend.tool_scoping_unsupported");
    });
  });

  describe("review tasks", () => {
    /** A fake `codex` whose whole run is one agent message. */
    function fakeReplying(text: string): Promise<string> {
      return writeFakeCodex(dir, {
        body: [
          `printf '%s\\n' '${JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text },
          })}'`,
          "exit 0",
        ].join("\n"),
      });
    }

    async function reviewResult(text: string) {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath: await fakeReplying(text) },
      });
      return executor.execute(makeRuntimeTask({ type: "review" }), "reviewer");
    }

    it("briefs the reviewer to reply with a JSON verdict, not to call a tool", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeCodex(dir, { argvFile });
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
      });

      await executor.execute(makeRuntimeTask({ type: "review" }), "reviewer");

      const prompt = (await readArgv(argvFile)).at(-1) ?? "";
      expect(prompt).toContain("## Review task — a verdict is required");
      expect(prompt).toContain(
        "Your final message MUST contain exactly one JSON",
      );
      expect(prompt).not.toContain("submit_review_verdict");
    });

    it("keeps the JSON verdict contract under the project's own reviewer guidance", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeCodex(dir, { argvFile });
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        handoff: { reviewer: "Check the migration plan first." },
      });

      await executor.execute(makeRuntimeTask({ type: "review" }), "reviewer");

      const prompt = (await readArgv(argvFile)).at(-1) ?? "";
      expect(prompt).toContain("Check the migration plan first.");
      expect(prompt).not.toContain("not writing code yourself");
      expect(prompt).toContain(
        "Your final message MUST contain exactly one JSON",
      );
      expect(prompt).toContain('"severity": "blocking"');
    });

    it("passes a review whose reply approved the change", async () => {
      const result = await reviewResult(
        JSON.stringify({
          approved: true,
          summary: "The retry logic is correct and covered.",
        }),
      );

      expect(result.status).toBe("success");
      expect(result.summary).toBe("The retry logic is correct and covered.");
      expect(result.unresolvedIssues).toEqual([]);
    });

    it("fails a review whose reply rejected the change, even on a clean exit", async () => {
      const result = await reviewResult(
        [
          "Here is my verdict:",
          "```json",
          JSON.stringify({
            approved: false,
            summary: "The token is logged in plain text.",
            issues: [
              { severity: "blocking", description: "Redact the auth header." },
            ],
          }),
          "```",
        ].join("\n"),
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toBe(
        "Review rejected: The token is logged in plain text.",
      );
      expect(result.unresolvedIssues).toEqual([
        "blocking: Redact the auth header.",
      ]);
      expect(result.confidence).toBe(0.9);
    });

    it("fails a review that answered in prose only", async () => {
      const result = await reviewResult(
        "REJECTED. There is a blocking issue: the token is logged.",
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toBe(NO_VERDICT_SUMMARY);
      expect(result.confidence).toBe(0.1);
    });

    it("keeps the CLI diagnostic when a review never ran", async () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath: join(dir, "definitely-not-here") },
      });

      const result = await executor.execute(
        makeRuntimeTask({ type: "review" }),
        "reviewer",
      );

      expect(result.status).toBe("failed");
      expect(result.summary).toContain(NO_VERDICT_SUMMARY);
      expect(result.summary).toContain("Codex CLI not found");
    });

    it("leaves a non-review task alone even if it replied with JSON", async () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: {
          binaryPath: await fakeReplying(
            '{"approved": false, "summary": "not a review"}',
          ),
        },
      });

      const result = await executor.execute(makeRuntimeTask(), "coder");

      expect(result.status).toBe("success");
      expect(result.summary).toBe(
        '{"approved": false, "summary": "not a review"}',
      );
    });
  });

  describe("usage reporting", () => {
    /** A sink whose placeholder identity mirrors `delegatedModelIdentity`. */
    function fakeSink(recorder: UsageTracker): DelegatedWorkerUsageSink {
      return {
        recorder,
        modelFor: (model) => ({
          provider: "openai",
          id: model ?? "<codex default>",
          capabilities: {
            tools: false,
            reasoning: false,
            vision: false,
            structuredOutput: false,
          },
        }),
      };
    }

    it("records what Codex reported, tagged by the routed agent and task", async () => {
      const binaryPath = await writeFakeCodex(dir, {
        body: [
          `printf '%s\\n' '${JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 120, output_tokens: 30 },
          })}'`,
          "exit 0",
        ].join("\n"),
      });
      const usage = new UsageTracker();
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        usage: fakeSink(usage),
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(usage.totals().usage).toEqual({
        inputTokens: 120,
        outputTokens: 30,
      });
      // No pricing is claimed for a subscription CLI.
      expect(usage.totals().costUsd).toBe(0);
      const byTask = usage.breakdownBy("task");
      expect([...byTask.keys()]).toEqual(["task-1"]);
      expect(byTask.get("task-1")?.agents).toEqual(["coder"]);
      expect(byTask.get("task-1")?.pricing).toBe("unknown");
    });

    it("keys the recorded usage to the model resolved for the task", async () => {
      const binaryPath = await writeFakeCodex(dir, {
        body: [
          `printf '%s\\n' '${JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 10, output_tokens: 5 },
          })}'`,
          "exit 0",
        ].join("\n"),
      });
      const usage = new UsageTracker();
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        resolveAgentModel: () => "gpt-5-codex",
        usage: fakeSink(usage),
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect([...usage.breakdownBy("model").keys()]).toEqual(["gpt-5-codex"]);
    });

    it("records nothing when Codex reported no usage — not even a zero", async () => {
      const binaryPath = await writeFakeCodex(dir, {
        body: [
          `printf '%s\\n' '${JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: AGENT_MESSAGE },
          })}'`,
          "exit 0",
        ].join("\n"),
      });
      const usage = new UsageTracker();
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        usage: fakeSink(usage),
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(usage.breakdownBy("task").size).toBe(0);
    });

    it("records nothing for a crashed attempt", async () => {
      const usage = new UsageTracker();
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath: join(dir, "definitely-not-here") },
        usage: fakeSink(usage),
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(usage.breakdownBy("task").size).toBe(0);
    });

    it("does nothing without a sink", async () => {
      const binaryPath = await writeFakeCodex(dir, {
        body: [
          `printf '%s\\n' '${JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 120, output_tokens: 30 },
          })}'`,
          "exit 0",
        ].join("\n"),
      });
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
      });

      // Would throw if the executor assumed a sink is always present.
      await expect(
        executor.execute(makeRuntimeTask(), "coder"),
      ).resolves.toMatchObject({ status: "success" });
    });
  });

  describe("describeAgent", () => {
    it("prefers the resolver's model over backendOptions.model", () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { model: "run-wide-default" },
        resolveAgentModel: () => "gpt-5-codex",
      });

      expect(executor.describeAgent("coder")).toEqual({
        model: "gpt-5-codex",
      });
    });

    it("falls back to backendOptions.model when the resolver has no answer", () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { model: "run-wide-default" },
        resolveAgentModel: () => undefined,
      });

      expect(executor.describeAgent("coder")).toEqual({
        model: "run-wide-default",
      });
    });

    it("returns undefined when neither the resolver nor backendOptions name a model", () => {
      const executor = new CodexWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
      });

      expect(executor.describeAgent("coder")).toBeUndefined();
    });
  });
});
