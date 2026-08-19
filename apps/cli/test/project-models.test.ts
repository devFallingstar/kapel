import type { AgentProject } from "@agent/coding-agent";
import { loadAgentProject } from "@agent/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectModelResolver,
  modelDefinitionFor,
} from "../src/project-models.js";
import {
  cleanupWorkspace,
  copyTemplateAgentDir,
  makeWorkspace,
} from "./orchestration-fixtures.js";

describe("modelDefinitionFor", () => {
  it("uses the catalog entry, with pricing, when provider and id both match", () => {
    const definition = modelDefinitionFor({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(definition.id).toBe("claude-sonnet-5");
    expect(definition.pricing?.inputPerMTok).toBe(3);
    expect(definition.capabilities.vision).toBe(true);
  });

  it("falls back to a minimal definition for a model the catalog doesn't know", () => {
    const definition = modelDefinitionFor({
      provider: "openai-compatible",
      model: "llama-4-70b",
    });
    expect(definition).toEqual({
      provider: "openai-compatible",
      id: "llama-4-70b",
      capabilities: {
        tools: true,
        reasoning: true,
        vision: false,
        structuredOutput: true,
      },
    });
  });

  it("does not inherit catalog pricing when the id matches under a different provider", () => {
    const definition = modelDefinitionFor({
      provider: "openai-compatible",
      model: "claude-sonnet-5",
    });
    expect(definition.provider).toBe("openai-compatible");
    expect(definition.pricing).toBeUndefined();
  });
});

describe("createProjectModelResolver", () => {
  let workspace: string;
  let project: AgentProject;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenAi = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    workspace = await makeWorkspace("cli-project-models-");
    await copyTemplateAgentDir(workspace);
    const loaded = await loadAgentProject(workspace);
    if (loaded === undefined) throw new Error("fixture project failed to load");
    project = loaded;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAi;
    await cleanupWorkspace(workspace);
  });

  it("resolves a configured alias to its provider and catalog definition", async () => {
    const resolve = await createProjectModelResolver(project, process.env);
    const resolved = resolve("worker");
    expect(resolved.model.id).toBe("claude-sonnet-5");
    expect(resolved.model.provider).toBe("anthropic");
    expect(resolved.provider.id).toBe("anthropic");
  });

  it("throws naming the alias and the known aliases when it isn't configured", async () => {
    const resolve = await createProjectModelResolver(project, process.env);
    expect(() => resolve("nope")).toThrow(/"nope"/);
    expect(() => resolve("nope")).toThrow(/cheap, lead, reviewer, worker/);
  });

  it("throws with the credential hint when the alias's provider isn't configured", async () => {
    const resolve = await createProjectModelResolver(project, process.env);
    // The template's "reviewer" alias is an OpenAI model, and OPENAI_API_KEY
    // is deliberately unset here.
    expect(() => resolve("reviewer")).toThrow(/"reviewer"/);
    expect(() => resolve("reviewer")).toThrow(/OPENAI_API_KEY/);
  });

  it("picks up a provider that becomes configured before the resolver is built", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const resolve = await createProjectModelResolver(project, process.env);
    const resolved = resolve("reviewer");
    expect(resolved.model.id).toBe("gpt-5.1");
    expect(resolved.provider.id).toBe("openai");
  });
});
