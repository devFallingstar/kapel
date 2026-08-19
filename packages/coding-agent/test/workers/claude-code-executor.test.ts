import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeWorkerExecutor,
  claudeCodeAllowedTools,
  createDelegatedToolsResolver,
} from "../../src/workers/claude-code-executor.js";
import { writeFakeClaude } from "../backends/test-helpers.js";
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

/** Reads the NUL-separated argv dump written by the fake claude binary. */
async function readArgv(path: string): Promise<string[]> {
  const raw = await readFile(path, "utf8");
  return raw.split("\0").slice(0, -1);
}

/** The value that followed `flag` in argv, or undefined when it was absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("claudeCodeAllowedTools", () => {
  it("maps the template tool vocabulary to Claude Code tool names", () => {
    expect(
      claudeCodeAllowedTools(["read", "write", "edit", "grep", "glob", "bash"]),
    ).toEqual(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
  });

  it("scopes git.diff to a bash command prefix and git.* to all of git", () => {
    expect(claudeCodeAllowedTools(["git.diff"])).toEqual(["Bash(git diff:*)"]);
    expect(claudeCodeAllowedTools(["git_diff"])).toEqual(["Bash(git diff:*)"]);
    expect(claudeCodeAllowedTools(["git.*"])).toEqual(["Bash(git:*)"]);
    expect(claudeCodeAllowedTools(["git_*"])).toEqual(["Bash(git:*)"]);
  });

  it("normalizes case and the `_`/`.` separator", () => {
    expect(claudeCodeAllowedTools(["  READ ", "Git_Diff"])).toEqual([
      "Read",
      "Bash(git diff:*)",
    ]);
  });

  it("dedupes while keeping a deterministic first-seen order", () => {
    expect(
      claudeCodeAllowedTools(["grep", "read", "Read", "git.diff", "git_diff"]),
    ).toEqual(["Grep", "Read", "Bash(git diff:*)"]);
  });

  it("drops patterns with no Claude Code equivalent", () => {
    expect(claudeCodeAllowedTools(["read", "task.*", "mystery_tool"])).toEqual([
      "Read",
    ]);
  });

  it("returns undefined for an empty list — the agent made no choice", () => {
    expect(claudeCodeAllowedTools([])).toBeUndefined();
    expect(claudeCodeAllowedTools(["", "  "])).toBeUndefined();
  });

  it("returns undefined when every pattern was dropped", () => {
    // The orchestrator's tools: an empty --allowedTools cannot be expressed,
    // and a worker allowed nothing could not run a task at all.
    expect(
      claudeCodeAllowedTools(["task.*", "worker.*", "result.*", "plan.*"]),
    ).toBeUndefined();
  });
});

describe("createDelegatedToolsResolver", () => {
  const project = makeProject([
    makeProjectAgent({ name: "coder" }),
    makeProjectAgent({
      name: "reviewer",
      tools: ["read", "grep", "glob", "git.diff", "bash"],
    }),
    makeProjectAgent({ name: "lead", tools: ["task.*", "plan.*"] }),
    makeProjectAgent({ name: "freeform", tools: [] }),
  ]);

  it("maps a project agent's tools list", () => {
    const resolve = createDelegatedToolsResolver(project);
    expect(resolve("reviewer")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff:*)",
      "Bash",
    ]);
  });

  it("returns undefined for unknown agents and for unmappable lists", () => {
    const resolve = createDelegatedToolsResolver(project);
    expect(resolve("nobody")).toBeUndefined();
    expect(resolve("lead")).toBeUndefined();
    expect(resolve("freeform")).toBeUndefined();
  });
});

describe("ClaudeCodeWorkerExecutor", () => {
  let dir: string;
  let workspace: string;

  beforeEach(async () => {
    dir = await makeTempDir("claude-worker-");
    workspace = await makeTempDir("claude-worker-ws-");
  });

  afterEach(async () => {
    await cleanup(dir);
    await cleanup(workspace);
  });

  it("normalizes a successful Claude Code run into a task result", async () => {
    const head = await initGitRepo(workspace);
    const binaryPath = await writeFakeClaude(dir, {
      body: [
        `printf '%s\\n' '${JSON.stringify({
          type: "result",
          result: AGENT_MESSAGE,
          session_id: "sess-1",
        })}'`,
        'printf "export const retries = 3;\\n" > retry.ts',
        "exit 0",
      ].join("\n"),
    });
    const events = new RecordingSink();
    const executor = new ClaudeCodeWorkerExecutor({
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
    expect(result.tests).toEqual({ passed: 0, failed: 0, commands: [] });

    expect(events.types()).toContain("claude-code.result");
    expect(
      events.events.every(
        (event) => event.runId === "run-7" && event.taskId === "task-1",
      ),
    ).toBe(true);
  });

  it("passes the same task briefing Claude-Code-side", async () => {
    const argvFile = join(dir, "argv.txt");
    const binaryPath = await writeFakeClaude(dir, { argvFile });
    const executor = new ClaudeCodeWorkerExecutor({
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

    const argv = await readArgv(argvFile);
    const prompt = argv.at(-1) ?? "";
    expect(prompt).toContain("Add retry to the uploader");
    expect(prompt).toContain("Retry failed uploads three times with backoff.");
    expect(prompt).toContain('acting as the "coder" worker');
    expect(prompt).toContain("## Results from dependency tasks");
    expect(prompt).toContain("### T00 — success");
  });

  it("returns a failed result when the claude binary is missing", async () => {
    const executor = new ClaudeCodeWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      backendOptions: { binaryPath: join(dir, "definitely-not-here") },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Claude Code CLI not found");
    expect(result.changedFiles).toEqual([]);
  });

  it("applies the executor timeout to the claude process", async () => {
    const binaryPath = await writeFakeClaude(dir, { sleepSeconds: 30 });
    const executor = new ClaudeCodeWorkerExecutor({
      workspacePath: workspace,
      runId: "run-7",
      taskTimeoutMs: 300,
      backendOptions: { binaryPath, timeoutMs: 60_000 },
    });

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timed out after 300ms");
  }, 20_000);

  describe("model routing", () => {
    it("passes the resolved per-agent model as --model, overriding backendOptions.model", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeClaude(dir, { argvFile });
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath, model: "run-wide-default" },
        resolveAgentModel: (agent) => (agent === "coder" ? "opus" : undefined),
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(flagValue(await readArgv(argvFile), "--model")).toBe("opus");
    });

    it("falls back to backendOptions.model when the resolver has no answer", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeClaude(dir, { argvFile });
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath, model: "run-wide-default" },
        resolveAgentModel: () => undefined,
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(flagValue(await readArgv(argvFile), "--model")).toBe(
        "run-wide-default",
      );
    });

    it("omits --model when neither names one", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeClaude(dir, { argvFile });
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(await readArgv(argvFile)).not.toContain("--model");
    });
  });

  describe("tool scoping", () => {
    it("passes the routed agent's tools as a comma-joined --allowedTools", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeClaude(dir, { argvFile });
      const project = makeProject([
        makeProjectAgent({
          name: "reviewer",
          tools: ["read", "grep", "glob", "git.diff"],
        }),
      ]);
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath, allowedTools: ["Bash"] },
        resolveAgentTools: createDelegatedToolsResolver(project),
      });

      await executor.execute(makeRuntimeTask(), "reviewer");

      expect(flagValue(await readArgv(argvFile), "--allowedTools")).toBe(
        "Read,Grep,Glob,Bash(git diff:*)",
      );
    });

    it("falls back to backendOptions.allowedTools when the resolver has no answer", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeClaude(dir, { argvFile });
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath, allowedTools: ["Read", "Bash"] },
        resolveAgentTools: () => undefined,
      });

      await executor.execute(makeRuntimeTask(), "coder");

      expect(flagValue(await readArgv(argvFile), "--allowedTools")).toBe(
        "Read,Bash",
      );
    });

    it("omits --allowedTools when the agent listed nothing mappable", async () => {
      const argvFile = join(dir, "argv.txt");
      const binaryPath = await writeFakeClaude(dir, { argvFile });
      const project = makeProject([
        makeProjectAgent({ name: "lead", tools: ["task.*", "plan.*"] }),
        makeProjectAgent({ name: "freeform", tools: [] }),
      ]);
      const resolveAgentTools = createDelegatedToolsResolver(project);
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { binaryPath },
        resolveAgentTools,
      });

      await executor.execute(makeRuntimeTask(), "lead");
      expect(await readArgv(argvFile)).not.toContain("--allowedTools");

      await executor.execute(makeRuntimeTask(), "freeform");
      expect(await readArgv(argvFile)).not.toContain("--allowedTools");
    });
  });

  describe("describeAgent", () => {
    it("prefers the resolver's model over backendOptions.model", () => {
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
        backendOptions: { model: "run-wide-default" },
        resolveAgentModel: () => "opus",
      });

      expect(executor.describeAgent("coder")).toEqual({ model: "opus" });
    });

    it("falls back to backendOptions.model when the resolver has no answer", () => {
      const executor = new ClaudeCodeWorkerExecutor({
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
      const executor = new ClaudeCodeWorkerExecutor({
        workspacePath: workspace,
        runId: "run-7",
      });

      expect(executor.describeAgent("coder")).toBeUndefined();
    });
  });
});
