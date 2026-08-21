import { existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelDefinition, ModelEvent, ModelProvider } from "@agent/ai";
import { defaultModelCatalog, UNATTRIBUTED, UsageTracker } from "@agent/ai";
import type {
  AgentProject,
  OrchestrationPolicy,
  ProjectAgent,
  ProjectValidator,
  RuntimeTask,
  TaskResult,
  WorkerExecutor,
} from "@agent/coding-agent";
import {
  ClaudeCodeWorkerExecutor,
  DEFAULT_WORKER_GUIDANCE,
  ValidatingExecutor,
  WORKER_SYSTEM_POSTAMBLE,
  WorktreeIsolatedExecutor,
} from "@agent/coding-agent";
import type { AgentEvent } from "@agent/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The argv-recording fake `claude`/`codex` harness the coding-agent package
// already tests its delegated steps through; reused rather than reinvented so
// the mixed-backend run below is asserted against the same shell scripts.
import { writeScriptedCli } from "../../../packages/coding-agent/test/planning/delegated-cli-harness.js";
import type {
  ExecutorFactoryArgs,
  OrchestrateCommandOptions,
  RunSummaryContext,
} from "../src/orchestrate.js";
import {
  DEFAULT_ISOLATION,
  defaultExecutorFactory,
  delegatedPlanningThrough,
  delegatedWorkerUsageSink,
  PLANNER_AGENT,
  planningThrough,
  runOrchestrate,
  runSummaryLines,
  validateIsolation,
  worktreeIsolationError,
} from "../src/orchestrate.js";
import type { DelegatedPlannerFactory } from "../src/plan.js";
import { TextRenderer } from "../src/render.js";
import {
  CapturingStream,
  capture,
  cleanupWorkspace,
  copyTemplateAgentDir,
  fixedDelegatedPlannerFactory,
  fixedPlannerFactory,
  initRepo,
  makeWorkspace,
  ROUTING_POLICY,
  SAMPLE_PLAN,
  ScriptedExecutor,
  successResult,
  task,
  writeLock,
} from "./orchestration-fixtures.js";

/** The minimum an {@link AgentProject} needs to be for a factory that ignores it. */
function emptyProject(): AgentProject {
  return {
    root: "/virtual/.agent",
    config: { models: {}, agentSlots: {}, validators: [] },
    agents: [],
    orchestrationMarkdown: undefined,
    handoff: undefined,
    knownAgentNames: () => new Set<string>(),
    agent: () => undefined,
  };
}

/** A minimal `.agent/agents/<name>.md` agent, for role lookups in summary tests. */
function projectAgent(name: string, role: ProjectAgent["role"]): ProjectAgent {
  return {
    name,
    modelAlias: name,
    role,
    tools: [],
    systemPrompt: "",
    sourcePath: `/virtual/.agent/agents/${name}.md`,
  };
}

/** {@link emptyProject} whose `agent()` answers from a fixed role table. */
function projectWithRoles(agents: readonly ProjectAgent[]): AgentProject {
  const base = emptyProject();
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return {
    ...base,
    agents,
    knownAgentNames: () => new Set(byName.keys()),
    agent: (name) => byName.get(name),
  };
}

/** {@link emptyProject} with a `validation:` list, as `defaultExecutorFactory` sees it. */
function projectWithValidators(
  validators: readonly ProjectValidator[],
): AgentProject {
  const base = emptyProject();
  return { ...base, config: { ...base.config, validators } };
}

/** A `RuntimeTask` of a mutating type, the only kind `ValidatingExecutor` gates. */
function mutatingTask(id: string): RuntimeTask {
  return {
    spec: task(id, { type: "implementation" }),
    status: "running",
    attempts: 1,
  };
}

/** A `WorkerExecutor` stub that just counts how many times it ran. */
class CountingExecutor implements WorkerExecutor {
  calls = 0;

  async execute(runtimeTask: RuntimeTask): Promise<TaskResult> {
    this.calls += 1;
    return successResult(runtimeTask.spec.id, `${runtimeTask.spec.id} done`);
  }
}

/** Appends a real `validation:` list onto a copied template's `.agent/config.yaml`. */
async function appendValidatorsConfig(
  workspacePath: string,
  validators: readonly ProjectValidator[],
): Promise<void> {
  const lines = validators.map(
    (validator) =>
      `  - name: ${validator.name}\n    command: ${JSON.stringify(validator.command)}`,
  );
  await appendFile(
    path.join(workspacePath, ".agent", "config.yaml"),
    `\nvalidation:\n${lines.join("\n")}\n`,
    "utf8",
  );
}

function options(
  cwd: string,
  overrides: Partial<OrchestrateCommandOptions> = {},
): OrchestrateCommandOptions {
  return {
    cwd,
    json: false,
    dryRun: false,
    backend: "native",
    // These fixtures run in throwaway directories that are not repositories,
    // so isolation is opted out of except where a test is about it.
    isolation: "none",
    ...overrides,
  };
}

describe("validateIsolation", () => {
  it("accepts the known modes and rejects anything else", () => {
    expect(validateIsolation("worktree")).toBe("worktree");
    expect(validateIsolation("none")).toBe("none");
    expect(() => validateIsolation("sandbox")).toThrow(/--isolation/);
  });

  it("defaults to worktree isolation", () => {
    expect(DEFAULT_ISOLATION).toBe("worktree");
  });
});

