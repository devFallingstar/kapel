import type { ModelCapabilities, ModelDefinition } from "./index.js";

const FULL_CAPABILITIES: ModelCapabilities = {
  tools: true,
  reasoning: true,
  vision: true,
  structuredOutput: true,
};

/**
 * Anthropic cache-read tokens are billed at ~0.1x the regular input rate.
 * Cache *writes* are billed at ~1.25x input and are not modelled here — the
 * normalized {@link ModelUsage} shape only carries cache reads.
 */
function claude(
  id: string,
  inputPerMTok: number,
  outputPerMTok: number,
  contextWindow: number,
  maxOutputTokens: number,
): ModelDefinition {
  return {
    provider: "anthropic",
    id,
    contextWindow,
    maxOutputTokens,
    capabilities: FULL_CAPABILITIES,
    pricing: {
      inputPerMTok,
      outputPerMTok,
      cachedInputPerMTok: Number((inputPerMTok * 0.1).toFixed(4)),
    },
  };
}

const MILLION = 1_000_000;
const K128 = 128_000;

/**
 * Built-in model catalog, keyed by model id.
 *
 * Claude ids, context windows and prices are the Anthropic first-party API
 * rates. OpenAI entries deliberately ship **without** pricing — supply your own
 * {@link ModelPricing} (or override the whole entry) before relying on cost
 * accounting for them.
 */
export function defaultModelCatalog(): Readonly<
  Record<string, ModelDefinition>
> {
  return {
    // --- Anthropic -------------------------------------------------------
    "claude-fable-5": claude("claude-fable-5", 10, 50, MILLION, K128),
    "claude-opus-5": claude("claude-opus-5", 5, 25, MILLION, K128),
    "claude-opus-4-8": claude("claude-opus-4-8", 5, 25, MILLION, K128),
    "claude-opus-4-7": claude("claude-opus-4-7", 5, 25, MILLION, K128),
    "claude-opus-4-6": claude("claude-opus-4-6", 5, 25, MILLION, K128),
    // Sonnet 5 has promotional pricing of $2/$10 per MTok through 2026-08-31;
    // the standard rate below is what applies afterwards.
    "claude-sonnet-5": claude("claude-sonnet-5", 3, 15, MILLION, K128),
    "claude-sonnet-4-6": claude("claude-sonnet-4-6", 3, 15, MILLION, K128),
    "claude-haiku-4-5": claude("claude-haiku-4-5", 1, 5, 200_000, 64_000),

    // --- OpenAI ----------------------------------------------------------
    // No pricing shipped: OpenAI rates are not verified here. Override
    // `pricing` on these entries to get non-zero cost accounting.
    "gpt-5.1": {
      provider: "openai",
      id: "gpt-5.1",
      capabilities: FULL_CAPABILITIES,
    },
    "gpt-5-mini": {
      provider: "openai",
      id: "gpt-5-mini",
      capabilities: FULL_CAPABILITIES,
    },
    // Codex CLI models offered by the kapel wizard's pinned/recommended
    // lists (see `apps/cli/src/config.ts`). No pricing shipped, same as
    // every other OpenAI entry above.
    "sol-5.6": {
      provider: "openai",
      id: "sol-5.6",
      capabilities: FULL_CAPABILITIES,
    },
    "terra-5.6": {
      provider: "openai",
      id: "terra-5.6",
      capabilities: FULL_CAPABILITIES,
    },
    "luna-5.6": {
      provider: "openai",
      id: "luna-5.6",
      capabilities: FULL_CAPABILITIES,
    },
  };
}
