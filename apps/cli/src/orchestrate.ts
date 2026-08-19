import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { UsageRecorder, UsageTotals } from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import type {
  AgentProject,
  RuntimeTask,
  WorkerExecutor,
  WorkspaceExecutorFactory,
} from "@agent/coding-agent";
import {
  AgentLoopWorkerExecutor,
  ChildProcessWorkerExecutor,
  CodexBackend,
  CodexWorkerExecutor,
  DeterministicScheduler,
  PolicyRouter,
  TaskGraph,
  WorktreeIsolatedExecutor,
} from "@agent/coding-agent";
import type { EventSink } from "@agent/protocol";
import type { BackendName } from "./backend.js";
import { codexInstallGuidance, codexLoginGuidance } from "./backend.js";
import type {
  OrchestrationOutput,
  PlanCommandOptions,
  PreparePlanDeps,
} from "./plan.js";
import { consoleOutput, formatTable, preparePlan, renderPlan } from "./plan.js";
import { createProjectModelResolver } from "./project-models.js";
import { JsonRenderer, type Renderer, TextRenderer } from "./render.js";

/** Where the scheduler's workers run. */
export const WORKER_MODES = ["in-process", "child"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];

export const DEFAULT_WORKER_MODE: WorkerMode = "in-process";

/** Validates a `--worker-mode` value; throws a friendly, printable error otherwise. */
export function validateWorkerMode(raw: string): WorkerMode {
  if ((WORKER_MODES as readonly string[]).includes(raw))
    return raw as WorkerMode;
  throw new Error(
    `Invalid --worker-mode value "${raw}": expected one of ${WORKER_MODES.join(", ")}.`,
  );
}

/** How a mutating task's writes are kept apart from every other task's. */
export const ISOLATION_MODES = ["worktree", "none"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

/**
 * Isolation is on by default: parallel workers editing one checkout is the
 * failure mode a per-task worktree exists to prevent, so opting out has to be
 * the deliberate choice.
 */
export const DEFAULT_ISOLATION: IsolationMode = "worktree";

/** Validates an `--isolation` value; throws a friendly, printable error otherwise. */
export function validateIsolation(raw: string): IsolationMode {
  if ((ISOLATION_MODES as readonly string[]).includes(raw))
    return raw as IsolationMode;
  throw new Error(
    `Invalid --isolation value "${raw}": expected one of ${ISOLATION_MODES.join(", ")}.`,
  );
}

const execFileAsync = promisify(execFile);

/**
 * Why worktree isolation cannot be used in `workspacePath`, or `undefined` when
 * it can.
 *
 * `git rev-parse HEAD` answers both halves of the precondition in one cheap
 * call: it fails outside a repository and in a repository with no commits, and
 * a task worktree needs a commit to branch from. Failing here beats failing
 * per task once the model has already been paid for a plan.
 */
export async function worktreeIsolationError(
  workspacePath: string,
): Promise<string | undefined> {
  try {
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath });
    return undefined;
  } catch {
    return (
      `--isolation worktree needs ${workspacePath} to be a git repository with at least one commit, ` +
      "and `git rev-parse HEAD` failed there. Commit something first, or re-run with --isolation none."
    );
  }
}

export interface OrchestrateCommandOptions extends PlanCommandOptions {
  /** Stop after planning and print exactly what `agent plan` would. */
  readonly dryRun: boolean;
  readonly workerMode: WorkerMode;
  readonly backend: BackendName;
  /** Defaults to {@link DEFAULT_ISOLATION} when the caller omits it. */
  readonly isolation?: IsolationMode;
  /** Applied per task, not to the run as a whole. */
  readonly timeoutSeconds?: number;
  readonly maxIterations?: number;
}