describe("worktreeIsolationError", () => {
  it("rejects a directory that is not a git repository", async () => {
    const bare = await makeWorkspace("cli-isolation-bare-");
    try {
      const problem = await worktreeIsolationError(bare);
      expect(problem).toContain("git repository with at least one commit");
      expect(problem).toContain("--isolation none");
    } finally {
      await cleanupWorkspace(bare);
    }
  });

  it("accepts a repository that has a commit", async () => {
    const repo = await makeWorkspace("cli-isolation-repo-");
    try {
      await initRepo(repo);
      expect(await worktreeIsolationError(repo)).toBeUndefined();
    } finally {
      await cleanupWorkspace(repo);
    }
  });
});

describe("defaultExecutorFactory / isolation", () => {
  /** Stands in for whatever the per-workspace factory would have built. */
  const bare: WorkerExecutor = {
    execute: () => Promise.reject(new Error("unreachable")),
  };

  function factoryArgs(
    cwd: string,
    isolation: "worktree" | "none",
  ): Parameters<typeof defaultExecutorFactory>[0] {
    return {
      project: emptyProject(),
      workspacePath: cwd,
      runId: "run-1",
      events: { emit: () => undefined },
      usage: new UsageTracker(),
      backend: "native",
      isolation,
      validate: true,
      // Injected so the isolation question can be answered without building a
      // real executor — and therefore without resolving model credentials.
      baseExecutorFactory: () => bare,
    };
  }

  it("wraps the per-workspace executor in worktree isolation by default", async () => {
    const executor = await defaultExecutorFactory(
      factoryArgs("/does/not/matter", "worktree"),
    );
    expect(executor).toBeInstanceOf(WorktreeIsolatedExecutor);
  });

  it("returns the bare executor under --isolation none", async () => {
    const executor = await defaultExecutorFactory(
      factoryArgs("/does/not/matter", "none"),
    );
    expect(executor).toBe(bare);
  });
});

describe("defaultExecutorFactory / validation", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeWorkspace("cli-validation-test-");
  });

  afterEach(async () => {
    await cleanupWorkspace(workspace);
  });

  /** `baseExecutorFactory` bypasses the codex/claude-code/native selection entirely. */
  function factoryArgs(
    overrides: Partial<Parameters<typeof defaultExecutorFactory>[0]> = {},
  ): Parameters<typeof defaultExecutorFactory>[0] {
    return {
      project: emptyProject(),
      workspacePath: workspace,
      runId: "run-1",
      events: { emit: () => undefined },
      usage: new UsageTracker(),
      backend: "native",
      isolation: "none",
      validate: true,
      ...overrides,
    };
  }

  it("wraps the base executor and runs configured validators for a mutating task", async () => {
    const events: AgentEvent[] = [];
    const inner = new CountingExecutor();
    const validators: ProjectValidator[] = [
      { name: "typecheck", command: "true" },
    ];

    const executor = await defaultExecutorFactory(
      factoryArgs({
        project: projectWithValidators(validators),
        events: {
          emit: (event) => {
            events.push(event);
          },
        },
        baseExecutorFactory: () => inner,
      }),
    );

    expect(executor).toBeInstanceOf(ValidatingExecutor);

    const result = await executor.execute(mutatingTask("T01"), "coder");

    expect(inner.calls).toBe(1);
    expect(result.status).toBe("success");
    expect(result.tests).toEqual({
      passed: 1,
      failed: 0,
      commands: ["true"],
    });
    expect(events.map((event) => event.type)).toEqual([
      "validation.started",
      "validation.completed",
    ]);
  });

  it("fails the task when a configured validator fails", async () => {
    const inner = new CountingExecutor();
    const validators: ProjectValidator[] = [{ name: "lint", command: "false" }];

    const executor = await defaultExecutorFactory(
      factoryArgs({
        project: projectWithValidators(validators),
        baseExecutorFactory: () => inner,
      }),
    );

    const result = await executor.execute(mutatingTask("T01"), "coder");
    expect(result.status).toBe("failed");
    expect(result.unresolvedIssues.join("\n")).toContain(
      'Validator "lint" failed',
    );
  });

  it("does not wrap the base executor when validate is false", async () => {
    const inner = new CountingExecutor();
    const validators: ProjectValidator[] = [
      { name: "typecheck", command: "true" },
    ];

    const executor = await defaultExecutorFactory(
      factoryArgs({
        project: projectWithValidators(validators),
        validate: false,
        baseExecutorFactory: () => inner,
      }),
    );

    expect(executor).toBe(inner);
  });

  it("does not wrap the base executor when the project has no validators", async () => {
    const inner = new CountingExecutor();

    const executor = await defaultExecutorFactory(
      factoryArgs({
        project: projectWithValidators([]),
        baseExecutorFactory: () => inner,
      }),
    );

    expect(executor).toBe(inner);
  });

  it("does not wrap the base executor under --backend codex, even with validators configured", async () => {
    const inner = new CountingExecutor();
    const validators: ProjectValidator[] = [
      { name: "typecheck", command: "true" },
    ];

    // `baseExecutorFactory` short-circuits the real codex-availability probe
    // `defaultExecutorFactory` would otherwise run for `backend: "codex"`.
    const executor = await defaultExecutorFactory(
      factoryArgs({
        project: projectWithValidators(validators),
        backend: "codex",
        baseExecutorFactory: () => inner,
      }),
    );

    expect(executor).toBe(inner);

    const result = await executor.execute(mutatingTask("T01"), "coder");
    expect(inner.calls).toBe(1);
    // Confirms validators genuinely never ran: a passing result carries no
    // validator-shaped `tests.commands`.
    expect(result.tests.commands).toEqual([]);
  });

  it("still wraps the base executor under --backend claude-code", async () => {
    const inner = new CountingExecutor();
    const validators: ProjectValidator[] = [
      { name: "typecheck", command: "true" },
    ];

    // `baseExecutorFactory` short-circuits the real Claude Code availability
    // probe `defaultExecutorFactory` would otherwise run.
    const executor = await defaultExecutorFactory(
      factoryArgs({
        project: projectWithValidators(validators),
        backend: "claude-code",
        baseExecutorFactory: () => inner,
      }),
    );

    expect(executor).toBeInstanceOf(ValidatingExecutor);

    const result = await executor.execute(mutatingTask("T01"), "coder");
    expect(inner.calls).toBe(1);
    // Unlike codex, a Claude Code task is gated on the project's validators:
    // they run in the task workspace once the CLI subprocess has exited.
    expect(result.tests.commands).toEqual(["true"]);
  });
});

