import type { PersistedRunSummary } from "@agent/session";
import type { OrchestrationOutput } from "./plan.js";
import { consoleOutput, formatTable } from "./plan.js";
import {
  closeRunStore,
  isoTime,
  openExistingRunStore,
  sessionDbPathFor,
} from "./sessions.js";

/** How many runs `kapel runs` lists when `--limit` is not given. */
export const DEFAULT_RUNS_LIMIT = 20;

export interface RunsCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  /** Defaults to {@link DEFAULT_RUNS_LIMIT}. */
  readonly limit?: number;
}

export interface RunsCommandDeps {
  readonly output?: OrchestrationOutput;
}

const OBJECTIVE_WIDTH = 60;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * `<completed>/<total>` with whatever went wrong spelled out beside it.
 *
 * The total is only known once a plan was saved; before that the counts are
 * all the listing has, so the denominator falls back to how many tasks were
 * heard from at all.
 */
export function taskCountsCell(
  counts: PersistedRunSummary["taskCounts"],
): string {
  const seen = counts.completed + counts.failed + counts.cancelled;
  const total = counts.total ?? seen;
  const problems: string[] = [];
  if (counts.failed > 0) problems.push(`${counts.failed} failed`);
  if (counts.cancelled > 0) problems.push(`${counts.cancelled} cancelled`);
  const cell = `${counts.completed}/${total}`;
  return problems.length === 0 ? cell : `${cell} (${problems.join(", ")})`;
}

function summaryRow(run: PersistedRunSummary): readonly string[] {
  return [
    run.id,
    run.status,
    isoTime(run.createdAt),
    taskCountsCell(run.taskCounts),
    truncate(run.objective, OBJECTIVE_WIDTH),
  ];
}

/**
 * Implements `kapel runs`: the recorded runs of this workspace, newest first.
 *
 * A workspace with no session database is not an error — it is a workspace
 * that has not orchestrated anything yet (or has only ever run `--no-save`),
 * and the empty listing says so rather than failing.
 */
export async function runRunsCommand(
  options: RunsCommandOptions,
  deps: RunsCommandDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const store = openExistingRunStore(options.cwd);

  if (store === undefined) {
    if (options.json) output.log(JSON.stringify([]));
    else {
      output.log(
        `No runs recorded yet — nothing at ${sessionDbPathFor(options.cwd)}.`,
      );
    }
    return 0;
  }

  try {
    const runs = await store.listRuns({
      limit: options.limit ?? DEFAULT_RUNS_LIMIT,
    });

    if (options.json) {
      output.log(
        JSON.stringify(
          runs.map((run) => ({
            id: run.id,
            status: run.status,
            objective: run.objective,
            createdAt: run.createdAt,
            startedAt: isoTime(run.createdAt),
            taskCounts: run.taskCounts,
          })),
        ),
      );
      return 0;
    }

    if (runs.length === 0) {
      output.log("No runs recorded yet.");
      return 0;
    }

    for (const line of formatTable(
      ["ID", "STATUS", "STARTED", "TASKS", "OBJECTIVE"],
      runs.map(summaryRow),
    )) {
      output.log(line);
    }
    return 0;
  } finally {
    closeRunStore(store);
  }
}
