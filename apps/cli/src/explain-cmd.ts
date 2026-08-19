import type {
  OrchestrationPolicy,
  PlannedTask,
  RoutingRule,
} from "@agent/coding-agent";
import { PolicyRouter } from "@agent/coding-agent";
import type { AgentEvent } from "@agent/protocol";
import type {
  PersistedRun,
  PersistedTaskResult,
  SqliteSessionStore,
} from "@agent/session";
import type { OrchestrationOutput } from "./plan.js";
import { consoleOutput } from "./plan.js";
import {
  closeRunStore,
  isoTime,
  openExistingRunStore,
  sessionDbPathFor,
} from "./sessions.js";

export interface ExplainCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  /** Which run to read the task from. Defaults to the most recent one. */
  readonly run?: string;
}

export interface ExplainCommandDeps {
  readonly output?: OrchestrationOutput;
}

/** Why the task ran where it ran, re-derived from the run's own policy snapshot. */
export interface RouteExplanation {
  /** The agent {@link PolicyRouter} picks for this task under this policy. */
  readonly agent: string;
  /** The routing rule that decided it, when one matched. */
  readonly rule?: string;
  /** What the router fell back to when no routing rule matched. */
  readonly fallback?: "suggestedAgent" | "orchestrator";
}

/** One digested line of a task's history. */
export interface ExplainEvent {
  readonly timestamp: number;
  readonly type: string;
  readonly detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "(no summary)";
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "(no summary)" : line;
}

/**
 * Whether a routing rule applies to a task.
 *
 * Mirrors the matching `PolicyRouter` does internally (an empty facet means
 * "any"); the router does not report *which* rule won, and re-deriving that is
 * the whole point of explaining a routing decision. The agent itself always
 * comes from the router, so a divergence here can only ever cost the rule id,
 * never mislead about who ran the task.
 */
function ruleMatches(rule: RoutingRule, task: PlannedTask): boolean {
  const matches = (
    expected: readonly string[],
    actual: string | readonly string[],
  ): boolean => {
    if (expected.length === 0) return true;
    const values = typeof actual === "string" ? [actual] : actual;
    return expected.some((value) => values.includes(value));
  };
  return (
    matches(rule.taskTypes, task.type) &&
    matches(rule.riskCategories, task.risk.categories) &&
    matches(rule.complexity, task.complexity)
  );
}

/** Hard rules first, then highest weight, then lowest id — the router's order. */
function winningRule(
  task: PlannedTask,
  policy: OrchestrationPolicy,
): RoutingRule | undefined {
  const candidates = (policy.routing ?? []).filter((rule) =>
    ruleMatches(rule, task),
  );
  const hard = candidates.filter((rule) => rule.strength === "hard");
  const pool = hard.length > 0 ? hard : candidates;
  return [...pool].sort((a, b) =>
    a.weight !== b.weight
      ? b.weight - a.weight
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  )[0];
}

export function explainRoute(
  task: PlannedTask,
  policy: OrchestrationPolicy,
): RouteExplanation {
  const agent = new PolicyRouter().route(task, policy);
  const rule = winningRule(task, policy);
  if (rule !== undefined) return { agent, rule: rule.id };
  return {
    agent,
    fallback:
      task.suggestedAgent === undefined ? "orchestrator" : "suggestedAgent",
  };
}

function routeSentence(route: RouteExplanation): string {
  if (route.rule !== undefined) {
    return `routed to ${route.agent} by rule ${route.rule}`;
  }
  return route.fallback === "suggestedAgent"
    ? `routed to ${route.agent} — no routing rule matched, so the plan's suggestedAgent was used`
    : `routed to ${route.agent} — no routing rule matched and the task suggested no agent, so it fell back to the policy's orchestrator`;
}

/**
 * The one-line meaning of an event in a task's history, or `undefined` for the
 * events (worker chatter, tool calls) that say nothing about the decisions
 * made *about* the task.
 */
export function digestEvent(event: AgentEvent): string | undefined {
  const data = isRecord(event.data) ? event.data : {};
  switch (event.type) {
    case "task.held": {
      const blocker = str(data.conflictsWith);
      return blocker === undefined
        ? "held — waiting for a free slot"
        : `held — serialized behind ${blocker} (their affected areas overlap)`;
    }
    case "task.started":
      return `started — agent ${str(data.agent) ?? "?"}, attempt ${num(data.attempt) ?? 1}`;
    case "task.escalated":
      return `escalated — ${str(data.from) ?? "(unassigned)"} → ${str(data.to) ?? "?"} by rule ${str(data.rule) ?? "?"}`;
    case "task.low_confidence": {
      const confidence = num(data.confidence) ?? 0;
      const threshold = num(data.threshold) ?? 0;
      const verdict =
        data.accepted === true ? "accepted (attempts exhausted)" : "redoing";
      return `low confidence — ${confidence.toFixed(2)} < ${threshold.toFixed(2)}, ${verdict}`;
    }
    case "validation.completed": {
      if (data.passed === true) return undefined;
      const exitCode = num(data.exitCode);
      return `validator failed — ${str(data.name) ?? "?"} (exit ${exitCode === undefined ? "unknown" : exitCode})`;
    }
    case "worktree.integrated": {
      if (data.merged === true) {
        const commit = str(data.commit);
        return `merged${commit === undefined ? "" : ` → ${commit.slice(0, 8)}`}`;
      }
      const files = Array.isArray(data.conflictFiles)
        ? data.conflictFiles.filter(
            (file): file is string => typeof file === "string",
          )
        : [];
      return files.length === 0
        ? `not merged — ${str(data.reason) ?? "unknown reason"}`
        : `not merged — conflicts in ${files.join(", ")}`;
    }
    case "task.completed": {
      const result = isRecord(data.result) ? data.result : {};
      const status = str(result.status) ?? "?";
      const retrying = data.final === false ? " (retrying)" : "";
      return `completed — ${status}: ${firstLine(result.summary)}${retrying}`;
    }
    case "task.cancelled":
      return `cancelled — ${str(data.reason) ?? "cancelled"}`;
    default:
      return undefined;
  }
}