describe("defaultExecutorFactory / mixed backends", () => {
  let workspace: string;
  let claudeDir: string;
  let codexDir: string;
  const originalPath = process.env.PATH;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    workspace = await makeWorkspace("cli-mixed-backends-");
    claudeDir = await makeWorkspace("cli-mixed-claude-");
    codexDir = await makeWorkspace("cli-mixed-codex-");
    await initRepo(workspace);
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
    await cleanupWorkspace(claudeDir);
    await cleanupWorkspace(codexDir);
  });

  /** A fake `claude` whose final result line reports the usage it "spent". */
  const CLAUDE_REPLY = `${JSON.stringify({
    type: "result",
    subtype: "success",
    result: "claude code did the task",
    usage: { input_tokens: 5, output_tokens: 7 },
  })}\n`;

  /** A fake `codex`: one agent message, then a turn with its own usage. */
  const CODEX_REPLY = `${[
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "codex did the task" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 11, output_tokens: 22 },
    }),
  ].join("\n")}\n`;

  /**
   * The two probe invocations every delegated backend makes before it runs
   * anything (`--version`, then `auth status`/`login status`), so the task's
   * own invocation is the third.
   */
  const RUN_INVOCATION = 3;

  function agent(
    name: string,
    modelAlias: string,
    tools: readonly string[] = ["read", "grep"],
  ): ProjectAgent {
    return {
      name,
      modelAlias,
      role: "worker",
      tools,
      systemPrompt: `You are ${name}.`,
      sourcePath: `/virtual/.agent/agents/${name}.md`,
    };
  }

  /** An {@link AgentProject} whose aliases name the backends under test. */
  function mixedProject(
    models: AgentProject["config"]["models"],
    agents: readonly ProjectAgent[],
  ): AgentProject {
    const byName = new Map(agents.map((entry) => [entry.name, entry]));
    return {
      ...emptyProject(),
      config: {
        models,
        agentSlots: {},
        validators: [],
        permission: {},
      },
      agents,
      knownAgentNames: () => new Set(byName.keys()),
      agent: (name: string) => byName.get(name),
    };
  }

  function factoryArgs(
    project: AgentProject,
    backend: "native" | "codex" | "claude-code",
    usage: UsageTracker,
  ): ExecutorFactoryArgs {
    return {
      project,
      workspacePath: workspace,
      runId: "run-mixed",
      events: { emit: () => undefined },
      usage,
      backend,
      isolation: "none",
      validate: false,
    };
  }

  it("routes each task to its own agent's backend, with that backend's model and tools", async () => {
    const fakeClaude = await writeScriptedCli(claudeDir, "claude-code", [
      CLAUDE_REPLY,
    ]);
    const fakeCodex = await writeScriptedCli(codexDir, "codex", [CODEX_REPLY]);
    process.env.PATH = `${claudeDir}:${codexDir}:${originalPath ?? ""}`;

    const usage = new UsageTracker();
    const project = mixedProject(
      {
        lead: { provider: "anthropic", model: "opus", backend: "claude-code" },
        worker: { provider: "openai", model: "gpt-5.1", backend: "codex" },
      },
      [agent("reviewer", "lead"), agent("coder", "worker")],
    );

    const executor = await defaultExecutorFactory(
      factoryArgs(project, "claude-code", usage),
    );

    const codexResult = await executor.execute(mutatingTask("T01"), "coder");
    const claudeResult = await executor.execute(
      mutatingTask("T02"),
      "reviewer",
    );

    // Each task reached a different binary, in the same workspace.
    expect(codexResult.summary).toContain("codex did the task");
    expect(claudeResult.summary).toContain("claude code did the task");
    expect(fakeCodex.binaryPath).not.toBe(fakeClaude.binaryPath);

    // The Codex-backed agent's model went to Codex...
    const codexArgv = await fakeCodex.argv(RUN_INVOCATION);
    expect(codexArgv).toContain("exec");
    expect(
      codexArgv.slice(codexArgv.indexOf("-m"), codexArgv.indexOf("-m") + 2),
    ).toEqual(["-m", "gpt-5.1"]);
    expect(codexArgv).toContain(workspace);

    // ...and the Claude Code-backed agent's went to Claude Code, along with
    // the translated `tools:` list only that CLI can express.
    const claudeArgv = await fakeClaude.argv(RUN_INVOCATION);
    expect(
      claudeArgv.slice(
        claudeArgv.indexOf("--model"),
        claudeArgv.indexOf("--model") + 2,
      ),
    ).toEqual(["--model", "opus"]);
    expect(
      claudeArgv.slice(
        claudeArgv.indexOf("--allowedTools"),
        claudeArgv.indexOf("--allowedTools") + 2,
      ),
    ).toEqual(["--allowedTools", "Read,Grep"]);

    // Usage keeps each backend's own model identity, per task.
    const byModel = usage.breakdownBy("model");
    expect([...byModel.keys()].sort()).toEqual(["gpt-5.1", "opus"]);
    expect(byModel.get("gpt-5.1")?.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
    });
    expect(byModel.get("opus")?.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
    });
    expect(byModel.get("gpt-5.1")?.tasks).toContain("T01");
    expect(byModel.get("opus")?.tasks).toContain("T02");
  });

  it("describes each agent with the model its own backend would run", async () => {
    await writeScriptedCli(claudeDir, "claude-code", [CLAUDE_REPLY]);
    await writeScriptedCli(codexDir, "codex", [CODEX_REPLY]);
    process.env.PATH = `${claudeDir}:${codexDir}:${originalPath ?? ""}`;

    const project = mixedProject(
      {
        lead: { provider: "anthropic", model: "opus", backend: "claude-code" },
        worker: { provider: "openai", model: "gpt-5.1", backend: "codex" },
      },
      [agent("reviewer", "lead"), agent("coder", "worker")],
    );

    const executor = await defaultExecutorFactory(
      factoryArgs(project, "claude-code", new UsageTracker()),
    );

    expect(executor.describeAgent?.("coder")).toEqual({ model: "gpt-5.1" });
    expect(executor.describeAgent?.("reviewer")).toEqual({ model: "opus" });
  });

  it("only probes the backends the project can actually route to", async () => {
    await writeScriptedCli(claudeDir, "claude-code", [CLAUDE_REPLY]);
    await writeScriptedCli(codexDir, "codex", [CODEX_REPLY]);
    process.env.PATH = `${claudeDir}:${codexDir}:${originalPath ?? ""}`;
    // Keeps the native branch's credential resolution off the `ant`
    // subprocess; nothing here ever calls a provider.
    process.env.ANTHROPIC_API_KEY = "test-key";

    const project = mixedProject(
      {
        lead: { provider: "anthropic", model: "opus", backend: "claude-code" },
        // Untagged: the coder runs on the run's own backend, which is native.
        worker: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      [agent("reviewer", "lead"), agent("coder", "worker")],
    );

    await defaultExecutorFactory(
      factoryArgs(project, "native", new UsageTracker()),
    );

    // The fakes count every invocation they get, probes included: Claude Code
    // is referenced and was probed, Codex is not and was never run at all.
    expect(existsSync(path.join(claudeDir, "count"))).toBe(true);
    expect(existsSync(path.join(codexDir, "count"))).toBe(false);
  });

  it("keeps a project whose aliases name one backend on the single-backend path", async () => {
    const fakeClaude = await writeScriptedCli(claudeDir, "claude-code", [
      CLAUDE_REPLY,
    ]);
    process.env.PATH = `${claudeDir}:${originalPath ?? ""}`;

    const project = mixedProject(
      {
        lead: { provider: "anthropic", model: "opus", backend: "claude-code" },
      },
      [agent("reviewer", "lead")],
    );

    const executor = await defaultExecutorFactory(
      factoryArgs(project, "claude-code", new UsageTracker()),
    );

    // Not a dispatcher: one backend means the executor the run has always
    // built, straight through.
    expect(executor).toBeInstanceOf(ClaudeCodeWorkerExecutor);
    const result = await executor.execute(mutatingTask("T01"), "reviewer");
    expect(result.summary).toContain("claude code did the task");
    expect(await fakeClaude.argv(RUN_INVOCATION)).toContain("opus");
  });
});