export interface ExecutorFactoryArgs {
  readonly project: AgentProject;
  readonly workspacePath: string;
  readonly runId: string;
  /** The renderer, so worker events land in the same stream as task events. */
  readonly events: EventSink;
  readonly usage: UsageRecorder;
  readonly workerMode: WorkerMode;
  readonly backend: BackendName;
  readonly isolation: IsolationMode;
  readonly taskTimeoutMs?: number;
  readonly maxIterations?: number;
}

/** Builds the executor the scheduler drives. Overridable in tests. */
export type ExecutorFactory = (
  args: ExecutorFactoryArgs,
) => Promise<WorkerExecutor> | WorkerExecutor;

/**
 * Absolute path of the CLI entry point, derived from this module's own URL.
 *
 * In the built layout `orchestrate.js` and `index.js` are siblings in `dist/`,
 * so this resolves to the same file the `agent` bin points at. `--worker-mode
 * child` therefore requires the CLI to have been built: it re-executes the
 * compiled entry, not the TypeScript source.
 */
export function cliEntryPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/**
 * Builds the "run a task in *this* directory" factory for a run.
 *
 * Everything expensive or fallible — the Codex availability probe, the model
 * resolver — happens once, here; the returned function only has to point an
 * executor at a workspace, which is what makes it usable per task worktree.
 *
 * Codex outranks the worker mode: `--backend codex` means "let Codex do the
 * work", and Codex is already its own process, so there is no in-process
 * variant of it to choose between.
 */
async function workspaceExecutorFactory(
  args: ExecutorFactoryArgs,
): Promise<WorkspaceExecutorFactory> {
  const { runId, events, taskTimeoutMs } = args;

  if (args.backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    if (!availability.installed) {
      throw new Error(codexInstallGuidance(availability));
    }
    if (!availability.loggedIn) {
      throw new Error(codexLoginGuidance(availability));
    }
    return (workspacePath) =>
      new CodexWorkerExecutor({
        workspacePath,
        runId,
        events,
        ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      });
  }

  if (args.workerMode === "child") {
    // The child inherits `process.env` through the executor's own spawn call,
    // so credentials and `AGENT_*` settings carry over without being restated.
    return (workspacePath) =>
      new ChildProcessWorkerExecutor({
        command: [process.execPath, cliEntryPath(), "worker"],
        runId,
        workspacePath,
        events,
        ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      });
  }

  const resolveModel = await createProjectModelResolver(
    args.project,
    process.env,
  );
  return (workspacePath) =>
    new AgentLoopWorkerExecutor({
      project: args.project,
      resolveModel,
      workspacePath,
      runId,
      events,
      usage: args.usage,
      ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      ...(args.maxIterations === undefined
        ? {}
        : { maxIterations: args.maxIterations }),
    });
}

/**
 * Picks the executor for a run: the per-workspace executor above, wrapped in
 * worktree isolation unless `--isolation none` was asked for.
 *
 * The wrapper applies to every worker mode and to `--backend codex` alike —
 * isolation is a property of how tasks share the repository, not of what runs
 * them, and a Codex worker pointed at a task checkout behaves exactly like a
 * native one pointed at it.
 */
export const defaultExecutorFactory: ExecutorFactory = async (args) => {
  const createExecutor = await workspaceExecutorFactory(args);
  if (args.isolation === "none") return createExecutor(args.workspacePath);

  return new WorktreeIsolatedExecutor({
    repoRoot: args.workspacePath,
    createExecutor,
    events: args.events,
    runId: args.runId,
  });
};

export interface RunOrchestrateDeps extends PreparePlanDeps {
  readonly executorFactory?: ExecutorFactory;
  /** The event sink task/worker events are rendered through. */
  readonly renderer?: Renderer;
}

function jsonLine(output: OrchestrationOutput, value: unknown): void {
  output.log(JSON.stringify(value));
}

function usageLine(totals: UsageTotals): string {
  const parts = [
    `input: ${totals.usage.inputTokens}`,
    `output: ${totals.usage.outputTokens}`,
  ];
  if (totals.usage.cachedInputTokens !== undefined) {
    parts.push(`cached: ${totals.usage.cachedInputTokens}`);
  }
  const line = `tokens — ${parts.join(", ")}`;
  return totals.costUsd > 0
    ? `${line}  (~$${totals.costUsd.toFixed(4)})`
    : line;
}

