import type {
  RuntimeTask,
  TaskResult,
  WorkerAgentDescription,
  WorkerExecutor,
} from "@agent/orchestration";
import { describe, expect, it } from "vitest";
import type {
  AgentProject,
  AgentProjectConfig,
  ProjectBackendName,
} from "../../src/project/index.js";
import {
  createAgentBackendResolver,
  MixedBackendWorkerExecutor,
  referencedBackends,
} from "../../src/workers/mixed-executor.js";
import {
  makeProjectAgent,
  makeRuntimeTask,
  makeTaskResult,
} from "./test-helpers.js";

/** An {@link AgentProject} with a caller-supplied `models` map and agent list. */
function makeProjectWithModels(
  models: AgentProjectConfig["models"],
  agents = [
    makeProjectAgent({ name: "coder", modelAlias: "worker" }),
    makeProjectAgent({ name: "reviewer", modelAlias: "review" }),
    makeProjectAgent({ name: "unaliased", modelAlias: "ghost-alias" }),
  ],
): AgentProject {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const config: AgentProjectConfig = {
    models,
    agentSlots: {},
    validators: [],
    permission: {},
  };
  return {
    root: "/virtual/.agent",
    config,
    agents,
    orchestrationMarkdown: undefined,
    handoff: undefined,
    knownAgentNames: () => new Set(byName.keys()),
    agent: (name: string) => byName.get(name),
  };
}

/** Records who it ran and answers `describeAgent` with a fixed model id. */
class TaggedExecutor implements WorkerExecutor {
  readonly calls: { taskId: string; agent: string }[] = [];

  constructor(readonly name: string) {}

  describeAgent(agent: string): WorkerAgentDescription | undefined {
    return { model: `${this.name}:${agent}` };
  }

  async execute(task: RuntimeTask, agent: string): Promise<TaskResult> {
    this.calls.push({ taskId: task.spec.id, agent });
    return makeTaskResult({
      taskId: task.spec.id,
      summary: `${this.name} ran ${agent}`,
    });
  }
}

/** A dispatcher over one {@link TaggedExecutor} per backend, plus the build log. */
function makeDispatcher(
  project: AgentProject,
  defaultBackend: ProjectBackendName,
): {
  readonly executor: MixedBackendWorkerExecutor;
  readonly built: ProjectBackendName[];
  readonly inner: Map<ProjectBackendName, TaggedExecutor>;
} {
  const built: ProjectBackendName[] = [];
  const inner = new Map<ProjectBackendName, TaggedExecutor>();
  const executor = new MixedBackendWorkerExecutor({
    resolveAgentBackend: createAgentBackendResolver(project),
    defaultBackend,
    createExecutor: (backend) => {
      built.push(backend);
      const created = new TaggedExecutor(backend);
      inner.set(backend, created);
      return created;
    },
  });
  return { executor, built, inner };
}

const MIXED_MODELS: AgentProjectConfig["models"] = {
  worker: { provider: "openai", model: "gpt-5.1", backend: "codex" },
  review: { provider: "anthropic", model: "opus", backend: "claude-code" },
};

describe("createAgentBackendResolver", () => {
  it("resolves a known agent's alias to the backend its models entry names", () => {
    const resolve = createAgentBackendResolver(
      makeProjectWithModels(MIXED_MODELS),
    );

    expect(resolve("coder")).toBe("codex");
    expect(resolve("reviewer")).toBe("claude-code");
  });

  it("returns undefined for an unknown agent, an unknown alias, or an untagged entry", () => {
    const resolve = createAgentBackendResolver(
      makeProjectWithModels({
        worker: { provider: "openai", model: "gpt-5.1" },
      }),
    );

    expect(resolve("ghost")).toBeUndefined();
    expect(resolve("unaliased")).toBeUndefined();
    expect(resolve("coder")).toBeUndefined();
  });
});