describe("kapel orchestrate", () => {
  let workspace: string;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    workspace = await makeWorkspace("cli-orchestrate-test-");
    await copyTemplateAgentDir(workspace);
    await writeLock(workspace, ROUTING_POLICY);
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    await cleanupWorkspace(workspace);
  });

  it("fans independent tasks out to the agents the policy routes them to", async () => {
    const executor = new ScriptedExecutor();
    const stream = new CapturingStream();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(stream.asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(0);

    // The acceptance criterion: independent tasks reached *different*
    // configured workers, and did so concurrently.
    const byTask = new Map(
      executor.calls.map((call) => [call.taskId, call.agent]),
    );
    expect(byTask.get("T01")).toBe("explorer");
    expect(byTask.get("T02")).toBe("coder");
    expect(byTask.get("T03")).toBe("reviewer");
    expect(new Set(byTask.values()).size).toBe(3);
    expect(executor.maxInFlight).toBeGreaterThanOrEqual(2);

    // T03 depends on T02, so it can only have started after T02 finished.
    const order = executor.calls.map((call) => call.taskId);
    expect(order.indexOf("T03")).toBe(2);

    const rendered = stream.lines.join("\n");
    expect(rendered).toContain(
      "▶ T01 → explorer (rule: route-explore, attempt 1)",
    );
    expect(rendered).toContain("▶ T02 → coder (rule: route-impl, attempt 1)");
    expect(rendered).toContain("✔ T03 — T03 done by reviewer");

    const summary = lines.join("\n");
    expect(summary).toContain("STATUS");
    expect(summary).toContain("completed  T01  explorer");
    expect(summary).toContain("3/3 tasks completed");
    expect(summary).toContain("tokens —");
  });

  it("hands the project's handoff guidance to the executor factory", async () => {
    // The shipped template *is* the built-in guidance, so a run over an
    // untouched `kapel init` workspace must see exactly the defaults.
    let fromTemplate: ExecutorFactoryArgs["project"] | undefined;
    const executor = new ScriptedExecutor();
    const { output } = capture();

    await runOrchestrate("add a health endpoint", options(workspace), {
      output,
      renderer: new TextRenderer(new CapturingStream().asStream()),
      plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
      executorFactory: (args) => {
        fromTemplate = args.project;
        return executor;
      },
    });

    expect(fromTemplate?.handoff?.worker).toBe(DEFAULT_WORKER_GUIDANCE);
    expect(fromTemplate?.handoff?.common).toBe(WORKER_SYSTEM_POSTAMBLE);
    expect(fromTemplate?.handoff?.warnings).toEqual([]);

    // And an edited file replaces only the sections it names.
    await writeFile(
      path.join(workspace, ".agent", "handoff.md"),
      "## worker\n\nHouse rule: no new dependencies.\n",
      "utf8",
    );
    let edited: ExecutorFactoryArgs["project"] | undefined;
    await runOrchestrate("add a health endpoint", options(workspace), {
      output,
      renderer: new TextRenderer(new CapturingStream().asStream()),
      plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
      executorFactory: (args) => {
        edited = args.project;
        return new ScriptedExecutor();
      },
    });

    expect(edited?.handoff?.worker).toBe("House rule: no new dependencies.");
    expect(edited?.handoff?.common).toBeUndefined();
  });

  it("notes an unrecognised handoff heading without failing the run", async () => {
    await writeFile(
      path.join(workspace, ".agent", "handoff.md"),
      "## wroker\n\nTypo.\n",
      "utf8",
    );
    const { output, errLines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);
    expect(errLines.join("\n")).toContain('unknown section "## wroker"');
  });

  it("fails the run and cancels dependents when a task fails", async () => {
    const executor = new ScriptedExecutor(new Set(["T02"]));
    const stream = new CapturingStream();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(stream.asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(1);
    expect(executor.calls.map((call) => call.taskId)).not.toContain("T03");

    const rendered = stream.lines.join("\n");
    expect(rendered).toContain("✖ T02 — T02 blew up");
    expect(rendered).toContain("⊘ T03 (dependency-failed)");

    const summary = lines.join("\n");
    expect(summary).toContain("failed     T02");
    expect(summary).toContain("cancelled  T03");
    expect(summary).toContain("1/3 tasks completed");
  });

  it("--dry-run prints the plan and runs no tasks", async () => {
    const executor = new ScriptedExecutor();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { dryRun: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(0);
    expect(executor.calls).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("Objective: add a health endpoint");
    expect(text).toContain("ID   TYPE");
    expect(text).not.toContain("tasks completed");
  });

  it("emits a run.summary line in --json mode", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { json: true }),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.type).toBe("run.summary");
    expect(parsed.ok).toBe(true);
    expect(parsed.tasks.map((entry: { agent: string }) => entry.agent)).toEqual(
      ["explorer", "coder", "reviewer"],
    );

    // The per-agent table, orchestrator first: the template's "lead" agent
    // planned the run, then each routed worker that actually ran gets a row.
    expect(
      parsed.agents.map((entry: { agent: string }) => entry.agent),
    ).toEqual(["lead", "explorer", "coder", "reviewer"]);
    const [lead, explorer] = parsed.agents;
    expect(lead.role).toBe("orchestrator");
    expect(lead.tasksPlanned).toBe(3);
    expect(lead.did).toBe("add a health endpoint");
    expect(explorer.role).toBe("worker");
    expect(explorer.tasksCompleted).toBe(1);
    expect(explorer.tasksFailed).toBe(0);
    expect(explorer.did).toBe("Survey the server");
  });

  it("reports an executor that cannot be built, without running anything", async () => {
    const { output, errLines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => {
          throw new Error("The Codex CLI is not installed.");
        },
      },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("The Codex CLI is not installed.");
  });

  it("refuses to run with worktree isolation outside a git repository", async () => {
    const executor = new ScriptedExecutor();
    const { output, errLines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree" }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain("--isolation none");
    // Fail fast: nothing was executed.
    expect(executor.calls).toEqual([]);
  });

  it("runs normally with worktree isolation when the workspace is a repository", async () => {
    await initRepo(workspace);
    const executor = new ScriptedExecutor();
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree" }),
      {
        output,
        renderer: new TextRenderer(new CapturingStream().asStream()),
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => executor,
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("3/3 tasks completed");
  });

  it("does not hold --dry-run to the isolation precondition", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree", dryRun: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Objective: add a health endpoint");
  });

  it("reports the isolation precondition through --json", async () => {
    const { output, lines } = capture();

    const code = await runOrchestrate(
      "add a health endpoint",
      options(workspace, { isolation: "worktree", json: true }),
      {
        output,
        plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
        executorFactory: () => new ScriptedExecutor(),
      },
    );

    expect(code).toBe(1);
    const parsed = JSON.parse(lines.at(-1) ?? "{}");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("--isolation none");
  });

  it("stops at the plan stage when the lock is stale", async () => {
    const bare = await makeWorkspace("cli-orchestrate-bare-");
    try {
      const { output, errLines } = capture();
      const code = await runOrchestrate(
        "add a health endpoint",
        options(bare),
        {
          output,
          plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
          executorFactory: () => new ScriptedExecutor(),
        },
      );
      expect(code).toBe(1);
      expect(errLines.join("\n")).toContain("kapel init");
    } finally {
      await cleanupWorkspace(bare);
    }
  });

  describe("run header validators note", () => {
    it("prints a validators note when the project has validators configured", async () => {
      await appendValidatorsConfig(workspace, [
        { name: "typecheck", command: "true" },
        { name: "test", command: "true" },
      ]);
      const { output, lines } = capture();

      const code = await runOrchestrate(
        "add a health endpoint",
        options(workspace),
        {
          output,
          renderer: new TextRenderer(new CapturingStream().asStream()),
          plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
          executorFactory: () => new ScriptedExecutor(),
        },
      );

      expect(code).toBe(0);
      expect(lines).toContain("validators: typecheck, test");
    });

    it("omits the note under --no-validate", async () => {
      await appendValidatorsConfig(workspace, [
        { name: "typecheck", command: "true" },
      ]);
      const { output, lines } = capture();

      const code = await runOrchestrate(
        "add a health endpoint",
        options(workspace, { validate: false }),
        {
          output,
          renderer: new TextRenderer(new CapturingStream().asStream()),
          plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
          executorFactory: () => new ScriptedExecutor(),
        },
      );

      expect(code).toBe(0);
      expect(lines.some((line) => line.startsWith("validators:"))).toBe(false);
    });

    it("omits the note under --backend codex even when validators are configured", async () => {
      await appendValidatorsConfig(workspace, [
        { name: "typecheck", command: "true" },
      ]);
      const { output, lines } = capture();

      const code = await runOrchestrate(
        "add a health endpoint",
        options(workspace, { backend: "codex" }),
        {
          output,
          renderer: new TextRenderer(new CapturingStream().asStream()),
          plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
          // Both injections bypass the real codex-availability probes — the
          // planner's and the executor's — entirely; this test is only about
          // the header note.
          delegatedPlannerFactory: fixedDelegatedPlannerFactory(SAMPLE_PLAN),
          executorFactory: () => new ScriptedExecutor(),
        },
      );

      expect(code).toBe(0);
      expect(lines.some((line) => line.startsWith("validators:"))).toBe(false);
    });

    it("omits the note when the project has no validators configured", async () => {
      const { output, lines } = capture();

      const code = await runOrchestrate(
        "add a health endpoint",
        options(workspace),
        {
          output,
          renderer: new TextRenderer(new CapturingStream().asStream()),
          plannerFactory: fixedPlannerFactory(SAMPLE_PLAN),
          executorFactory: () => new ScriptedExecutor(),
        },
      );

      expect(code).toBe(0);
      expect(lines.some((line) => line.startsWith("validators:"))).toBe(false);
    });
  });
});

