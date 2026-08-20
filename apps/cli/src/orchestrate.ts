import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  UsageBreakdown,
  UsageDimension,
  UsageRecorder,
  UsageTotals,
} from "@agent/ai";
import { UNATTRIBUTED, UsageTracker, usageRecordingProvider } from "@agent/ai";
import type {
  AgentProject,
  DelegatedWorkerUsageSink,
  ExecutionPlan,
  OrchestrationPolicy,
  RuntimeTask,
  WorkerExecutor,
  WorkspaceExecutorFactory,
} from "@agent/coding-agent";
import {
  AgentLoopWorkerExecutor,
  ClaudeCodeBackend,
  ClaudeCodeWorkerExecutor,
  CodexBackend,
  CodexWorkerExecutor,
  createDelegatedModelResolver,
  createDelegatedToolsResolver,
  DelegatedPlanner,
  DeterministicScheduler,
  LlmPlanner,
  PolicyRouter,
  TaskGraph,
  ValidatingExecutor,
  WorktreeIsolatedExecutor,
} from "@agent/coding-agent";
import type { EventSink } from "@agent/protocol";
import type { SqliteSessionStore } from "@agent/session";
import type { TuiController, TuiInit } from "@agent/tui";
import type { BackendName, DelegatedBackendName } from "./backend.js";
import {
  claudeCodeInstallGuidance,
  claudeCodeLoginGuidance,
  codexInstallGuidance,
  codexLoginGuidance,
  delegatedModelIdentity,
} from "./backend.js";
import type {
  DelegatedPlannerFactory,
  OrchestrationOutput,
  PlanCommandOptions,
  PlannerFactory,
  PreparePlanDeps,
} from "./plan.js";
import { consoleOutput, formatTable, preparePlan, renderPlan } from "./plan.js";
import { createProjectModelResolver } from "./project-models.js";
import {
  formatCostUsd,
  formatTokenCount,
  JsonRenderer,
  type Renderer,
  TextRenderer,
  usageRollupLines,
} from "./render.js";
import {
  bestEffort,
  closeRunStore,
  fanOutSink,
  openRunStore,
  recordRunStatus,
  runStatusFor,
  storeSink,
} from "./sessions.js";

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
  /** Stop after planning and print exactly what `/plan` would. */
  readonly dryRun: boolean;
  readonly backend: BackendName;
  /** Defaults to {@link DEFAULT_ISOLATION} when the caller omits it. */
  readonly isolation?: IsolationMode;
  /** Applied per task, not to the run as a whole. */
  readonly timeoutSeconds?: number;
  readonly maxIterations?: number;
  /**
   * Run the project's `.agent/config.yaml` `validation:` commands inside each
   * mutating task's workspace before it counts as done. Defaults to `true`;
   * `--no-validate` sets this to `false`. Has no effect when the project
   * declares no validators, or under `--backend codex` — see
   * {@link shouldRunValidators}.
   */
  readonly validate?: boolean;
  /**
   * Record the run in `.agent/sessions.db` so it can be listed, explained and
   * resumed later. Defaults to `true`; `--no-save` sets this to `false`.
   */
  readonly save?: boolean;
  /** Show the Ink dashboard instead of streaming event lines. Text mode only. */
  readonly tui?: boolean;
}

export interface ExecutorFactoryArgs {
  readonly project: AgentProject;
  readonly workspacePath: string;
  readonly runId: string;
  /** The renderer, so worker events land in the same stream as task events. */
  readonly events: EventSink;
  readonly usage: UsageRecorder;
  readonly backend: BackendName;
  readonly isolation: IsolationMode;
  readonly taskTimeoutMs?: number;
  readonly maxIterations?: number;
  /** Whether the run wants validators to gate mutating tasks; see {@link shouldRunValidators}. */
  readonly validate: boolean;
  /**
   * Overrides the per-workspace base executor, bypassing the
   * codex/child/in-process selection in {@link workspaceExecutorFactory}.
   * Test-only injection point, mirroring `PreparePlanDeps.plannerFactory`;
   * production callers never set this.
   */
  readonly baseExecutorFactory?: WorkspaceExecutorFactory;
}