describe("referencedBackends", () => {
  it("is just the default for a project whose aliases name no backend", () => {
    const project = makeProjectWithModels({
      worker: { provider: "openai", model: "gpt-5.1" },
    });

    expect([...referencedBackends(project, "native")]).toEqual(["native"]);
  });

  it("collects every backend an agent can reach, default included", () => {
    const project = makeProjectWithModels(MIXED_MODELS);

    // `unaliased` resolves to nothing, so the default is reachable too.
    expect(referencedBackends(project, "native")).toEqual(
      new Set(["native", "codex", "claude-code"]),
    );
  });

  it("omits a backend only an unused alias names", () => {
    const project = makeProjectWithModels(
      {
        worker: { provider: "openai", model: "gpt-5.1", backend: "codex" },
        unused: { provider: "openai", model: "gpt-x", backend: "native" },
      },
      [makeProjectAgent({ name: "coder", modelAlias: "worker" })],
    );

    expect(referencedBackends(project, "claude-code")).toEqual(
      new Set(["claude-code", "codex"]),
    );
  });
});

describe("MixedBackendWorkerExecutor", () => {
  it("routes each agent's task to that agent's own backend", async () => {
    const { executor, inner } = makeDispatcher(
      makeProjectWithModels(MIXED_MODELS),
      "native",
    );

    const first = await executor.execute(
      makeRuntimeTask({ id: "T01" }),
      "coder",
    );
    const second = await executor.execute(
      makeRuntimeTask({ id: "T02" }),
      "reviewer",
    );

    expect(first.summary).toBe("codex ran coder");
    expect(second.summary).toBe("claude-code ran reviewer");
    expect(inner.get("codex")?.calls).toEqual([
      { taskId: "T01", agent: "coder" },
    ]);
    expect(inner.get("claude-code")?.calls).toEqual([
      { taskId: "T02", agent: "reviewer" },
    ]);
  });

  it("falls back to the run's backend for an agent that names none", async () => {
    const { executor, inner } = makeDispatcher(
      makeProjectWithModels(MIXED_MODELS),
      "native",
    );

    // "ghost" is not in the project at all; "unaliased" points at an alias
    // that is not in `models`. Both are the run's own backend's business.
    await executor.execute(makeRuntimeTask({ id: "T01" }), "ghost");
    await executor.execute(makeRuntimeTask({ id: "T02" }), "unaliased");

    expect(inner.get("native")?.calls).toEqual([
      { taskId: "T01", agent: "ghost" },
      { taskId: "T02", agent: "unaliased" },
    ]);
  });

  it("builds an inner executor once, and only for a backend it is asked for", async () => {
    const { executor, built } = makeDispatcher(
      makeProjectWithModels(MIXED_MODELS),
      "native",
    );

    expect(built).toEqual([]);

    await executor.execute(makeRuntimeTask({ id: "T01" }), "coder");
    await executor.execute(makeRuntimeTask({ id: "T02" }), "coder");
    executor.describeAgent("coder");

    // Three backends are configured; only Codex was ever routed to, and it
    // was constructed once across two tasks and a description.
    expect(built).toEqual(["codex"]);
  });

  it("answers describeAgent from the agent's own backend", () => {
    const { executor } = makeDispatcher(
      makeProjectWithModels(MIXED_MODELS),
      "native",
    );

    expect(executor.describeAgent("coder")).toEqual({
      model: "codex:coder",
    });
    expect(executor.describeAgent("reviewer")).toEqual({
      model: "claude-code:reviewer",
    });
    expect(executor.describeAgent("ghost")).toEqual({ model: "native:ghost" });
  });

  it("reports no description when the inner executor has none", () => {
    const executor = new MixedBackendWorkerExecutor({
      resolveAgentBackend: () => undefined,
      defaultBackend: "native",
      createExecutor: () => ({
        execute: () => Promise.reject(new Error("unreachable")),
      }),
    });

    expect(executor.describeAgent("coder")).toBeUndefined();
  });

  it("exposes the backend it would route an agent to", () => {
    const { executor } = makeDispatcher(
      makeProjectWithModels(MIXED_MODELS),
      "native",
    );

    expect(executor.backendFor("coder")).toBe("codex");
    expect(executor.backendFor("ghost")).toBe("native");
  });
});
