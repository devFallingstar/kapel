import { describe, expect, it } from "vitest";
import type { AnthropicCredential } from "../src/auth.js";
import {
  buildProviders,
  buildRegistry,
  credentialHintForProvider,
  DEFAULT_MODEL_ALIAS,
  envVarForProvider,
  formatAnthropicCredentialStatus,
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

describe("credentialHintForProvider", () => {
  it("mentions all three anthropic credential sources", () => {
    const hint = credentialHintForProvider("anthropic");
    expect(hint).toContain("ANTHROPIC_API_KEY");
    expect(hint).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(hint).toContain("ant auth login");
  });

  it("falls back to the plain env-var hint for other providers", () => {
    expect(credentialHintForProvider("openai")).toContain("OPENAI_API_KEY");
  });

  it("has a generic message for unknown providers", () => {
    expect(credentialHintForProvider("mystery")).toBe(
      'no provider is configured for "mystery"',
    );
  });
});

describe("formatAnthropicCredentialStatus", () => {
  it("shows the cross when no credential is present", () => {
    expect(formatAnthropicCredentialStatus(undefined)).toBe("✗");
  });

  it("labels an api-key credential", () => {
    const credential: AnthropicCredential = { kind: "api-key", apiKey: "sk-a" };
    expect(formatAnthropicCredentialStatus(credential)).toBe("api key");
  });

  it("labels an env-sourced auth token", () => {
    const credential: AnthropicCredential = {
      kind: "auth-token",
      authToken: "t",
      source: "env",
    };
    expect(formatAnthropicCredentialStatus(credential)).toBe("auth token");
  });

  it("labels an oauth-profile-sourced auth token", () => {
    const credential: AnthropicCredential = {
      kind: "auth-token",
      authToken: "t",
      source: "oauth-profile",
    };
    expect(formatAnthropicCredentialStatus(credential)).toBe("oauth (ant)");
  });
});

describe("buildProviders", () => {
  it("builds no providers when no credentials are set", async () => {
    expect(await buildProviders({}, { allowProfile: false })).toHaveLength(0);
  });

  it("builds one provider per configured credential", async () => {
    const providers = await buildProviders(
      { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" },
      { allowProfile: false },
    );
    expect(providers.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
  });

  it("ignores empty-string API keys", async () => {
    expect(
      await buildProviders({ ANTHROPIC_API_KEY: "" }, { allowProfile: false }),
    ).toHaveLength(0);
  });

  it("builds an anthropic provider from ANTHROPIC_AUTH_TOKEN when no api key is set", async () => {
    const providers = await buildProviders(
      { ANTHROPIC_AUTH_TOKEN: "t-env" },
      { allowProfile: false },
    );
    expect(providers.map((p) => p.id)).toEqual(["anthropic"]);
  });

  it("uses a pre-resolved anthropicCredential without touching the env", async () => {
    const providers = await buildProviders(
      {},
      {
        allowProfile: false,
        anthropicCredential: { kind: "api-key", apiKey: "sk-pre" },
      },
    );
    expect(providers.map((p) => p.id)).toEqual(["anthropic"]);
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
  it("resolves a known alias once its provider's key is present", async () => {
    const registry = await buildRegistry(
      { ANTHROPIC_API_KEY: "sk-a" },
      { allowProfile: false },
    );
    const model = registry.get("claude-sonnet-5");
    expect(registry.providerFor(model).id).toBe("anthropic");
  });

  it("throws when the model's provider has no configured key", async () => {
    const registry = await buildRegistry({}, { allowProfile: false });
    const model = registry.get("claude-sonnet-5");
    expect(() => registry.providerFor(model)).toThrow();
  });

  it("reports credential status per alias", async () => {
    const entries = await listModels(
      { ANTHROPIC_API_KEY: "sk-a" },
      { allowProfile: false },
    );
    const sonnet = entries.find((e) => e.alias === "claude-sonnet-5");
    const gpt = entries.find((e) => e.alias === "gpt-5.1");
    expect(sonnet).toEqual({
      alias: "claude-sonnet-5",
      provider: "anthropic",
      hasKey: true,
      credentialStatus: "api key",
    });
    expect(gpt).toEqual({
      alias: "gpt-5.1",
      provider: "openai",
      hasKey: false,
      credentialStatus: "✗",
    });
  });

  it("reports auth-token credential status", async () => {
    const entries = await listModels(
      { ANTHROPIC_AUTH_TOKEN: "t-env" },
      { allowProfile: false },
    );
    const sonnet = entries.find((e) => e.alias === "claude-sonnet-5");
    expect(sonnet?.credentialStatus).toBe("auth token");
    expect(sonnet?.hasKey).toBe(true);
  });

  it("reports the cross when no anthropic credential is available", async () => {
    const entries = await listModels({}, { allowProfile: false });
    const sonnet = entries.find((e) => e.alias === "claude-sonnet-5");
    expect(sonnet?.credentialStatus).toBe("✗");
    expect(sonnet?.hasKey).toBe(false);
  });

  it("lists every alias sorted", async () => {
    const entries = await listModels({}, { allowProfile: false });
    const aliases = entries.map((e) => e.alias);
    expect(aliases).toEqual([...aliases].sort());
    expect(aliases).toContain("claude-sonnet-5");
  });
});