/** Builds the executor the scheduler drives. Overridable in tests. */
export type ExecutorFactory = (
  args: ExecutorFactoryArgs,
) => Promise<WorkerExecutor> | WorkerExecutor;

/**
 * Builds the usage sink handed to a delegated worker executor
 * (`CodexWorkerExecutor`/`ClaudeCodeWorkerExecutor`) — `workspaceExecutorFactory`'s
 * worker-side equivalent of {@link delegatedPlanningThrough}.
 *
 * The run's ledger goes in directly, same reason as planning: there is no
 * `ModelProvider` to tee through under a delegated backend, since the model
 * call happens inside the CLI's own subprocess. `modelFor` reduces whatever
 * model a task's agent resolved to (or `undefined`, when none did) to the
 * same placeholder {@link ModelDefinition} `delegatedPlanningThrough` uses for
 * planning, so a worker and the planner attribute unpriced, subscription-CLI
 * spend the same way. Kept as its own function, rather than inlined at both
 * `workspaceExecutorFactory` call sites, so the wiring can be exercised in a
 * test without booting either CLI.
 */
export function delegatedWorkerUsageSink(
  backend: DelegatedBackendName,
  usage: UsageRecorder,
): DelegatedWorkerUsageSink {
  return {
    recorder: usage,
    modelFor: (model) => delegatedModelIdentity(backend, model),
  };
}

/**
 * Builds the "run a task in *this* directory" factory for a run.
 *
 * Everything expensive or fallible — the delegated CLI's availability probe,
 * the model and tool resolvers — happens once, here; the returned function
 * only has to point an executor at a workspace, which is what makes it usable
 * per task worktree.
 *
 * A delegated backend decides everything: `--backend codex` and `--backend
 * claude-code` both mean "let that CLI do the work", and each is already its
 * own process. Everything else runs the native agent loop in this one.
 */
