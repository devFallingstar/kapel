import { describe, expect, it } from "vitest";
import type {
  AgentProject,
  AgentProjectConfig,
} from "../../src/project/index.js";
import { createDelegatedModelResolver } from "../../src/workers/delegated-model.js";
import { makeProjectAgent } from "./test-helpers.js";

/** {@link AgentProject} with a caller-supplied `models` map, for resolver tests. */
function makeProjectWithModels(
  models: AgentProjectConfig["models"],
): AgentProject {
  const agents = [
    makeProjectAgent({ name: "coder", modelAlias: "worker" }),
    makeProjectAgent({ name: "reviewer", modelAlias: "review" }),
    makeProjectAgent({ name: "unaliased", modelAlias: "ghost-alias" }),
  ];
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const config: AgentProjectConfig = {
    models,
    agentSlots: {},
    validators: [],
  };
  return {
    root: "/virtual/.agent",
    config,
    agents,
    orchestrationMarkdown: undefined,
    knownAgentNames: () => new Set(byName.keys()),
    agent: (name: string) => byName.get(name),
  };
}

describe("createDelegatedModelResolver", () => {
  it("resolves a known agent's aliased model", () => {
    const project = makeProjectWithModels({
      worker: { provider: "openai", model: "gpt-5-codex" },
    });
    const resolve = createDelegatedModelResolver(project);

    expect(resolve("coder")).toBe("gpt-5-codex");
  });

  it("returns undefined for an unknown agent", () => {
    const project = makeProjectWithModels({
      worker: { provider: "openai", model: "gpt-5-codex" },
    });
    const resolve = createDelegatedModelResolver(project);

    expect(resolve("ghost")).toBeUndefined();
  });

  it("returns undefined when the agent's model alias has no entry in config.yaml", () => {
    const project = makeProjectWithModels({
      worker: { provider: "openai", model: "gpt-5-codex" },
    });
    const resolve = createDelegatedModelResolver(project);

    // "unaliased" points at "ghost-alias", which is absent from `models`.
    expect(resolve("unaliased")).toBeUndefined();
  });

  it('returns undefined when the configured model is the "default" sentinel', () => {
    const project = makeProjectWithModels({
      worker: { provider: "openai", model: "default" },
    });
    const resolve = createDelegatedModelResolver(project);

    expect(resolve("coder")).toBeUndefined();
  });

  it("passes through a model id unfiltered, regardless of provider", () => {
    const project = makeProjectWithModels({
      review: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    const resolve = createDelegatedModelResolver(project);

    expect(resolve("reviewer")).toBe("claude-sonnet-5");
  });
});