describe("runSummaryLines", () => {
  const catalog = defaultModelCatalog();

  function model(id: string): ModelDefinition {
    const found = catalog[id];
    if (found === undefined) throw new Error(`${id} missing from catalog`);
    return found;
  }

  function runtimeTask(id: string, agent: string): RuntimeTask {
    return {
      spec: task(id, { title: `Task ${id}` }),
      status: "completed",
      assignedAgent: agent,
      attempts: 1,
    };
  }

  const SUMMARY_POLICY: OrchestrationPolicy = {
    ...ROUTING_POLICY,
    orchestrator: "lead",
  };

  /** A {@link RunSummaryContext} for tests that don't care about role lookups. */
  function summaryContext(
    overrides: Partial<RunSummaryContext> = {},
  ): RunSummaryContext {
    return {
      objective: "add a health endpoint",
      policy: SUMMARY_POLICY,
      project: emptyProject(),
      ...overrides,
    };
  }

  /** A three-task run: an expensive planner, a cheap worker, one review. */
  function threeTaskRun(): { tasks: RuntimeTask[]; usage: UsageTracker } {
    const usage = new UsageTracker();
    usage.record(
      model("claude-opus-5"),
      { inputTokens: 12_345, outputTokens: 2_100 },
      { agent: "planner" },
    );
    for (const [id, agent] of [
      ["T01", "explorer"],
      ["T02", "coder"],
      ["T03", "reviewer"],
    ] as const) {
      usage.record(
        model("claude-haiku-4-5"),
        { inputTokens: 10_000, outputTokens: 2_000 },
        { agent, taskId: id },
      );
    }
    return {
      tasks: [
        runtimeTask("T01", "explorer"),
        runtimeTask("T02", "coder"),
        runtimeTask("T03", "reviewer"),
      ],
      usage,
    };
  }

  it("puts the model, tokens and cost of each task in the table", () => {
    const { tasks, usage } = threeTaskRun();
    const lines = runSummaryLines(tasks, usage, summaryContext());

    expect(lines[1]).toBe(
      "STATUS     ID   AGENT     TRIES  MODEL             TOKENS      $      TITLE",
    );
    expect(lines[2]).toBe(
      "completed  T01  explorer  1      claude-haiku-4-5  10.0k/2.0k  $0.02  Task T01",
    );
  });

  it("rolls the run up per model, then reports the grand total", () => {
    const { tasks, usage } = threeTaskRun();
    const lines = runSummaryLines(tasks, usage, summaryContext());

    expect(lines).toContain("3/3 tasks completed");
    // The model rollup and grand total still close the report, after the
    // per-agent table.
    expect(lines.slice(-3)).toEqual([
      // Planning is attributed to the model that did it, and to no task.
      "claude-opus-5: 0 tasks · 12.3k in / 2.1k out · $0.11",
      "claude-haiku-4-5: 3 tasks · 30.0k in / 6.0k out · $0.06",
      "tokens — input: 42345, output: 8100  (~$0.1742)",
    ]);
  });

  it("keeps the per-model rollup summing to the run total", () => {
    const { usage } = threeTaskRun();
    const byModel = [...usage.totalsBy("model").values()];
    const totals = usage.totals();

    expect(
      byModel.reduce((sum, entry) => sum + entry.usage.inputTokens, 0),
    ).toBe(totals.usage.inputTokens);
    expect(
      byModel.reduce((sum, entry) => sum + entry.usage.outputTokens, 0),
    ).toBe(totals.usage.outputTokens);
    expect(byModel.reduce((sum, entry) => sum + entry.costUsd, 0)).toBeCloseTo(
      totals.costUsd,
      10,
    );
  });

  it("shows a dash for a task nothing was recorded against", () => {
    const tasks = [runtimeTask("T01", "coder")];
    const lines = runSummaryLines(tasks, new UsageTracker(), summaryContext());

    expect(lines[2]).toBe(
      "completed  T01  coder  1      -      -       -  Task T01",
    );
    // Nothing spent, nothing to roll up: the total line still closes the report.
    expect(lines[lines.length - 1]).toBe("tokens — input: 0, output: 0");
  });

  it("shows real task counts for a delegated worker's recorded usage, not 0 tasks", () => {
    // What `workspaceExecutorFactory` wires into a `--backend codex` worker:
    // the sink `delegatedWorkerUsageSink` builds, fed exactly what
    // `recordDelegatedWorkerUsage` would pass it for one task attempt.
    const usage = new UsageTracker();
    const sink = delegatedWorkerUsageSink("codex", usage);
    sink.recorder.record(
      sink.modelFor(undefined),
      { inputTokens: 4_000, outputTokens: 900 },
      { agent: "coder", taskId: "T01" },
    );
    const lines = runSummaryLines(
      [runtimeTask("T01", "coder")],
      usage,
      summaryContext(),
    );

    expect(lines[2]).toBe(
      "completed  T01  coder  1      <codex default>  4.0k/900  n/a  Task T01",
    );
    // The bug this closes: a completed delegated run no longer rolls up as
    // "0 tasks" once the worker's usage carries the task id.
    expect(lines.at(-2)).toBe(
      "<codex default>: 1 task · 4.0k in / 900 out · n/a",
    );
  });

  it("reports tokens with n/a cost for a model that ships without prices", () => {
    const usage = new UsageTracker();
    usage.record(
      model("gpt-5.1"),
      { inputTokens: 4_000, outputTokens: 900 },
      { agent: "coder", taskId: "T01" },
    );
    const lines = runSummaryLines(
      [runtimeTask("T01", "coder")],
      usage,
      summaryContext(),
    );

    expect(lines[2]).toBe(
      "completed  T01  coder  1      gpt-5.1  4.0k/900  n/a  Task T01",
    );
    expect(lines.at(-2)).toBe("gpt-5.1: 1 task · 4.0k in / 900 out · n/a");
  });

  describe("per-agent summary table", () => {
    /** The agent table's header row, plus the rows below it up to the next blank line. */
    function agentTableRows(lines: readonly string[]): readonly string[] {
      const start = lines.findIndex((line) => line.startsWith("AGENT"));
      const end = lines.indexOf("", start);
      return lines.slice(start, end === -1 ? undefined : end);
    }

    it("puts the orchestrator first, then one row per worker that ran, role and spend included", () => {
      const { tasks, usage } = threeTaskRun();
      const project = projectWithRoles([
        projectAgent("lead", "orchestrator"),
        projectAgent("explorer", "worker"),
        projectAgent("coder", "worker"),
        projectAgent("reviewer", "reviewer"),
      ]);
      const lines = runSummaryLines(
        tasks,
        usage,
        summaryContext({ project, injectedReviews: ["T03"] }),
      );

      expect(agentTableRows(lines)).toEqual([
        "AGENT     ROLE          BACKEND·MODEL     TASKS                                DID                    TOKENS",
        "lead      orchestrator  claude-opus-5     planned 3 tasks · 1 review injected  add a health endpoint  12.3k/2.1k",
        "explorer  worker        claude-haiku-4-5  1 ok                                 Task T01               10.0k/2.0k",
        "coder     worker        claude-haiku-4-5  1 ok                                 Task T02               10.0k/2.0k",
        "reviewer  reviewer      claude-haiku-4-5  1 ok                                 Task T03               10.0k/2.0k",
      ]);
    });

    it("shows a dash for role, model and tokens when the project or the ledger has nothing to say", () => {
      const lines = runSummaryLines(
        [runtimeTask("T01", "coder")],
        new UsageTracker(),
        summaryContext(),
      );

      const rows = agentTableRows(lines);
      expect(rows[1]).toBe(
        "lead   -     -              planned 1 task  add a health endpoint  -",
      );
      expect(rows[2]).toBe(
        "coder  -     -              1 ok            Task T01               -",
      );
    });

    it("attributes an escalated task to the agent whose attempt completed it, not the one it started with", () => {
      const tasks: RuntimeTask[] = [
        {
          spec: task("T01", { title: "Fix the flaky test" }),
          status: "completed",
          assignedAgent: "senior",
          attempts: 2,
          lastEscalation: {
            rule: "junior-to-senior",
            from: "junior",
            to: "senior",
          },
        },
      ];
      const lines = runSummaryLines(
        tasks,
        new UsageTracker(),
        summaryContext(),
      );

      const rows = agentTableRows(lines);
      expect(rows.some((row) => row.startsWith("senior "))).toBe(true);
      expect(rows.find((row) => row.startsWith("senior "))).toContain("1 ok");
      // The agent it escalated away from never completed anything, so it gets
      // no row of its own.
      expect(rows.some((row) => row.startsWith("junior"))).toBe(false);
    });

    it("counts a task that failed under every agent it was tried with as failed, under the last one", () => {
      const tasks: RuntimeTask[] = [
        {
          spec: task("T01", { title: "Fix the flaky test" }),
          status: "failed",
          assignedAgent: "senior",
          attempts: 2,
        },
      ];
      const lines = runSummaryLines(
        tasks,
        new UsageTracker(),
        summaryContext(),
      );

      const rows = agentTableRows(lines);
      const seniorRow = rows.find((row) => row.startsWith("senior "));
      expect(seniorRow).toContain("1 failed");
      // Nothing completed, so there is nothing to name in DID.
      expect(seniorRow).toContain("-");
    });

    it("still renders coherently when every task is cancelled before any agent runs", () => {
      const tasks: RuntimeTask[] = [
        { spec: task("T01"), status: "cancelled", attempts: 0 },
        { spec: task("T02"), status: "cancelled", attempts: 0 },
      ];
      const lines = runSummaryLines(
        tasks,
        new UsageTracker(),
        summaryContext(),
      );

      // Only the orchestrator row: nothing was ever dispatched to a worker.
      expect(agentTableRows(lines)).toHaveLength(2);
      expect(agentTableRows(lines)[1]).toContain("planned 2 tasks");
    });
  });
});