export function digestEvents(
  events: readonly AgentEvent[],
): readonly ExplainEvent[] {
  const digest: ExplainEvent[] = [];
  for (const event of events) {
    const detail = digestEvent(event);
    if (detail === undefined) continue;
    digest.push({ timestamp: event.timestamp, type: event.type, detail });
  }
  return digest;
}

/** The run `--run` names, or the most recent one when it was omitted. */
async function resolveRun(
  store: SqliteSessionStore,
  runId: string | undefined,
): Promise<PersistedRun | undefined> {
  if (runId !== undefined) return store.getRun(runId);
  const [latest] = await store.listRuns({ limit: 1 });
  return latest === undefined ? undefined : store.getRun(latest.id);
}

function renderText(
  output: OrchestrationOutput,
  run: PersistedRun,
  taskId: string,
  spec: PlannedTask | undefined,
  entry: PersistedTaskResult | undefined,
  route: RouteExplanation | undefined,
  digest: readonly ExplainEvent[],
): void {
  output.log(
    spec === undefined ? `Task ${taskId}` : `Task ${taskId} — ${spec.title}`,
  );
  output.log(
    `Run ${run.id} (started ${isoTime(run.createdAt)}, ${run.status})`,
  );
  const agent = entry?.agent ?? "(never dispatched)";
  const attempts = entry?.attempts ?? 0;
  const status = entry?.status ?? "unknown";
  output.log(
    `Agent: ${agent} — ${attempts} attempt${attempts === 1 ? "" : "s"}, ${status}`,
  );
  output.log(
    route === undefined
      ? "Routing: unavailable — this run has no saved plan to re-route from"
      : `Routing: ${routeSentence(route)}`,
  );

  output.log("");
  if (digest.length === 0) {
    output.log("No decisions were recorded for this task.");
    return;
  }
  for (const item of digest) {
    output.log(`${isoTime(item.timestamp)}  ${item.detail}`);
  }
}

/**
 * Implements `kapel explain <taskId>`: what happened to one task of one
 * recorded run, and why it ran where it did.
 */
export async function runExplainCommand(
  taskId: string,
  options: ExplainCommandOptions,
  deps: ExplainCommandDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const fail = (message: string): number => {
    if (options.json) output.log(JSON.stringify({ ok: false, error: message }));
    else output.error(message);
    return 1;
  };

  const store = openExistingRunStore(options.cwd);
  if (store === undefined) {
    return fail(
      `No runs recorded yet — nothing at ${sessionDbPathFor(options.cwd)}.`,
    );
  }

  try {
    const run = await resolveRun(store, options.run);
    if (run === undefined) {
      return fail(
        options.run === undefined
          ? "No runs recorded yet."
          : `Unknown run ${options.run}. Run \`kapel runs\` to see the recorded ones.`,
      );
    }

    const spec = run.plan?.tasks.find((task) => task.id === taskId);
    const results = await store.taskResults(run.id);
    const entry = results.get(taskId);
    const events = await store.taskEvents(run.id, taskId);

    if (spec === undefined && entry === undefined && events.length === 0) {
      const known = run.plan?.tasks.map((task) => task.id) ?? [
        ...results.keys(),
      ];
      return fail(
        `Run ${run.id} has no task ${taskId}.${known.length === 0 ? "" : ` Known tasks: ${known.join(", ")}.`}`,
      );
    }

    const route =
      spec === undefined ? undefined : explainRoute(spec, run.policy);
    const digest = digestEvents(events);

    if (options.json) {
      output.log(
        JSON.stringify({
          task: spec ?? { id: taskId },
          agent: entry?.agent ?? null,
          attempts: entry?.attempts ?? 0,
          status: entry?.status ?? null,
          run: { id: run.id, status: run.status, createdAt: run.createdAt },
          events: digest,
          route: route ?? null,
        }),
      );
      return 0;
    }

    renderText(output, run, taskId, spec, entry, route, digest);
    return 0;
  } finally {
    closeRunStore(store);
  }
}
