import { describe, expect, it } from "vitest";
import {
  buildProviders,
  buildRegistry,
  DEFAULT_MODEL_ALIAS,
  envVarForProvider,
  hasApiKey,
  listModels,
  resolveModelAlias,
} from "../src/models.js";

describe("resolveModelAlias", () => {
  it("prefers an explicit --model flag over everything else", () => {
    expect(resolveModelAlias({ AGENT_MODEL: "from-env" }, "from-flag")).toBe(
      "from-flag",
    );
  });

  it("falls back to AGENT_MODEL when no flag is given", () => {
    expect(resolveModelAlias({ AGENT_MODEL: "from-env" })).toBe("from-env");
  });

  it("falls back to the built-in default when neither is set", () => {
    expect(resolveModelAlias({})).toBe(DEFAULT_MODEL_ALIAS);
    expect(DEFAULT_MODEL_ALIAS).toBe("claude-sonnet-5");
  });

  it("treats an empty --model flag as absent", () => {
    expect(resolveModelAlias({ AGENT_MODEL: "from-env" }, "")).toBe("from-env");
  });

  it("treats an empty AGENT_MODEL as absent", () => {
    expect(resolveModelAlias({ AGENT_MODEL: "" })).toBe(DEFAULT_MODEL_ALIAS);
  });
});

describe("envVarForProvider", () => {
  it("maps known providers to their API key variable", () => {
    expect(envVarForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(envVarForProvider("openai")).toBe("OPENAI_API_KEY");
    expect(envVarForProvider("openai-compatible")).toBe("OPENAI_API_KEY");
  });

  it("returns undefined for unknown providers", () => {
    expect(envVarForProvider("mystery")).toBeUndefined();
  });
});

describe("buildProviders", () => {
  it("builds no providers when no API keys are set", () => {
    expect(buildProviders({})).toHaveLength(0);
  });

  it("builds one provider per configured API key", () => {
    const providers = buildProviders({
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: "sk-o",
    });
    expect(providers.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
  });

  it("ignores empty-string API keys", () => {
    expect(buildProviders({ ANTHROPIC_API_KEY: "" })).toHaveLength(0);
  });
});

describe("hasApiKey", () => {
  it("is true when the provider's env var is set and non-empty", () => {
    expect(hasApiKey({ ANTHROPIC_API_KEY: "sk-a" }, "anthropic")).toBe(true);
  });

  it("is false when unset, empty, or the provider is unknown", () => {
    expect(hasApiKey({}, "anthropic")).toBe(false);
    expect(hasApiKey({ ANTHROPIC_API_KEY: "" }, "anthropic")).toBe(false);
    expect(hasApiKey({ ANTHROPIC_API_KEY: "sk-a" }, "mystery")).toBe(false);
  });
});

describe("buildRegistry / listModels", () => {
  it("resolves a known alias once its provider's key is present", () => {
    const registry = buildRegistry({ ANTHROPIC_API_KEY: "sk-a" });
    const model = registry.get("claude-sonnet-5");
    expect(registry.providerFor(model).id).toBe("anthropic");
  });

  it("throws when the model's provider has no configured key", () => {
    const registry = buildRegistry({});
    const model = registry.get("claude-sonnet-5");
    expect(() => registry.providerFor(model)).toThrow();
  });

  it("reports key presence per alias", () => {
    const entries = listModels({ ANTHROPIC_API_KEY: "sk-a" });
    const sonnet = entries.find((e) => e.alias === "claude-sonnet-5");
    const gpt = entries.find((e) => e.alias === "gpt-5.1");
    expect(sonnet).toEqual({
      alias: "claude-sonnet-5",
      provider: "anthropic",
      hasKey: true,
    });
    expect(gpt).toEqual({
      alias: "gpt-5.1",
      provider: "openai",
      hasKey: false,
    });
  });

  it("lists every alias sorted", () => {
    const entries = listModels({});
    const aliases = entries.map((e) => e.alias);
    expect(aliases).toEqual([...aliases].sort());
    expect(aliases).toContain("claude-sonnet-5");
  });
});