describe("planningThrough", () => {
  const catalog = defaultModelCatalog();

  function plannerModel(): ModelDefinition {
    const found = catalog["claude-opus-5"];
    if (found === undefined) throw new Error("claude-opus-5 missing");
    return found;
  }

  /** A provider that reports usage without going anywhere near the network. */
  function fakeProvider(): ModelProvider {
    return {
      id: "fake",
      supports: () => true,
      stream: async function* () {
        yield {
          type: "usage",
          inputTokens: 12_345,
          outputTokens: 2_100,
        } satisfies ModelEvent;
        yield { type: "done", finishReason: "stop" } satisfies ModelEvent;
      },
    };
  }

  it("attributes what the planning call spent to the planner", async () => {
    const usage = new UsageTracker();
    let handed: ModelProvider | undefined;
    const factory = planningThrough(usage, (args) => {
      handed = args.provider;
      return { plan: async () => SAMPLE_PLAN };
    });

    const model = plannerModel();
    factory({ provider: fakeProvider(), model, knownAgents: [] });
    if (handed === undefined) throw new Error("no provider was handed over");
    for await (const _event of handed.stream({ model, messages: [] })) {
      // drain
    }

    expect(usage.totals().usage).toEqual({
      inputTokens: 12_345,
      outputTokens: 2_100,
    });
    const byAgent = usage.breakdownBy("agent");
    expect([...byAgent.keys()]).toEqual([PLANNER_AGENT]);
    // Planning belongs to no task, so it never lands in a task row.
    expect([...usage.breakdownBy("task").keys()]).toEqual([UNATTRIBUTED]);
    expect(byAgent.get(PLANNER_AGENT)?.models).toEqual(["claude-opus-5"]);
  });
});

