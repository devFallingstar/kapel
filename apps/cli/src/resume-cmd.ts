import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentProject,
  ExecutionPlan,
  OrchestrationPolicy,
  TaskResult,
} from "@agent/coding-agent";
import {
  checkLock,
  loadAgentProject,
  ProjectConfigError,
  TaskGraph,
} from "@agent/coding-agent";
import type { SqliteSessionStore } from "@agent/session";
import { reconstructRun } from "@agent/session";
import type { BackendName } from "./backend.js";
import { loadDotEnvFile } from "./env.js";
import type {
  IsolationMode,
  RunOrchestrateDeps,
  WorkerMode,
} from "./orchestrate.js";
import {
  DEFAULT_ISOLATION,
  executePreparedPlan,
  tuiJsonConflict,
  worktreeIsolationError,
} from "./orchestrate.js";
import { consoleOutput } from "./plan.js";
import {
  closeRunStore,
  openExistingRunStore,
  sessionDbPathFor,
} from "./sessions.js";

export interface ResumeCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly workerMode: WorkerMode;
  readonly backend: BackendName;
  /** Defaults to {@link DEFAULT_ISOLATION} when the caller omits it. */
  readonly isolation?: IsolationMode;
  readonly timeoutSeconds?: number;
  readonly maxIterations?: number;
  readonly validate?: boolean;
  readonly tui?: boolean;
}

export type ResumeCommandDeps = RunOrchestrateDeps;

const LOCK_FILE_NAME = "orchestration.lock.json";

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** JSON with object keys sorted, so two equal policies serialize identically. */
function stableJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (typeof input !== "object" || input === null) return input;
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) out[key] = sort(item);
    return out;
  };
  return JSON.stringify(sort(value));
}

/**
 * Whether the project's policy has moved on since this run started, phrased
 * for the user.
 *
 * A resume deliberately runs under the policy snapshot recorded with the run,
 * not under the current lock: the tasks being finished were planned, routed
 * and reviewed under the old constraints, and swapping the rules half way
 * through would produce a run that never existed under any one policy. That
 * makes drift something to *report*, not something to act on — the way to
 * apply a new policy is a new `agent orchestrate`.
 */
export async function policyDriftWarning(
  project: AgentProject,
  snapshot: OrchestrationPolicy,
): Promise<string | undefined> {
  const markdown = project.orchestrationMarkdown ?? "";
  const raw = await readOptionalFile(path.join(project.root, LOCK_FILE_NAME));
  const status = checkLock(markdown, raw);
  const tail =
    "Resuming under the policy snapshot recorded with the run — start a new `agent orchestrate` to plan under the current one.";

  if (!status.fresh) {
    return `Warning: this project's policy lock is ${status.reason} (\`agent policy compile\` would refresh it). ${tail}`;
  }
  if (stableJson(status.lock.policy) !== stableJson(snapshot)) {
    return `Warning: this project's policy has changed since run started. ${tail}`;
  }
  return undefined;
}

/**
 * Rebuilds the run's task graph with its finished work already in place.
 *
 * The scheduler only ever dispatches `pending`/`ready` tasks whose
 * dependencies are `completed`, so pre-marking successes is all it takes for a
 * resumed run to pick up exactly where it stopped — the same mutation the
 * scheduler itself performs when a task succeeds, applied ahead of time.
 * Failed and cancelled tasks are deliberately left pending: those are the ones
 * a resume exists to try again.
 */
export async function rebuildGraph(
  store: SqliteSessionStore,
  runId: string,
  plan: ExecutionPlan,
  completed: ReadonlyMap<string, TaskResult>,
): Promise<TaskGraph> {
  const graph = new TaskGraph(plan);
  const persisted = await store.taskResults(runId);

  for (const task of graph.all()) {
    const result = completed.get(task.spec.id);
    if (result === undefined) continue;
    task.status = "completed";
    task.result = result;
    const entry = persisted.get(task.spec.id);
    if (entry !== undefined) {
      task.attempts = entry.attempts;
      if (entry.agent !== undefined) task.assignedAgent = entry.agent;
    }
  }
  return graph;
}

/**
 * Implements `agent resume <runId>`: re-execute the tasks a recorded run never
 * finished, appending to that run's own history.
 */
export async function runResume(
  runId: string,
  options: ResumeCommandOptions,
  deps: ResumeCommandDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const workspacePath = path.resolve(options.cwd);
  const isolation = options.isolation ?? DEFAULT_ISOLATION;

  const fail = (message: string): number => {
    if (options.json) output.log(JSON.stringify({ ok: false, error: message }));
    else output.error(message);
    return 1;
  };

  const conflict = tuiJsonConflict(options);
  if (conflict !== undefined) {
    output.error(conflict);
    return 1;
  }

  const store = openExistingRunStore(workspacePath);
  if (store === undefined) {
    return fail(
      `No runs recorded yet — nothing at ${sessionDbPathFor(workspacePath)}.`,
    );
  }

  try {
    const reconstruction = await reconstructRun(store, runId);
    if (reconstruction === undefined) {
      return fail(
        `Unknown run ${runId}. Run \`agent runs\` to see the recorded ones.`,
      );
    }

    const { run, completed, incompleteTaskIds } = reconstruction;
    const plan = run.plan;
    if (plan === undefined) {
      return fail(
        `Run ${run.id} has no saved plan — it never got past planning, so there is nothing to resume.`,
      );
    }
    if (incompleteTaskIds.length === 0) {
      const message = `Nothing to resume: all ${plan.tasks.length} tasks of run ${run.id} already completed.`;
      if (options.json) output.log(JSON.stringify({ ok: true, message }));
      else output.log(message);
      return 0;
    }

    await loadDotEnvFile(workspacePath);
    let project: AgentProject | undefined;
    try {
      project = await loadAgentProject(workspacePath);
    } catch (error) {
      if (error instanceof ProjectConfigError) return fail(error.message);
      throw error;
    }
    if (project === undefined) {
      return fail("No .agent directory found — run `agent init` first");
    }

    if (isolation === "worktree") {
      const problem = await worktreeIsolationError(workspacePath);
      if (problem !== undefined) return fail(problem);
    }

    const drift = await policyDriftWarning(project, run.policy);
    if (drift !== undefined) output.error(drift);

    const graph = await rebuildGraph(store, run.id, plan, completed);

    return await executePreparedPlan(
      {
        runId: run.id,
        objective: run.objective,
        project,
        workspacePath,
        // The run's own snapshot, not the current lock: see policyDriftWarning.
        policy: run.policy,
        plan,
        graph,
        store,
        leadLine: `Resuming run ${run.id} — ${incompleteTaskIds.length} of ${plan.tasks.length} tasks left, up to ${run.policy.maxConcurrency} at a time`,
        options: {
          json: options.json,
          workerMode: options.workerMode,
          backend: options.backend,
          isolation,
          validate: options.validate ?? true,
          tui: options.tui === true,
          ...(options.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: options.timeoutSeconds }),
          ...(options.maxIterations === undefined
            ? {}
            : { maxIterations: options.maxIterations }),
        },
      },
      deps,
    );
  } finally {
    closeRunStore(store);
  }
}
