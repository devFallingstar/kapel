import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDefinition, ModelMessage, ModelUsage } from "@agent/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../src/loop.js";
import { builtinTools } from "../../src/tools/index.js";
import {
  AgentLoopWorkerExecutor,
  type AgentLoopWorkerExecutorOptions,
  DEFAULT_WORKER_PERMISSIONS,
  type ResolvedWorkerModel,
  selectToolsForAgent,
} from "../../src/workers/agent-loop-executor.js";
import { WORKER_SYSTEM_POSTAMBLE } from "../../src/workers/briefing.js";
import {
  cleanup,
  ExplodingProvider,
  initGitRepo,
  MODEL,
  makeProject,
  makeProjectAgent,
  makeRuntimeTask,
  makeTaskResult,
  makeTempDir,
  RecordingSink,
  ScriptedProvider,
  textTurn,
  toolCallTurn,
} from "./test-helpers.js";

const toolNames = (patterns: readonly string[]): readonly string[] =>
  selectToolsForAgent(builtinTools(), patterns).map((tool) => tool.name);

describe("selectToolsForAgent", () => {
  it("treats an empty pattern list as every builtin tool", () => {
    expect(toolNames([])).toEqual(builtinTools().map((tool) => tool.name));
  });

  it("maps the template tool vocabulary onto the builtin tool names", () => {
    expect(
      toolNames(["read", "grep", "glob", "edit", "write", "bash", "git.*"]),
    ).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "bash",
      "git_diff",
    ]);
  });

  it("matches dotted names against underscored builtin names", () => {
    expect(toolNames(["git.diff"])).toEqual(["git_diff"]);
    expect(toolNames(["git_diff"])).toEqual(["git_diff"]);
    expect(toolNames(["read_file"])).toEqual(["read_file"]);
    expect(toolNames(["READ"])).toEqual(["read_file"]);
  });

  it("expands trailing wildcards over a namespace only", () => {
    expect(toolNames(["git.*"])).toEqual(["git_diff"]);
    expect(toolNames(["git_*"])).toEqual(["git_diff"]);
    // A wildcard only reaches its own namespace, never every tool.
    expect(toolNames(["gi.*"])).toEqual([]);
  });

  it("never matches on a bare prefix", () => {
    expect(toolNames(["file"])).toEqual([]);
    expect(toolNames(["rea"])).toEqual([]);
  });

  it("drops patterns with no builtin equivalent", () => {
    expect(toolNames(["task.*", "worker.*", "plan.*"])).toEqual([]);
    expect(toolNames(["read", "task.*"])).toEqual(["read_file"]);
  });

  it("keeps the reviewer template's read-only selection", () => {
    expect(toolNames(["read", "grep", "glob", "git.diff", "bash"])).toEqual([
      "read_file",
      "glob",
      "grep",
      "bash",
      "git_diff",
    ]);
  });
});