describe("delegatedPlanningThrough", () => {
  it("hands the delegated planner a sink tagged to the planner", async () => {
    const usage = new UsageTracker();
    let handed: Parameters<DelegatedPlannerFactory>[0] | undefined;
    const factory = delegatedPlanningThrough(usage, (args) => {
      handed = args;
      return { plan: async () => SAMPLE_PLAN };
    });

    factory({
      backend: "codex",
      workspacePath: "/tmp/does-not-matter",
      model: "gpt-5-codex",
      knownAgents: [],
    });

    if (handed?.usage === undefined)
      throw new Error("no usage sink handed over");
    // The model asked for is what the spend is labelled with — a delegating
    // CLI owns its own catalog, so this is the only honest identity, and it
    // carries no pricing.
    expect(handed.usage.model.id).toBe("gpt-5-codex");
    expect(handed.usage.model.provider).toBe("openai");
    expect(handed.usage.tags).toEqual({ agent: PLANNER_AGENT });

    // What the CLI reports lands in the run's ledger under the planner, so a
    // delegated run's summary is not silently missing the planning spend.
    handed.usage.recorder.record(
      handed.usage.model,
      { inputTokens: 900, outputTokens: 120 },
      handed.usage.tags,
    );
    expect(usage.totals().usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
    });
    // No pricing is claimed for a subscription CLI.
    expect(usage.totals().costUsd).toBe(0);
    expect([...usage.breakdownBy("agent").keys()]).toEqual([PLANNER_AGENT]);
    expect([...usage.breakdownBy("task").keys()]).toEqual([UNATTRIBUTED]);
  });

  it("names the CLI's own default when nothing named a model", () => {
    const usage = new UsageTracker();
    let handed: Parameters<DelegatedPlannerFactory>[0] | undefined;
    delegatedPlanningThrough(usage, (args) => {
      handed = args;
      return { plan: async () => SAMPLE_PLAN };
    })({
      backend: "claude-code",
      workspacePath: "/tmp/does-not-matter",
      knownAgents: [],
    });

    expect(handed?.usage?.model.id).toBe("<claude-code default>");
  });
});

