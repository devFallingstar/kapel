import type {
  ModelDefinition,
  ModelEvent,
  ModelPricing,
  ModelProvider,
  ModelUsage,
  UsageRecorder,
} from "./index.js";

export interface UsageTotals {
  readonly usage: ModelUsage;
  readonly costUsd: number;
}

/**
 * Attribution for one usage sample: who spent the tokens, and on what.
 *
 * Every field is optional because every call site knows a different subset —
 * the agent loop knows its agent and (inside a run) its task, a planner call
 * knows neither. Samples that carry no value for the dimension being grouped
 * are folded into {@link UNATTRIBUTED} rather than dropped, so a breakdown
 * always adds back up to {@link UsageTracker.totals}.
 *
 * `model` overrides the key the `"model"` dimension would otherwise derive
 * from the {@link ModelDefinition}; it exists for callers that route through
 * one definition but want the spend labelled with something more specific.
 */
export interface UsageTags {
  readonly model?: string;
  readonly agent?: string;
  readonly taskId?: string;
}

/** The axes usage can be attributed along — see {@link UsageTracker.totalsBy}. */
export type UsageDimension = "model" | "agent" | "task";

/** Bucket for samples that carry no value on the dimension being grouped. */
export const UNATTRIBUTED = "(unattributed)";

/**
 * How much of a bucket's cost is actually known.
 *
 * `"unknown"` means no sample in it came from a priced model — its `costUsd`
 * is 0 because nothing could be computed, *not* because the tokens were free,
 * and a renderer must say so (`$ n/a`) rather than print `$0.00`. `"partial"`
 * means some samples were priced and some were not, so `costUsd` is a lower
 * bound.
 */
export type UsagePricing = "known" | "partial" | "unknown";

/** One bucket of a breakdown: its totals, plus what fell into it. */
export interface UsageBreakdown extends UsageTotals {
  readonly key: string;
  readonly pricing: UsagePricing;
  /** The distinct model keys that contributed, sorted. */
  readonly models: readonly string[];
  /** The distinct agents that contributed, sorted. `UNATTRIBUTED` included. */
  readonly agents: readonly string[];
  /** The distinct task ids that contributed, sorted. `UNATTRIBUTED` included. */
  readonly tasks: readonly string[];
  /** How many `record` calls landed here. */
  readonly samples: number;
}

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  hasCached: boolean;
  costUsd: number;
}

/** One `(model, agent, task)` combination, the finest grain the tracker keeps. */
interface Cell {
  readonly model: string;
  readonly agent: string;
  readonly task: string;
  readonly bucket: Bucket;
  priced: number;
  unpriced: number;
}

const PER_MILLION = 1_000_000;

/** Separator for composite cell keys; never occurs in a model or agent name. */
const CELL_SEPARATOR = "\u0000";

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
export function usageCostUsd(
  pricing: ModelPricing | undefined,
  usage: ModelUsage,
): number {
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
    ...(bucket.hasCached
      ? { cachedInputTokens: bucket.cachedInputTokens }
      : {}),
  };
}

function addInto(target: Bucket, usage: ModelUsage, cost: number): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cachedInputTokens += usage.cachedInputTokens ?? 0;
  target.hasCached = target.hasCached || usage.cachedInputTokens !== undefined;
  target.costUsd += cost;
}

function pricingOf(priced: number, unpriced: number): UsagePricing {
  if (unpriced === 0) return "known";
  return priced === 0 ? "unknown" : "partial";
}

/** Accumulates token usage and USD cost, overall and per attribution axis. */
export class UsageTracker implements UsageRecorder {
  readonly #byModel = new Map<string, Bucket>();
  readonly #cells = new Map<string, Cell>();
  readonly #total = newBucket();

  /**
   * Folds one model turn in.
   *
   * `tags` is optional and purely additive: an untagged call still lands in
   * {@link totals} and {@link byModel} exactly as before, and shows up under
   * {@link UNATTRIBUTED} in the agent and task breakdowns.
   */
  record(model: ModelDefinition, usage: ModelUsage, tags?: UsageTags): void {
    const key = `${model.provider}/${model.id}`;
    let bucket = this.#byModel.get(key);
    if (bucket === undefined) {
      bucket = newBucket();
      this.#byModel.set(key, bucket);
    }

