import { describe, expect, it } from "vitest";
import type {
  ModelDefinition,
  ModelEvent,
  ModelProvider,
  UsageDimension,
} from "../src/index.js";
import {
  defaultModelCatalog,
  UNATTRIBUTED,
  UsageTracker,
  usageRecordingProvider,
} from "../src/index.js";
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

  it("keeps untagged records working and files them under (unattributed)", () => {
    const tracker = new UsageTracker();
    tracker.record(priced, { inputTokens: 10, outputTokens: 2 });

    expect([...tracker.totalsBy("model").keys()]).toEqual(["claude-opus-5"]);
    expect([...tracker.totalsBy("agent").keys()]).toEqual([UNATTRIBUTED]);
    expect([...tracker.totalsBy("task").keys()]).toEqual([UNATTRIBUTED]);
  });

  it("groups tagged records by agent and by task", () => {
    const tracker = new UsageTracker();
    tracker.record(
      priced,
      { inputTokens: 100_000, outputTokens: 0 },
      { agent: "orchestrator" },
    );
    tracker.record(
      noCacheRate,
      { inputTokens: 500_000, outputTokens: 0 },
      { agent: "coder", taskId: "T01" },
    );
    tracker.record(
      noCacheRate,
      { inputTokens: 500_000, outputTokens: 0 },
      { agent: "coder", taskId: "T02" },
    );

    const byAgent = tracker.totalsBy("agent");
    expect([...byAgent.keys()]).toEqual(["orchestrator", "coder"]);
    expect(byAgent.get("orchestrator")?.costUsd).toBeCloseTo(0.5, 10);
    expect(byAgent.get("coder")?.usage.inputTokens).toBe(1_000_000);
    expect(byAgent.get("coder")?.costUsd).toBeCloseTo(2, 10);

    const byTask = tracker.totalsBy("task");
    expect([...byTask.keys()]).toEqual([UNATTRIBUTED, "T01", "T02"]);
    expect(byTask.get("T01")?.usage.inputTokens).toBe(500_000);
  });

  it("reports which models, agents and tasks fed a bucket", () => {
    const tracker = new UsageTracker();
    tracker.record(
      priced,
      { inputTokens: 1, outputTokens: 1 },
      { agent: "coder", taskId: "T01" },
    );
    tracker.record(
      noCacheRate,
      { inputTokens: 1, outputTokens: 1 },
      { agent: "reviewer", taskId: "T01" },
    );

    const task = tracker.breakdownBy("task").get("T01");
    expect(task?.models).toEqual(["claude-opus-5", "gpt-priced"]);
    expect(task?.agents).toEqual(["coder", "reviewer"]);
    expect(task?.tasks).toEqual(["T01"]);
    expect(task?.samples).toBe(2);
    expect(task?.pricing).toBe("known");
  });

  it("honours a model tag over the model definition's own id", () => {
    const tracker = new UsageTracker();
    tracker.record(
      priced,
      { inputTokens: 4, outputTokens: 2 },
      { model: "claude-opus-5 (fast)" },
    );
    expect([...tracker.totalsBy("model").keys()]).toEqual([
      "claude-opus-5 (fast)",
    ]);
    // `byModel` is unchanged by tagging: it keys on the definition.
    expect([...tracker.byModel().keys()]).toEqual(["anthropic/claude-opus-5"]);
  });

  it("marks buckets whose price is unknown, or only partly known", () => {
    const tracker = new UsageTracker();
    tracker.record(
      unpriced,
      { inputTokens: 1_000, outputTokens: 100 },
      { agent: "coder", taskId: "T01" },
    );
    tracker.record(
      priced,
      { inputTokens: 1_000, outputTokens: 100 },
      { agent: "coder", taskId: "T02" },
    );

    const byTask = tracker.breakdownBy("task");
    expect(byTask.get("T01")?.pricing).toBe("unknown");
    // Unknown never means free: the cost is 0 only because none could be read.
    expect(byTask.get("T01")?.costUsd).toBe(0);
    expect(byTask.get("T02")?.pricing).toBe("known");
    expect(tracker.breakdownBy("agent").get("coder")?.pricing).toBe("partial");
  });

  it("keeps every breakdown summing to the grand total", () => {
    const tracker = new UsageTracker();
    tracker.record(
      priced,
      { inputTokens: 120_000, outputTokens: 3_000, cachedInputTokens: 40_000 },
      { agent: "orchestrator" },
    );
    tracker.record(
      noCacheRate,
      { inputTokens: 90_000, outputTokens: 12_000 },
      { agent: "coder", taskId: "T01" },
    );
    tracker.record(
      noCacheRate,
      { inputTokens: 30_000, outputTokens: 4_000 },
      { agent: "coder", taskId: "T02" },
    );
    tracker.record(
      unpriced,
      { inputTokens: 7_000, outputTokens: 500 },
      { agent: "reviewer", taskId: "T03" },
    );

    const totals = tracker.totals();
    const dimensions: readonly UsageDimension[] = ["model", "agent", "task"];
    for (const dimension of dimensions) {
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedInputTokens = 0;
      let costUsd = 0;
      for (const entry of tracker.totalsBy(dimension).values()) {
        inputTokens += entry.usage.inputTokens;
        outputTokens += entry.usage.outputTokens;
        cachedInputTokens += entry.usage.cachedInputTokens ?? 0;
        costUsd += entry.costUsd;
      }
      expect({
        dimension,
        inputTokens,
        outputTokens,
        cachedInputTokens,
      }).toEqual({
        dimension,
        inputTokens: totals.usage.inputTokens,
        outputTokens: totals.usage.outputTokens,
        cachedInputTokens: totals.usage.cachedInputTokens ?? 0,
      });
      expect(costUsd).toBeCloseTo(totals.costUsd, 10);
    }
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

  it("leaves catalog entries that ship without rates priced as unknown", () => {
    const catalog = defaultModelCatalog();
    const tracker = new UsageTracker();
    for (const [id, model] of Object.entries(catalog)) {
      tracker.record(
        model,
        { inputTokens: 1_000, outputTokens: 1_000 },
        {
          agent: id,
        },
      );
    }

    const byModel = tracker.breakdownBy("model");
    for (const [id, model] of Object.entries(catalog)) {
      const entry = byModel.get(id);
      expect(entry?.pricing).toBe(
        model.pricing === undefined ? "unknown" : "known",
      );
    }
    // Every Claude entry is priced; the OpenAI ones deliberately are not, and
    // must report `unknown` rather than a $0 that reads as "free".
    expect(byModel.get("gpt-5.1")?.pricing).toBe("unknown");
    expect(byModel.get("claude-haiku-4-5")?.pricing).toBe("known");
  });
});