describe("delegatedWorkerUsageSink", () => {
  it("records what a worker attempt reported, tagged by agent and task, with no pricing", () => {
    const usage = new UsageTracker();
    const sink = delegatedWorkerUsageSink("codex", usage);

    // The worker executor supplies the resolved model (or `undefined`) and the
    // agent/task tags per attempt — this is what it hands the sink.
    sink.recorder.record(
      sink.modelFor("gpt-5-codex"),
      { inputTokens: 900, outputTokens: 120 },
      { agent: "coder", taskId: "T01" },
    );

    expect(usage.totals().usage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
    });
    // No pricing is claimed for a subscription CLI, same as the planner's.
    expect(usage.totals().costUsd).toBe(0);
    const byTask = usage.breakdownBy("task");
    expect([...byTask.keys()]).toEqual(["T01"]);
    expect(byTask.get("T01")?.agents).toEqual(["coder"]);
    expect(byTask.get("T01")?.pricing).toBe("unknown");
  });

  it("names the CLI's own default when the task resolved no model", () => {
    const usage = new UsageTracker();
    const sink = delegatedWorkerUsageSink("claude-code", usage);

    expect(sink.modelFor(undefined).id).toBe("<claude-code default>");
    expect(sink.modelFor(undefined).provider).toBe("anthropic");
    expect(sink.modelFor("opus").id).toBe("opus");
  });
});