function summaryRow(task: RuntimeTask): readonly string[] {
  return [
    task.status,
    task.spec.id,
    task.assignedAgent ?? "-",
    String(task.attempts),
    task.spec.title,
  ];
}

/**
 * Prints the end-of-run report and decides the exit code: anything short of
 * every task completing is a failed run, since a cancelled or failed task means
 * the objective was not delivered.
 */
function renderRunSummary(
  runId: string,
  tasks: readonly RuntimeTask[],
  totals: UsageTotals,
  output: OrchestrationOutput,
  json: boolean,
): number {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const ok = completed === tasks.length;

  if (json) {
    jsonLine(output, {
      type: "run.summary",
      runId,
      ok,
      tasks: tasks.map((task) => ({
        id: task.spec.id,
        status: task.status,
        agent: task.assignedAgent,
        attempts: task.attempts,
        ...(task.result === undefined ? {} : { result: task.result }),
      })),
      usage: totals.usage,
      costUsd: totals.costUsd,
    });
    return ok ? 0 : 1;
  }

  output.log("");
  for (const line of formatTable(
    ["STATUS", "ID", "AGENT", "TRIES", "TITLE"],
    tasks.map(summaryRow),
  )) {
    output.log(line);
  }
  output.log("");
  output.log(`${completed}/${tasks.length} tasks completed`);
  output.log(usageLine(totals));
  return ok ? 0 : 1;
}

/**
 * Implements `agent orchestrate`: plan the objective, rewrite the plan through
 * the policy, then run the resulting task graph across routed workers.
 */
export async function runOrchestrate(
  objective: string,
  options: OrchestrateCommandOptions,
  deps: RunOrchestrateDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const isolation = options.isolation ?? DEFAULT_ISOLATION;

  // Checked before planning: a plan costs a model call, and a workspace that
  // cannot host task worktrees would fail on the first mutating task anyway.
  // `--dry-run` executes nothing, so it is exempt.
  if (isolation === "worktree" && !options.dryRun) {
    const problem = await worktreeIsolationError(resolve(options.cwd));
    if (problem !== undefined) {
      if (options.json) jsonLine(output, { ok: false, error: problem });
      else output.error(problem);
      return 1;
    }
  }

  const prepared = await preparePlan(objective, options, deps);
  if ("exitCode" in prepared) return prepared.exitCode;

  if (options.dryRun) {
    renderPlan(prepared, output, options.json);
    return 0;
  }

  const renderer =
    deps.renderer ?? (options.json ? new JsonRenderer() : new TextRenderer());
  const runId = crypto.randomUUID();
  const usage = new UsageTracker();
  const taskTimeoutMs =
    options.timeoutSeconds === undefined
      ? undefined
      : options.timeoutSeconds * 1000;

  let executor: WorkerExecutor;
  try {
    executor = await (deps.executorFactory ?? defaultExecutorFactory)({
      project: prepared.project,
      workspacePath: prepared.workspacePath,
      runId,
      events: renderer,
      usage,
      workerMode: options.workerMode,
      backend: options.backend,
      isolation,
      ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      ...(options.maxIterations === undefined
        ? {}
        : { maxIterations: options.maxIterations }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return 1;
  }

  const graph = new TaskGraph(prepared.plan);
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  if (!options.json) {
    output.log(
      `Run ${runId} — ${prepared.plan.tasks.length} tasks, up to ${prepared.policy.maxConcurrency} at a time`,
    );
  }

  try {
    await new DeterministicScheduler(
      new PolicyRouter(),
      executor,
      renderer,
    ).run(runId, graph, prepared.policy, controller.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }

  return renderRunSummary(
    runId,
    graph.all(),
    usage.totals(),
    output,
    options.json,
  );
}