describe("usageRecordingProvider", () => {
  const events: readonly ModelEvent[] = [
    { type: "text.delta", text: "hi" },
    { type: "usage", inputTokens: 1_000, outputTokens: 200 },
    {
      type: "usage",
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 8,
    },
    { type: "done", finishReason: "stop" },
  ];

  function fakeProvider(): ModelProvider {
    return {
      id: "fake",
      supports: () => true,
      stream: async function* () {
        for (const event of events) yield event;
      },
    };
  }

  async function drain(provider: ModelProvider): Promise<ModelEvent[]> {
    const seen: ModelEvent[] = [];
    for await (const event of provider.stream({
      model: priced,
      messages: [],
    })) {
      seen.push(event);
    }
    return seen;
  }

  it("records every usage event it passes through, tagged", async () => {
    const tracker = new UsageTracker();
    const wrapped = usageRecordingProvider(fakeProvider(), tracker, {
      agent: "planner",
    });

    expect(wrapped.id).toBe("fake");
    expect(await drain(wrapped)).toEqual(events);
    expect(tracker.totals().usage).toEqual({
      inputTokens: 1_500,
      outputTokens: 300,
      cachedInputTokens: 8,
    });
    expect([...tracker.totalsBy("agent").keys()]).toEqual(["planner"]);
    expect([...tracker.totalsBy("model").keys()]).toEqual(["claude-opus-5"]);
  });
});
