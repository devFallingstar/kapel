import type { ModelDefinition, ModelPricing, ModelUsage, UsageRecorder } from "./index.js";

export interface UsageTotals {
  readonly usage: ModelUsage;
  readonly costUsd: number;
}

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  hasCached: boolean;
  costUsd: number;
}

const PER_MILLION = 1_000_000;

function newBucket(): Bucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    hasCached: false,
    costUsd: 0,
  };
}

/**
 * Cost of a single usage record.
 *
 * `inputTokens` and `cachedInputTokens` are treated as disjoint buckets:
 * cached input is billed at `cachedInputPerMTok` when the model provides one,
 * otherwise at the regular input rate. Models without pricing cost nothing.
 */
export function usageCostUsd(pricing: ModelPricing | undefined, usage: ModelUsage): number {
  if (pricing === undefined) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const total =
    usage.inputTokens * pricing.inputPerMTok +
    usage.outputTokens * pricing.outputPerMTok +
    cached * cachedRate;
  return total / PER_MILLION;
}

function toUsage(bucket: Bucket): ModelUsage {
  return {
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    ...(bucket.hasCached ? { cachedInputTokens: bucket.cachedInputTokens } : {}),
  };
}

/** Accumulates token usage and USD cost, overall and per model. */
export class UsageTracker implements UsageRecorder {
  readonly #byModel = new Map<string, Bucket>();
  readonly #total = newBucket();

  record(model: ModelDefinition, usage: ModelUsage): void {
    const key = `${model.provider}/${model.id}`;
    let bucket = this.#byModel.get(key);
    if (bucket === undefined) {
      bucket = newBucket();
      this.#byModel.set(key, bucket);
    }

    const cached = usage.cachedInputTokens ?? 0;
    const cost = usageCostUsd(model.pricing, usage);

    for (const target of [bucket, this.#total]) {
      target.inputTokens += usage.inputTokens;
      target.outputTokens += usage.outputTokens;
      target.cachedInputTokens += cached;
      target.hasCached = target.hasCached || usage.cachedInputTokens !== undefined;
      target.costUsd += cost;
    }
  }

  totals(): UsageTotals {
    return { usage: toUsage(this.#total), costUsd: this.#total.costUsd };
  }

  byModel(): ReadonlyMap<string, UsageTotals> {
    const out = new Map<string, UsageTotals>();
    for (const [key, bucket] of this.#byModel) {
      out.set(key, { usage: toUsage(bucket), costUsd: bucket.costUsd });
    }
    return out;
  }
}