    const cost = usageCostUsd(model.pricing, usage);
    addInto(bucket, usage, cost);
    addInto(this.#total, usage, cost);

    const cell = this.#cellFor(model, tags);
    addInto(cell.bucket, usage, cost);
    if (model.pricing === undefined) cell.unpriced += 1;
    else cell.priced += 1;
  }

  #cellFor(model: ModelDefinition, tags: UsageTags | undefined): Cell {
    const attribution = {
      model: tags?.model ?? model.id,
      agent: tags?.agent ?? UNATTRIBUTED,
      task: tags?.taskId ?? UNATTRIBUTED,
    };
    const key = [attribution.model, attribution.agent, attribution.task].join(
      CELL_SEPARATOR,
    );
    let cell = this.#cells.get(key);
    if (cell === undefined) {
      cell = { ...attribution, bucket: newBucket(), priced: 0, unpriced: 0 };
      this.#cells.set(key, cell);
    }
    return cell;
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

  /**
   * Usage grouped along one attribution axis.
   *
   * Every sample lands in exactly one bucket of every dimension, so summing
   * any breakdown reproduces {@link totals} — that invariant is what makes the
   * per-model rollup in a run summary trustworthy. Buckets come back in
   * first-seen order.
   */
  totalsBy(dimension: UsageDimension): ReadonlyMap<string, UsageTotals> {
    const out = new Map<string, UsageTotals>();
    for (const [key, entry] of this.breakdownBy(dimension)) {
      out.set(key, { usage: entry.usage, costUsd: entry.costUsd });
    }
    return out;
  }

  /** {@link totalsBy} plus what each bucket is made of — see {@link UsageBreakdown}. */
  breakdownBy(dimension: UsageDimension): ReadonlyMap<string, UsageBreakdown> {
    interface Group {
      readonly bucket: Bucket;
      readonly models: Set<string>;
      readonly agents: Set<string>;
      readonly tasks: Set<string>;
      priced: number;
      unpriced: number;
    }

    const groups = new Map<string, Group>();
    for (const cell of this.#cells.values()) {
      const key =
        dimension === "model"
          ? cell.model
          : dimension === "agent"
            ? cell.agent
            : cell.task;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          bucket: newBucket(),
          models: new Set<string>(),
          agents: new Set<string>(),
          tasks: new Set<string>(),
          priced: 0,
          unpriced: 0,
        };
        groups.set(key, group);
      }
      addInto(group.bucket, toUsage(cell.bucket), cell.bucket.costUsd);
      group.models.add(cell.model);
      group.agents.add(cell.agent);
      group.tasks.add(cell.task);
      group.priced += cell.priced;
      group.unpriced += cell.unpriced;
    }

    const out = new Map<string, UsageBreakdown>();
    for (const [key, group] of groups) {
      out.set(key, {
        key,
        usage: toUsage(group.bucket),
        costUsd: group.bucket.costUsd,
        pricing: pricingOf(group.priced, group.unpriced),
        models: [...group.models].sort(),
        agents: [...group.agents].sort(),
        tasks: [...group.tasks].sort(),
        samples: group.priced + group.unpriced,
      });
    }
    return out;
  }
}

async function* teeUsage(
  source: AsyncIterable<ModelEvent>,
  model: ModelDefinition,
  recorder: UsageRecorder,
  tags: UsageTags | undefined,
): AsyncGenerator<ModelEvent> {
  for await (const event of source) {
    if (event.type === "usage") {
      recorder.record(
        model,
        {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: event.cachedInputTokens }),
        },
        tags,
      );
    }
    yield event;
  }
}

/**
 * Wraps a provider so every `usage` event it streams is also recorded, tagged.
 *
 * The agent loop records its own usage, but the one-shot model calls — the
 * planner, the policy compiler — have no loop around them and no recorder
 * option. Wrapping the provider they were handed attributes their spend
 * without either of them having to know that cost accounting exists.
 */
export function usageRecordingProvider(
  provider: ModelProvider,
  recorder: UsageRecorder,
  tags?: UsageTags,
): ModelProvider {
  return {
    id: provider.id,
    supports: (model) => provider.supports(model),
    stream: (request, signal) =>
      teeUsage(provider.stream(request, signal), request.model, recorder, tags),
  };
}