async function workspaceExecutorFactory(
  args: ExecutorFactoryArgs,
): Promise<WorkspaceExecutorFactory> {
  const { runId, events, taskTimeoutMs } = args;
  // Read once, here, and handed to whichever executor the backend selects: what
  // a run tells its workers is the project's decision, not the backend's. An
  // absent `.agent/handoff.md` leaves this `undefined`, which is how the
  // briefing spells "use the built-in guidance".
  const handoff = args.project.handoff;

  if (args.backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    if (!availability.installed) {
      throw new Error(claudeCodeInstallGuidance(availability));
    }
    if (!availability.loggedIn) {
      throw new Error(claudeCodeLoginGuidance(availability));
    }
    // Both resolvers read the project once, here, so every task worktree gets
    // the same answers without re-parsing `.agent/` per task.
    const resolveAgentModel = createDelegatedModelResolver(args.project);
    const resolveAgentTools = createDelegatedToolsResolver(args.project);
    const usage = delegatedWorkerUsageSink("claude-code", args.usage);
    return (workspacePath) =>
      new ClaudeCodeWorkerExecutor({
        workspacePath,
        runId,
        events,
        resolveAgentModel,
        resolveAgentTools,
        usage,
        handoff,
        ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      });
  }

  if (args.backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    if (!availability.installed) {
      throw new Error(codexInstallGuidance(availability));
    }
    if (!availability.loggedIn) {
      throw new Error(codexLoginGuidance(availability));
    }
    const resolveAgentModel = createDelegatedModelResolver(args.project);
    const usage = delegatedWorkerUsageSink("codex", args.usage);
    return (workspacePath) =>
      new CodexWorkerExecutor({
        workspacePath,
        runId,
        events,
        resolveAgentModel,
        usage,
        handoff,
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
      handoff,
      ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      ...(args.maxIterations === undefined
        ? {}
        : { maxIterations: args.maxIterations }),
    });
}

/**
 * Whether a run should gate its mutating tasks on the project's configured
 * validators.
 *
 * `--backend codex` runs its own agentic loop end-to-end and reports one
 * result per task with no hook to run a separate command suite against; Codex
 * tasks skip our validators for now, regardless of `--no-validate` or what
 * `.agent/config.yaml` declares.
 *
 * `--backend claude-code` is deliberately *not* given the same carve-out,
 * delegated though it equally is. A validator never needed a hook inside the
 * agent loop to begin with: {@link ValidatingExecutor} spawns the project's
 * commands in the task's own workspace after the worker returns, which for a
 * delegated backend is simply after the CLI subprocess has exited and left
 * its edits on disk — the same moment, and the same checkout, as on the
 * native loop. So a Claude Code task is gated on `npm test` exactly like a
 * native one, and the Codex exclusion above stays scoped to Codex rather
 * than growing into a rule about external CLIs.
 *
 * Otherwise validators run whenever the project declares at least one and
 * the caller didn't opt out with `--no-validate`.
 */
export function shouldRunValidators(
  project: AgentProject,
  backend: BackendName,
  validate: boolean,
): boolean {
  return (
    backend !== "codex" && validate && project.config.validators.length > 0
  );
}

/**
 * Wraps a per-workspace executor factory in {@link ValidatingExecutor} when
 * {@link shouldRunValidators} says the run wants it; otherwise returns `base`
 * unchanged.
 *
 * Composed *before* worktree isolation is applied (see
 * {@link defaultExecutorFactory}) so that whichever path built `base` still
 * receives the task's own workspace path — worktree or plain `cwd` alike —
 * and validators run against the exact checkout the isolation layer is about
 * to decide whether to merge.
 */
function withValidation(
  base: WorkspaceExecutorFactory,
  args: ExecutorFactoryArgs,
): WorkspaceExecutorFactory {
  if (!shouldRunValidators(args.project, args.backend, args.validate)) {
    return base;
  }
  const validators = args.project.config.validators;
  return (workspacePath) =>
    new ValidatingExecutor({
      inner: base(workspacePath),
      validators,
      workspacePath,
      events: args.events,
      runId: args.runId,
    });
}

/**
 * Picks the executor for a run: the per-workspace executor above, optionally
 * gated on the project's validators, wrapped in worktree isolation unless
 * `--isolation none` was asked for.
 *
 * The isolation wrapper applies to the native loop and to `--backend codex`
 * alike — isolation is a property of how tasks share the repository, not of
 * what runs them, and a Codex worker pointed at a task checkout behaves
 * exactly like a native one pointed at it. Validation, by contrast, is
 * composed *inside* isolation (see {@link withValidation}): it has to run
 * against the task's own checkout before that checkout is merged back, so it
 * wraps the per-workspace factory rather than the whole thing.
 */
export const defaultExecutorFactory: ExecutorFactory = async (args) => {
  const base =
    args.baseExecutorFactory ?? (await workspaceExecutorFactory(args));
  const createExecutor = withValidation(base, args);

  if (args.isolation === "none") return createExecutor(args.workspacePath);

  return new WorktreeIsolatedExecutor({
    repoRoot: args.workspacePath,
    createExecutor,
    events: args.events,
    runId: args.runId,
  });
};

/** Mounts the orchestration dashboard. Overridable in tests. */
export type TuiFactory = (
  init: TuiInit,
) => Promise<TuiController> | TuiController;

/**
 * Loads the Ink dashboard only when a run actually asks for one.
 *
 * `@agent/tui` pulls in ink and react; a dynamic import keeps that cost off
 * every `agent` invocation that is not `--tui`.
 */
const defaultTuiFactory: TuiFactory = async (init) => {
  const { startOrchestrationTui } = await import("@agent/tui");
  return startOrchestrationTui(init);
};

export interface RunOrchestrateDeps extends PreparePlanDeps {
  readonly executorFactory?: ExecutorFactory;
  /** The event sink task/worker events are rendered through. */
  readonly renderer?: Renderer;
  /** Builds the `--tui` dashboard. Overridable in tests. */
  readonly tuiFactory?: TuiFactory;
}

function jsonLine(output: OrchestrationOutput, value: unknown): void {
  output.log(JSON.stringify(value));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The reason `--tui` and `--json` cannot be combined, or `undefined` when they
 * were not combined.
 *
 * The dashboard repaints the whole screen; JSONL output is a stream something
 * else parses. Silently dropping one of them would be worse than saying so.
 */
export function tuiJsonConflict(options: {
  readonly tui?: boolean;
  readonly json: boolean;
}): string | undefined {
  return options.tui === true && options.json
    ? "--tui cannot be combined with --json: the dashboard owns the terminal, so there is nowhere for the JSON stream to go. Pick one."
    : undefined;
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

/**
 * The slice of {@link UsageTracker} a run summary reads.
 *
 * Narrow on purpose: the summary is a pure function of these two views, which
 * is what lets {@link runSummaryLines} be tested without a scheduler.
 */
export interface RunUsageView {
  totals(): UsageTotals;
  breakdownBy(dimension: UsageDimension): ReadonlyMap<string, UsageBreakdown>;
}

/**
 * The per-task columns: which model did the work, what it spent, what that
 * cost.
 *
 * `-` means nothing was recorded against the task at all. Under `--backend
 * native` that only happens for a task type the loop never billed a model
 * for; under a delegated backend (`--backend codex`, `--backend claude-code`)
 * it also covers the honest case where the CLI itself reported no usage for
 * that attempt — `workspaceExecutorFactory` wires a usage sink into both
 * worker executors the same way `delegatedPlanningThrough` wires one into
 * planning, but neither one *invents* a number when the subprocess gave none.
 * That is distinct from `n/a` in the `$` column, which means the tokens *are*
 * known and their price is not — the placeholder identity
 * `delegatedModelIdentity` gives a delegated model always prices `unknown`,
 * so a delegated task with recorded usage still shows `n/a` there, never `$`.
 */
function summaryRow(
  task: RuntimeTask,
  spent: UsageBreakdown | undefined,
): readonly string[] {
  return [
    task.status,
    task.spec.id,
    task.assignedAgent ?? "-",
    String(task.attempts),
    spent === undefined ? "-" : spent.models.join("+"),
    spent === undefined
      ? "-"
      : `${formatTokenCount(spent.usage.inputTokens)}/${formatTokenCount(spent.usage.outputTokens)}`,
    spent === undefined ? "-" : formatCostUsd(spent.costUsd, spent.pricing),
    task.spec.title,
  ];
}

/**
 * The end-of-run report, as lines.
 *
 * Three views of the same numbers, narrowing from what to who to how much: one
 * row per task, one line per model, then the run total. The per-model rollup
 * is the only place a reader can check the claim the whole project rests on —
 * that the expensive model planned and cheap workers executed — so it is
 * derived from the same tracker as the total and always adds up to it.
 */
export function runSummaryLines(
  tasks: readonly RuntimeTask[],
  usage: RunUsageView,
): readonly string[] {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const byTask = usage.breakdownBy("task");
  return [
    "",
    ...formatTable(
      ["STATUS", "ID", "AGENT", "TRIES", "MODEL", "TOKENS", "$", "TITLE"],
      tasks.map((task) => summaryRow(task, byTask.get(task.spec.id))),
    ),
    "",
    `${completed}/${tasks.length} tasks completed`,
    ...usageRollupLines(usage.breakdownBy("model"), { countTasks: true }),
    usageLine(usage.totals()),
  ];
}

/** The per-model rollup as JSON: same buckets, `null` where no price is known. */
function modelRollupJson(usage: RunUsageView): readonly unknown[] {
  return [...usage.breakdownBy("model").values()].map((entry) => ({
    model: entry.key,
    tasks: entry.tasks.filter((id) => id !== UNATTRIBUTED).length,
    usage: entry.usage,
    // Never 0 for an unpriced model: 0 would read as "this was free".
    costUsd: entry.pricing === "unknown" ? null : entry.costUsd,
    pricing: entry.pricing,
  }));
}

/**
 * Prints the end-of-run report and decides the exit code: anything short of
 * every task completing is a failed run, since a cancelled or failed task means
 * the objective was not delivered.
 */
function renderRunSummary(
  runId: string,
  tasks: readonly RuntimeTask[],
  usage: RunUsageView,
  output: OrchestrationOutput,
  json: boolean,
): number {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const ok = completed === tasks.length;

  if (json) {
    const totals = usage.totals();
    const byTask = usage.breakdownBy("task");
    jsonLine(output, {
      type: "run.summary",
      runId,
      ok,
      tasks: tasks.map((task) => {
        const spent = byTask.get(task.spec.id);
        return {
          id: task.spec.id,
          status: task.status,
          agent: task.assignedAgent,
          attempts: task.attempts,
          ...(spent === undefined
            ? {}
            : {
                models: spent.models,
                usage: spent.usage,
                costUsd: spent.pricing === "unknown" ? null : spent.costUsd,
              }),
          ...(task.result === undefined ? {} : { result: task.result }),
        };
      }),
      models: modelRollupJson(usage),
      usage: totals.usage,
      costUsd: totals.costUsd,
    });
    return ok ? 0 : 1;
  }

  for (const line of runSummaryLines(tasks, usage)) output.log(line);
  return ok ? 0 : 1;
}

/** One-line verdict for the dashboard's footer once the scheduler is done. */
export function outcomeLine(tasks: readonly RuntimeTask[]): string {
  const completed = tasks.filter((task) => task.status === "completed").length;
  if (completed === tasks.length) {
    return `completed ${completed}/${tasks.length} tasks`;
  }
  const failed = tasks.filter((task) => task.status === "failed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} task${failed === 1 ? "" : "s"} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  if (parts.length === 0) parts.push(`${completed}/${tasks.length} completed`);
  return `failed: ${parts.join(", ")}`;
}

/** Paints a final frame and tears the dashboard down, if one is mounted. */
async function closeTui(
  tui: TuiController | undefined,
  outcome: string,
): Promise<void> {
  if (tui === undefined) return;
  try {
    tui.finish(outcome);
    await tui.unmount();
  } catch {
    // A dashboard that fails to come down cleanly must not change the run's
    // exit code; the summary below is printed either way.
  }
}

/** Execution knobs {@link executePreparedPlan} needs, shared by orchestrate and resume. */
export interface ExecuteRunOptions {
  readonly json: boolean;
  readonly backend: BackendName;
  readonly isolation: IsolationMode;
  /** Whether the run wants the project's validators; see {@link shouldRunValidators}. */
  readonly validate: boolean;
  /** Mount the Ink dashboard instead of streaming event lines. */
  readonly tui: boolean;
  readonly timeoutSeconds?: number;
  readonly maxIterations?: number;
}

export interface ExecuteRunRequest {
  readonly runId: string;
  readonly objective: string;
  readonly project: AgentProject;
  readonly workspacePath: string;
  readonly policy: OrchestrationPolicy;
  readonly plan: ExecutionPlan;
  /**
   * The graph to execute. Built by the caller so a resumed run can pre-mark
   * the tasks it already has results for before the scheduler sees them.
   */
  readonly graph: TaskGraph;
  /** Where events are teed, or `undefined` when the run is not being recorded. */
  readonly store?: SqliteSessionStore;
  /** Replaces the default `Run <id> — …` header line (text mode only). */
  readonly leadLine?: string;
  /**
   * The run's usage ledger. Supplied when the caller already spent tokens on
   * this run before execution started — `runOrchestrate` plans through it, so
   * the summary can attribute the planner's spend alongside the workers'.
   * Omitted, execution starts from an empty one.
   */
  readonly usage?: UsageTracker;
  readonly options: ExecuteRunOptions;
}

/**
 * Executes a prepared plan: everything `/orchestrate` does once the plan
 * exists, which is also everything `/resume-run` does.
 *
 * The event stream is fanned out rather than handed to one renderer: the
 * renderer (or the dashboard, which replaces it — it owns the screen and
 * per-event lines would fight it for the cursor) and the session store all see
 * the same events, and neither observer can fail the run.
 */
export async function executePreparedPlan(
  request: ExecuteRunRequest,
  deps: RunOrchestrateDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const { runId, plan, policy, graph, store, options } = request;

  let tui: TuiController | undefined;
  if (options.tui && !options.json) {
    try {
      tui = await (deps.tuiFactory ?? defaultTuiFactory)({
        objective: request.objective,
        taskIds: plan.tasks.map((task) => ({
          id: task.id,
          title: task.title,
        })),
      });
    } catch (error) {
      output.error(
        `Note: showing plain output — the dashboard could not start (${errorText(error)})`,
      );
    }
  }

  // With the dashboard up there is no renderer at all: suppressing its writes
  // is the same thing as not having one.
  const renderer =
    tui !== undefined
      ? undefined
      : (deps.renderer ??
        (options.json ? new JsonRenderer() : new TextRenderer()));
  const events = fanOutSink(
    renderer,
    tui?.sink,
    store === undefined ? undefined : storeSink(store),
  );

  const usage = request.usage ?? new UsageTracker();
  const taskTimeoutMs =
    options.timeoutSeconds === undefined
      ? undefined
      : options.timeoutSeconds * 1000;

  const fail = async (message: string): Promise<number> => {
    await closeTui(tui, "failed to run");
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    await recordRunStatus(store, runId, "failed");
    return 1;
  };

  // Surfaced rather than thrown: a heading kapel did not recognise in
  // `.agent/handoff.md` changes what every worker is told, so it must not pass
  // silently — but it cannot make the run incorrect either.
  for (const warning of request.project.handoff?.warnings ?? []) {
    output.error(`Note: ${warning}`);
  }

  let executor: WorkerExecutor;
  try {
    executor = await (deps.executorFactory ?? defaultExecutorFactory)({
      project: request.project,
      workspacePath: request.workspacePath,
      runId,
      events,
      usage,
      backend: options.backend,
      isolation: options.isolation,
      validate: options.validate,
      ...(taskTimeoutMs === undefined ? {} : { taskTimeoutMs }),
      ...(options.maxIterations === undefined
        ? {}
        : { maxIterations: options.maxIterations }),
    });
  } catch (error) {
    return await fail(errorText(error));
  }

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  if (!options.json && tui === undefined) {
    output.log(
      request.leadLine ??
        `Run ${runId} — ${plan.tasks.length} tasks, up to ${policy.maxConcurrency} at a time`,
    );
    if (
      shouldRunValidators(request.project, options.backend, options.validate)
    ) {
      const names = request.project.config.validators
        .map((validator) => validator.name)
        .join(", ");
      output.log(`validators: ${names}`);
    }
  }

  try {
    await new DeterministicScheduler(new PolicyRouter(), executor, events).run(
      runId,
      graph,
      policy,
      controller.signal,
    );
  } catch (error) {
    return await fail(errorText(error));
  } finally {
    process.off("SIGINT", onSigint);
  }

  const tasks = graph.all();
  await recordRunStatus(
    store,
    runId,
    runStatusFor(tasks, controller.signal.aborted),
  );
  // The dashboard comes down before the summary is printed: the table below is
  // what survives in the scrollback, so it must not land inside a live frame.
  await closeTui(tui, outcomeLine(tasks));

  return renderRunSummary(runId, tasks, usage, output, options.json);
}

/** The agent name planning spend is attributed to; it belongs to no task. */
export const PLANNER_AGENT = "planner";

/**
 * Wraps a planner factory so the planning call records what it spent.
 *
 * The planner takes a provider and no usage recorder, so the recorder is
 * pushed down into the provider it is handed — see `usageRecordingProvider`.
 * An injected factory (tests, dry-run fixtures) is preserved and wrapped
 * the same way rather than replaced.
 */
export function planningThrough(
  usage: UsageRecorder,
  inner: PlannerFactory | undefined,
): PlannerFactory {
  const factory: PlannerFactory = inner ?? ((args) => new LlmPlanner(args));
  return (args) =>
    factory({
      ...args,
      provider: usageRecordingProvider(args.provider, usage, {
        agent: PLANNER_AGENT,
      }),
    });
}

/**
 * {@link planningThrough} for a delegating backend.
 *
 * There is no provider to tee through here — the model call happens inside a
 * `codex`/`claude` subprocess — so the recorder goes in directly and the
 * planner pushes whatever token counts the CLI reported into it. A CLI that
 * reports nothing records nothing, which is why the summary distinguishes an
 * absent bucket (`-`) from a zero one; nothing on this path invents numbers.
 */
export function delegatedPlanningThrough(
  usage: UsageRecorder,
  inner: DelegatedPlannerFactory | undefined,
): DelegatedPlannerFactory {
  const factory: DelegatedPlannerFactory =
    inner ?? ((args) => new DelegatedPlanner(args));
  return (args) =>
    factory({
      ...args,
      usage: {
        recorder: usage,
        model: delegatedModelIdentity(args.backend, args.model),
        tags: { agent: PLANNER_AGENT },
      },
    });
}

/**
 * The orchestration pipeline behind the REPL's `/orchestrate`: plan the
 * objective, rewrite the plan through the policy, then run the resulting task
 * graph across routed workers.
 */
export async function runOrchestrate(
  objective: string,
  options: OrchestrateCommandOptions,
  deps: RunOrchestrateDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const isolation = options.isolation ?? DEFAULT_ISOLATION;

  const conflict = tuiJsonConflict(options);
  if (conflict !== undefined) {
    output.error(conflict);
    return 1;
  }

  // Checked before planning: a plan costs a model call, and a workspace that
  // cannot host task worktrees would fail on the first mutating task anyway.
  // A dry run executes nothing, so it is exempt.
  if (isolation === "worktree" && !options.dryRun) {
    const problem = await worktreeIsolationError(resolve(options.cwd));
    if (problem !== undefined) {
      if (options.json) jsonLine(output, { ok: false, error: problem });
      else output.error(problem);
      return 1;
    }
  }

  // One ledger for the whole run, opened before the plan: planning is a model
  // call like any other, and a cost report that silently omitted the model
  // that plans would hide exactly the number this command exists to show.
  const usage = new UsageTracker();
  const prepared = await preparePlan(objective, options, {
    ...deps,
    plannerFactory: planningThrough(usage, deps.plannerFactory),
    delegatedPlannerFactory: delegatedPlanningThrough(
      usage,
      deps.delegatedPlannerFactory,
    ),
  });
  if ("exitCode" in prepared) return prepared.exitCode;

  if (options.dryRun) {
    renderPlan(prepared, output, options.json);
    return 0;
  }

  const runId = crypto.randomUUID();
  // `--no-save` opts out; otherwise the run is recorded next to the rest of
  // `.agent`, which is what makes `/runs`, `kapel explain` and `/resume-run`
  // possible.
  const store =
    options.save === false
      ? undefined
      : await openRunStore(prepared.workspacePath);

  try {
    if (store !== undefined) {
      await bestEffort(() =>
        store.createRun({
          id: runId,
          objective,
          createdAt: Date.now(),
          policySnapshot: prepared.policy,
        }),
      );
      // The plan is saved post-rewrite: injected reviews and dropped agents
      // are part of what a resume has to reproduce.
      await bestEffort(() => store.savePlan(runId, prepared.plan));
    }

    return await executePreparedPlan(
      {
        runId,
        objective,
        project: prepared.project,
        workspacePath: prepared.workspacePath,
        policy: prepared.policy,
        plan: prepared.plan,
        graph: new TaskGraph(prepared.plan),
        usage,
        options: {
          json: options.json,
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
        ...(store === undefined ? {} : { store }),
      },
      deps,
    );
  } finally {
    closeRunStore(store);
  }
}
