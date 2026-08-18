import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "../src/index.js";
import { defaultModelCatalog, UsageTracker } from "../src/index.js";
import { capabilities } from "./helpers.js";

const priced: ModelDefinition = {
  provider: "anthropic",
  id: "claude-opus-5",
  capabilities,
  pricing: { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 },
};

const noCacheRate: ModelDefinition = {
  provider: "openai",
  id: "gpt-priced",
  capabilities,
  pricing: { inputPerMTok: 2, outputPerMTok: 8 },
};

const unpriced: ModelDefinition = {
  provider: "openai",
  id: "gpt-unpriced",
  capabilities,
};

describe("UsageTracker", () => {
  it("starts empty", () => {
    const tracker = new UsageTracker();
    expect(tracker.totals()).toEqual({
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    });
    expect(tracker.byModel().size).toBe(0);
  });

  it("prices cached input at cachedInputPerMTok when provided", () => {
    const tracker = new UsageTracker();
    tracker.record(priced, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    // 5 (input) + 25 (output) + 0.5 (cached input)
    expect(tracker.totals().costUsd).toBeCloseTo(30.5, 10);
  });

  it("falls back to the input rate for cached input when no cached rate is set", () => {
    const tracker = new UsageTracker();
    tracker.record(noCacheRate, {
      inputTokens: 500_000,
      outputTokens: 250_000,
      cachedInputTokens: 500_000,
    });
    // 0.5*2 + 0.25*8 + 0.5*2 = 1 + 2 + 1
    expect(tracker.totals().costUsd).toBeCloseTo(4, 10);
  });

  it("charges nothing for models without pricing but still counts tokens", () => {
    const tracker = new UsageTracker();
    tracker.record(unpriced, { inputTokens: 9_000, outputTokens: 4_000 });
    expect(tracker.totals()).toEqual({
      usage: { inputTokens: 9_000, outputTokens: 4_000 },
      costUsd: 0,
    });
  });

  it("accumulates per model under a provider/id key and in the totals", () => {
    const tracker = new UsageTracker();
    tracker.record(priced, { inputTokens: 100_000, outputTokens: 10_000 });
    tracker.record(priced, {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cachedInputTokens: 20_000,
    });
    tracker.record(noCacheRate, { inputTokens: 1_000_000, outputTokens: 0 });
    tracker.record(unpriced, { inputTokens: 1_000, outputTokens: 1 });

    const byModel = tracker.byModel();
    expect([...byModel.keys()].sort()).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-priced",
      "openai/gpt-unpriced",
    ]);

    const opus = byModel.get("anthropic/claude-opus-5");
    expect(opus?.usage).toEqual({
      inputTokens: 200_000,
      outputTokens: 20_000,
      cachedInputTokens: 20_000,
    });
    // 0.2*5 + 0.02*25 + 0.02*0.5 = 1 + 0.5 + 0.01
    expect(opus?.costUsd).toBeCloseTo(1.51, 10);

    expect(byModel.get("openai/gpt-priced")?.costUsd).toBeCloseTo(2, 10);
    expect(byModel.get("openai/gpt-unpriced")?.costUsd).toBe(0);

    const totals = tracker.totals();
    expect(totals.usage).toEqual({
      inputTokens: 1_201_000,
      outputTokens: 20_001,
      cachedInputTokens: 20_000,
    });
    expect(totals.costUsd).toBeCloseTo(3.51, 10);
  });

  it("omits cachedInputTokens until a record supplies it", () => {
    const tracker = new UsageTracker();
    tracker.record(priced, { inputTokens: 1, outputTokens: 1 });
    expect(tracker.totals().usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    tracker.record(priced, {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
    });
    expect(tracker.totals().usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      cachedInputTokens: 0,
    });
  });

  it("returns a snapshot, not a live view", () => {
    const tracker = new UsageTracker();
    tracker.record(priced, { inputTokens: 1, outputTokens: 1 });
    const first = tracker.byModel();
    tracker.record(priced, { inputTokens: 1, outputTokens: 1 });
    expect(first.get("anthropic/claude-opus-5")?.usage.inputTokens).toBe(1);
    expect(
      tracker.byModel().get("anthropic/claude-opus-5")?.usage.inputTokens,
    ).toBe(2);
  });

  it("prices catalog entries with the published Claude rates", () => {
    const catalog = defaultModelCatalog();
    const opus5 = catalog["claude-opus-5"];
    if (opus5 === undefined)
      throw new Error("claude-opus-5 missing from catalog");
    const tracker = new UsageTracker();
    tracker.record(opus5, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    // $5 input + $25 output + $0.50 cache read
    expect(tracker.totals().costUsd).toBeCloseTo(30.5, 10);
  });
});