describe("AgentLoopWorkerExecutor", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTempDir("loop-worker-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup(workspace);
  });

  function options(
    overrides: Partial<AgentLoopWorkerExecutorOptions> = {},
  ): AgentLoopWorkerExecutorOptions {
    const provider = new ScriptedProvider([textTurn("done")]);
    return {
      project: makeProject([makeProjectAgent()]),
      resolveModel: () => ({ provider, model: MODEL }),
      workspacePath: workspace,
      runId: "run-1",
      ...overrides,
    };
  }

  it("briefs the worker with the task spec and the headless postamble", async () => {
    const provider = new ScriptedProvider([textTurn("Added the retry.")]);
    const executor = new AgentLoopWorkerExecutor(
      options({ resolveModel: () => ({ provider, model: MODEL }) }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("success");
    expect(result.summary).toBe("Added the retry.");

    const request = provider.requests[0];
    expect(request).toBeDefined();
    const system = request?.messages[0];
    const user = request?.messages[1];

    expect(system?.role).toBe("system");
    expect(system?.content).toContain("You are the coder.");
    expect(system?.content).toContain(WORKER_SYSTEM_POSTAMBLE);

    expect(user?.role).toBe("user");
    expect(user?.content).toContain("Add retry to the uploader");
    expect(user?.content).toContain(
      "Retry failed uploads three times with backoff.",
    );
    expect(user?.content).toContain("packages/uploader");
    expect(user?.content).toContain("implementation");
    expect(user?.content).toContain("reliability");
    expect(user?.content).toContain('acting as the "coder" worker');
    expect(user?.content).toContain(
      "Return a short summary of what you changed",
    );
  });

  it("passes dependency results from the execution context into the briefing", async () => {
    const provider = new ScriptedProvider([textTurn("done")]);
    const executor = new AgentLoopWorkerExecutor(
      options({ resolveModel: () => ({ provider, model: MODEL }) }),
    );

    await executor.execute(makeRuntimeTask(), "coder", undefined, {
      dependencyResults: [
        makeTaskResult({
          taskId: "T00",
          summary: "Added the /healthz route.",
          changedFiles: ["src/server.ts"],
        }),
      ],
    });

    const user = provider.requests[0]?.messages[1];
    expect(user?.content).toContain("## Results from dependency tasks");
    expect(user?.content).toContain("### T00 — success");
    expect(user?.content).toContain("Added the /healthz route.");
    expect(user?.content).toContain("  - src/server.ts");
  });

  it("reports the files the worker changed and the workspace commit", async () => {
    const head = await initGitRepo(workspace);
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", "write_file", {
        path: "src/retry.ts",
        content: "export const retries = 3;\n",
      }),
      textTurn("Added src/retry.ts."),
    ]);
    const executor = new AgentLoopWorkerExecutor(
      options({ resolveModel: () => ({ provider, model: MODEL }) }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("success");
    expect(result.changedFiles).toEqual(["src/retry.ts"]);
    expect(result.commit).toBe(head);
    expect(result.taskId).toBe("task-1");
    expect(result.confidence).toBe(0.8);
    expect(await readFile(join(workspace, "src", "retry.ts"), "utf8")).toBe(
      "export const retries = 3;\n",
    );
  });

  it("passes only the agent's selected tools to the model", async () => {
    const provider = new ScriptedProvider([textTurn("nothing to do")]);
    const executor = new AgentLoopWorkerExecutor(
      options({
        project: makeProject([
          makeProjectAgent({
            name: "explorer",
            tools: ["read", "grep", "glob", "git.diff"],
          }),
        ]),
        resolveModel: () => ({ provider, model: MODEL }),
      }),
    );

    await executor.execute(makeRuntimeTask(), "explorer");

    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob",
      "grep",
      "git_diff",
    ]);
  });

  it("returns a failed result for an unknown agent instead of throwing", async () => {
    const executor = new AgentLoopWorkerExecutor(options());

    const result = await executor.execute(makeRuntimeTask(), "ghost");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Unknown agent ghost");
    expect(result.summary).toContain("coder");
    expect(result.taskId).toBe("task-1");
    expect(result.confidence).toBe(0.1);
  });

  it("returns a failed result when the model alias cannot be resolved", async () => {
    const executor = new AgentLoopWorkerExecutor(
      options({
        resolveModel: (alias) => {
          throw new Error(`Unknown model alias "${alias}"`);
        },
      }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("worker");
    expect(result.summary).toContain("Unknown model alias");
  });

  it("allows the default builtin tool set without a prompter", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", "write_file", {
        path: "allowed.txt",
        content: "ok\n",
      }),
      textTurn("wrote it"),
    ]);
    const executor = new AgentLoopWorkerExecutor(
      options({ resolveModel: () => ({ provider, model: MODEL }) }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    const toolMessage = provider.requests[1]?.messages.find(
      (message: ModelMessage) => message.role === "tool",
    );
    expect(toolMessage?.isError).toBeUndefined();
    expect(result.status).toBe("success");
    expect(await readFile(join(workspace, "allowed.txt"), "utf8")).toBe("ok\n");
  });

  it("denies anything outside the permission rules rather than prompting", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", "write_file", {
        path: "denied.txt",
        content: "nope\n",
      }),
      textTurn("could not write"),
    ]);
    const executor = new AgentLoopWorkerExecutor(
      options({
        resolveModel: () => ({ provider, model: MODEL }),
        permissionOverrides: { read_file: "allow" },
      }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    const toolMessage = provider.requests[1]?.messages.find(
      (message: ModelMessage) => message.role === "tool",
    );
    expect(toolMessage?.isError).toBe(true);
    expect(toolMessage?.content).toContain("was not permitted");
    expect(toolMessage?.content).toContain("denied by policy");
    expect(result.changedFiles).toEqual([]);
  });

  it("never prompts for an `ask` decision in a headless worker", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", "bash", { command: "echo hi" }),
      textTurn("blocked"),
    ]);
    const executor = new AgentLoopWorkerExecutor(
      options({
        resolveModel: () => ({ provider, model: MODEL }),
        permissionOverrides: { bash: "ask" },
      }),
    );

    await executor.execute(makeRuntimeTask(), "coder");

    const toolMessage = provider.requests[1]?.messages.find(
      (message: ModelMessage) => message.role === "tool",
    );
    expect(toolMessage?.isError).toBe(true);
    expect(toolMessage?.content).toContain("no prompter available");
  });

  it("surfaces a provider failure as a failed task result", async () => {
    const executor = new AgentLoopWorkerExecutor(
      options({
        resolveModel: () => ({
          provider: new ExplodingProvider(),
          model: MODEL,
        }),
      }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("provider exploded");
    expect(result.confidence).toBe(0.1);
  });

  it("turns a crashing agent loop into a failed result, still inspecting the workspace", async () => {
    await initGitRepo(workspace);
    await writeFile(join(workspace, "half-done.ts"), "export {};\n", "utf8");
    vi.spyOn(AgentLoop.prototype, "run").mockRejectedValue(
      new Error("loop imploded"),
    );
    const executor = new AgentLoopWorkerExecutor(options());

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Agent loop crashed: loop imploded");
    expect(result.changedFiles).toEqual(["half-done.ts"]);
  });

  it("forwards loop events and usage to the configured sinks", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text.delta", text: "done" },
        { type: "usage", inputTokens: 10, outputTokens: 3 },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const events = new RecordingSink();
    const recorded: { model: ModelDefinition; usage: ModelUsage }[] = [];
    const executor = new AgentLoopWorkerExecutor(
      options({
        resolveModel: () => ({ provider, model: MODEL }),
        events,
        usage: {
          record: (model, usage) => recorded.push({ model, usage }),
        },
      }),
    );

    await executor.execute(makeRuntimeTask(), "coder");

    expect(events.types()).toContain("loop.started");
    expect(events.types()).toContain("loop.completed");
    expect(events.events.every((event) => event.runId === "run-1")).toBe(true);
    expect(events.events.every((event) => event.taskId === "task-1")).toBe(
      true,
    );
    expect(recorded).toEqual([
      { model: MODEL, usage: { inputTokens: 10, outputTokens: 3 } },
    ]);
  });

  it("stops at the iteration budget with a partial result", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn("call-1", "read_file", { path: "tracked.txt" }),
      toolCallTurn("call-2", "read_file", { path: "tracked.txt" }),
    ]);
    const executor = new AgentLoopWorkerExecutor(
      options({
        resolveModel: () => ({ provider, model: MODEL }),
        maxIterations: 2,
      }),
    );

    const result = await executor.execute(makeRuntimeTask(), "coder");

    expect(result.status).toBe("partial");
    expect(result.confidence).toBe(0.4);
    expect(result.summary).toContain("iteration budget");
  });

  it("exposes a read/write default policy that denies everything else", () => {
    expect(DEFAULT_WORKER_PERMISSIONS).toEqual({
      read_file: "allow",
      glob: "allow",
      grep: "allow",
      git_diff: "allow",
      write_file: "allow",
      edit_file: "allow",
      bash: "allow",
    });
  });

  it("resolves the model alias declared by the routed agent", async () => {
    const aliases: string[] = [];
    const provider = new ScriptedProvider([textTurn("ok")]);
    const resolveModel = (alias: string): ResolvedWorkerModel => {
      aliases.push(alias);
      return { provider, model: MODEL };
    };
    const executor = new AgentLoopWorkerExecutor(
      options({
        project: makeProject([
          makeProjectAgent({ name: "reviewer", modelAlias: "cheap" }),
        ]),
        resolveModel,
      }),
    );

    await executor.execute(makeRuntimeTask(), "reviewer");

    expect(aliases).toEqual(["cheap"]);
  });
});
