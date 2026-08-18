import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "../src/index.js";
import {
  AnthropicProvider,
  defaultModelCatalog,
  OpenAIProvider,
  StaticModelRegistry,
} from "../src/index.js";
import { capabilities } from "./helpers.js";

function registry(): StaticModelRegistry {
  return new StaticModelRegistry(defaultModelCatalog(), [
    new AnthropicProvider({ apiKey: "k" }),
    new OpenAIProvider({ apiKey: "sk" }),
  ]);
}

describe("StaticModelRegistry", () => {
  it("resolves known aliases", () => {
    const model = registry().get("claude-opus-5");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-opus-5");
    expect(model.pricing).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
    });
  });

  it("throws a helpful error for unknown aliases", () => {
    expect(() => registry().get("claude-nope")).toThrowError(
      /Unknown model alias "claude-nope"\. Known aliases: .*claude-opus-5/,
    );
  });

  it("picks the first provider that supports the model", () => {
    const reg = registry();
    expect(reg.providerFor(reg.get("claude-sonnet-5")).id).toBe("anthropic");
    expect(reg.providerFor(reg.get("gpt-5.1")).id).toBe("openai");
  });

  it("routes openai-compatible models to the OpenAI provider", () => {
    const local: ModelDefinition = {
      provider: "openai-compatible",
      id: "local-llm",
      capabilities,
    };
    expect(registry().providerFor(local).id).toBe("openai");
  });

  it("throws when no provider supports the model", () => {
    const orphan: ModelDefinition = {
      provider: "mystery",
      id: "m1",
      capabilities,
    };
    expect(() => registry().providerFor(orphan)).toThrowError(
      /No provider supports model "mystery\/m1"\. Registered providers: anthropic, openai/,
    );
  });
});

describe("defaultModelCatalog", () => {
  it("keys every entry by its model id and returns a fresh object", () => {
    const first = defaultModelCatalog();
    for (const [alias, model] of Object.entries(first)) {
      expect(alias).toBe(model.id);
      expect(model.capabilities).toEqual(capabilities);
    }
    expect(defaultModelCatalog()).not.toBe(first);
  });

  it("prices every Anthropic entry and leaves OpenAI entries unpriced", () => {
    for (const model of Object.values(defaultModelCatalog())) {
      if (model.provider === "anthropic") {
        expect(model.pricing?.inputPerMTok).toBeGreaterThan(0);
        expect(model.pricing?.outputPerMTok).toBeGreaterThan(0);
        expect(model.pricing?.cachedInputPerMTok).toBeCloseTo(
          (model.pricing?.inputPerMTok ?? 0) * 0.1,
          10,
        );
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxOutputTokens).toBeGreaterThan(0);
      } else {
        expect(model.pricing).toBeUndefined();
      }
    }
  });
});
