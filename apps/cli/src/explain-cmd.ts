import type { OrchestrationPolicy, PlannedTask } from "@agent/coding-agent";
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

/** A string worth printing: present and not empty. */
function str(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "(no summary)" : line;
}

/**
 * Re-derives why a task would route where it did, straight from
 * {@link PolicyRouter.decide} — the same decision the scheduler itself makes
 * (and, for a run recorded after `task.started` started carrying it, the same
 * one already sitting in that event's `routing` field). Re-derived rather
 * than read off the event because a task can be explained before it ever ran.
 */
export function explainRoute(
  task: PlannedTask,
  policy: OrchestrationPolicy,
): RouteExplanation {
  const decision = new PolicyRouter().decide(task, policy);
  if (decision.rule !== undefined) {
    return { agent: decision.agent, rule: decision.rule };
  }
  return {
    agent: decision.agent,
    fallback:
      decision.reason === "suggestedAgent" ? "suggestedAgent" : "orchestrator",
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
  switch (event.type) {
    case "task.held":
      return `held — serialized behind ${event.data.conflictsWith} (their affected areas overlap)`;
    case "task.started":
      return `started — agent ${event.data.agent}, attempt ${event.data.attempt}`;
    case "task.escalated":
      return `escalated — ${str(event.data.from) ?? "(unassigned)"} → ${event.data.to} by rule ${event.data.rule}`;
    case "task.low_confidence": {
      const { confidence, threshold } = event.data;
      const verdict =
        event.data.accepted === true
          ? "accepted (attempts exhausted)"
          : "redoing";
      return `low confidence — ${confidence.toFixed(2)} < ${threshold.toFixed(2)}, ${verdict}`;
    }
    case "validation.completed": {
      if (event.data.passed) return undefined;
      const exitCode = event.data.exitCode ?? "unknown";
      return `validator failed — ${event.data.name} (exit ${exitCode})`;
    }
    case "worktree.integrated": {
      if (event.data.merged) {
        const commit = str(event.data.commit);
        return `merged${commit === undefined ? "" : ` → ${commit.slice(0, 8)}`}`;
      }
      const files = event.data.conflictFiles ?? [];
      if (files.length > 0)
        return `not merged — conflicts in ${files.join(", ")}`;
      const reason = str(event.data.reason) ?? "unknown reason";
      const detail = str(event.data.detail);
      return detail === undefined
        ? `not merged — ${reason}`
        : `not merged — ${reason}: ${detail}`;
    }
    case "task.completed": {
      const { result } = event.data;
      const retrying = event.data.final ? "" : " (retrying)";
      return `completed — ${result.status}: ${firstLine(result.summary)}${retrying}`;
    }
    case "task.cancelled":
      return `cancelled — ${event.data.reason}`;
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
