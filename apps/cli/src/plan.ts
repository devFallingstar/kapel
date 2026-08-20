import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelDefinition, ModelProvider } from "@agent/ai";
import type {
  AgentProject,
  DelegatedUsageSink,
  ExecutionPlan,
  OrchestrationPolicy,
  PlannedTask,
  Planner,
  RoutingReason,
  RoutingRule,
} from "@agent/coding-agent";
import {
  applyPolicyToPlan,
  checkLock,
  createDelegatedModelResolver,
  DelegatedPlanner,
  LlmPlanner,
  loadAgentProject,
  PlanError,
  PolicyRouter,
  ProjectConfigError,
} from "@agent/coding-agent";
import type { BackendName, DelegatedBackendName } from "./backend.js";
import {
  delegatedBackendError,
  delegatedModelIdentity,
  isDelegatedBackend,
} from "./backend.js";
import type { KapelConfig } from "./config.js";
import {
  delegatedModelOverride,
  resolveOrchestratorModel,
} from "./config-runtime.js";
import { loadDotEnvFile } from "./env.js";
import { createProjectModelResolver } from "./project-models.js";
import { resolveModelAndProvider } from "./run.js";

/** Where a plan/orchestrate command writes its output. Overridable in tests. */
export interface OrchestrationOutput {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export const consoleOutput: OrchestrationOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Options shared by the REPL's `/plan` and `/orchestrate`. */
export interface PlanCommandOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly json: boolean;
  /**
   * The resolved backend for this command. A delegated backend plans through
   * that CLI instead of a native provider, which is what lets `/plan` and
   * `/orchestrate` run with no API key at all.
   */
  readonly backend: BackendName;
  /** The machine's configuration, when there is one; see `config-runtime.ts`. */
  readonly config?: KapelConfig;
  /**
   * After planning, print the routing rationale instead of executing
   * anything. `true` means "every task"; a string is the one task id
   * requested. `undefined` prints the plan alone. `/plan` always passes
   * `true` — at a prompt the table and the reason behind it are one thought.
   */
  readonly why?: string | true;
}

/** Builds the planner used by `/plan` and `/orchestrate`. Overridable in tests. */
export type PlannerFactory = (args: {
  readonly provider: ModelProvider;
  readonly model: ModelDefinition;
  readonly knownAgents: readonly string[];
}) => Planner;

const defaultPlannerFactory: PlannerFactory = (args) => new LlmPlanner(args);

/** Builds the planner used under a delegating backend. Overridable in tests. */
export type DelegatedPlannerFactory = (args: {
  readonly backend: DelegatedBackendName;
  readonly workspacePath: string;
  /** `undefined` means "let the CLI pick its own model". */
  readonly model?: string;
  readonly knownAgents: readonly string[];
  /**
   * Where the delegated planning call reports what the CLI said it spent —
   * the delegating counterpart of the provider `planningThrough` wraps on the
   * native path, since there is no provider here to wrap. Set by
   * `delegatedPlanningThrough` in `orchestrate.ts`; `/plan` alone keeps no
   * ledger and leaves it out.
   */
  readonly usage?: DelegatedUsageSink;
}) => Planner;

const defaultDelegatedPlannerFactory: DelegatedPlannerFactory = (args) =>
  new DelegatedPlanner(args);

export interface PreparePlanDeps {
  readonly output?: OrchestrationOutput;
  readonly plannerFactory?: PlannerFactory;
  /**
   * Test-only injection point, mirroring {@link plannerFactory}. Supplying it
   * also skips the CLI availability probe, the same way
   * `ExecutorFactoryArgs.baseExecutorFactory` bypasses it on the worker side:
   * an injected planner is not going to spawn that CLI.
   */
  readonly delegatedPlannerFactory?: DelegatedPlannerFactory;
}

/** Everything both commands need once a plan exists and the policy has rewritten it. */
export interface PreparedPlan {
  readonly project: AgentProject;
  readonly workspacePath: string;
  readonly policy: OrchestrationPolicy;
  /** The post-rewrite plan: sanitized, with policy-mandated reviews injected. */
  readonly plan: ExecutionPlan;
  readonly injectedReviews: readonly string[];
  readonly notes: readonly string[];
  /** Task id -> the agent the router would pick, previewed before execution. */
  readonly routes: Readonly<Record<string, string>>;
  readonly plannerModel: ModelDefinition;
}

export type PreparePlanResult = PreparedPlan | { readonly exitCode: number };

const LOCK_FILE_NAME = "orchestration.lock.json";

function jsonLine(output: OrchestrationOutput, value: unknown): void {
  output.log(JSON.stringify(value));
}

function fail(
  output: OrchestrationOutput,
  json: boolean,
  message: string,
  extra: Record<string, unknown> = {},
): { readonly exitCode: number } {
  if (json) jsonLine(output, { ok: false, error: message, ...extra });
  else output.error(message);
  return { exitCode: 1 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function printBulletList(
  output: OrchestrationOutput,
  label: string,
  items: readonly string[],
): void {
  if (items.length === 0) return;
  output.log(`${label}:`);
  for (const item of items) output.log(`  - ${item}`);
}

/**
 * Renders a fixed-width table. Every column but the last is padded to its
 * widest cell; the last is left ragged so long titles don't drag trailing
 * whitespace along.
 */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [render(headers), ...rows.map(render)];
}

/**
 * The model that plans the objective.
 *
 * `-m/--model` wins outright. Otherwise the policy's orchestrator agent decides
 * — planning is the orchestrator's job, and its `.agent` definition already
 * names the model the project wants doing it. Every way that lookup can fail
 * (no such agent, an alias `config.yaml` doesn't define, a provider with no
 * credential) falls back to the CLI's normal default chain with a note on
 * stderr, because a plan from the default model beats no plan at all.
 */
async function resolvePlannerModel(
  project: AgentProject,
  policy: OrchestrationPolicy,
  options: PlanCommandOptions,
  output: OrchestrationOutput,
): Promise<
  | { readonly model: ModelDefinition; readonly provider: ModelProvider }
  | { readonly error: string }
> {
  if (options.model === undefined || options.model === "") {
    try {
      const orchestrator = project.agent(policy.orchestrator);
      if (orchestrator === undefined) {
        throw new Error(
          `the policy's orchestrator "${policy.orchestrator}" is not one of this project's agents`,
        );
      }
      const resolve = await createProjectModelResolver(project, process.env);
      const resolved = resolve(orchestrator.modelAlias);
      return { model: resolved.model, provider: resolved.provider };
    } catch (error) {
      output.error(
        `Note: planning with the default model instead of the orchestrator agent "${policy.orchestrator}" — ${errorMessage(error)}`,
      );
    }
  }

  const alias = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
  ).value;
  return resolveModelAndProvider(process.env, alias);
}

/**
 * The model id handed to a delegating CLI for planning.
 *
 * `-m/--model` wins — the flag names a model in *that CLI's* catalog, so it
 * is passed through untranslated — but it goes through
 * {@link delegatedModelOverride} first, because the value reaching this
 * function is not always a human typing `-m`: the REPL fills it in from
 * `config.models.orchestrator`, which a wizard-configured Claude Code or
 * Codex setup sets to the `"default"` sentinel. That sentinel is not a model
 * id, and forwarding it put a literal `--model default` on the CLI's argv and
 * printed `default (anthropic)` where the honest answer is
 * `<claude-code default>`. Otherwise the policy's orchestrator agent decides,
 * through the project's own alias table, exactly as on the native path;
 * `createDelegatedModelResolver` already reads "default" in `config.yaml` as
 * "no opinion". `undefined` means the CLI picks, which is the right answer
 * whenever this project has not named a model the CLI would recognize anyway.
 */
function delegatedPlannerModelId(
  project: AgentProject,
  policy: OrchestrationPolicy,
  options: PlanCommandOptions,
): string | undefined {
  if (options.model !== undefined && options.model !== "") {
    return delegatedModelOverride({ value: options.model, source: "flag" });
  }
  return createDelegatedModelResolver(project)(policy.orchestrator);
}

/**
 * Runs everything `/plan` and `/orchestrate` share: load the project,
 * insist on a fresh policy lock, plan the objective, and reconcile the plan with
 * the policy.
 *
 * Every failure is reported through `output` (honouring `--json`) and comes back
 * as `{exitCode}`, so callers only branch on the returned shape.
 */
export async function preparePlan(
  objective: string,
  options: PlanCommandOptions,
  deps: PreparePlanDeps = {},
): Promise<PreparePlanResult> {
  const output = deps.output ?? consoleOutput;
  const { json } = options;
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  let project: AgentProject | undefined;
  try {
    project = await loadAgentProject(workspacePath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      return fail(output, json, error.message, {
        file: error.file,
        problems: error.problems,
      });
    }
    throw error;
  }

  if (project === undefined) {
    return fail(
      output,
      json,
      "No .agent directory found — run `kapel init` first",
    );
  }

  const markdown = project.orchestrationMarkdown;
  if (markdown === undefined || markdown.trim() === "") {
    return fail(
      output,
      json,
      "No orchestration policy found — .agent/orchestration.md is missing or empty",
    );
  }

  const lockPath = path.join(project.root, LOCK_FILE_NAME);
  const status = checkLock(markdown, await readOptionalFile(lockPath));
  if (!status.fresh) {
    if (status.reason === "missing") {
      return fail(
        output,
        json,
        `No policy lock found at ${lockPath}. Run \`kapel policy compile\` before planning.`,
        { reason: status.reason },
      );
    }
    if (status.reason === "stale-source") {
      return fail(
        output,
        json,
        "orchestration.md has changed since the policy lock was compiled. Run `kapel policy compile` to refresh it before planning.",
        { reason: status.reason },
      );
    }
    return fail(
      output,
      json,
      `Invalid policy lock at ${lockPath}: ${status.detail ?? "unknown error"}. Run \`kapel policy compile\` to recreate it.`,
      { reason: status.reason },
    );
  }
  const policy = status.lock.policy;

  const knownAgents = [...project.knownAgentNames()];

  let planner: Planner;
  let plannerModel: ModelDefinition;
  if (isDelegatedBackend(options.backend)) {
    // The whole point of a delegating backend is that the user has a CLI
    // subscription and no API key, so nothing on this path may touch the
    // provider registry — not even to name the planner's model.
    const backend = options.backend;
    const modelId = delegatedPlannerModelId(project, policy, options);
    const factory = deps.delegatedPlannerFactory;
    if (factory === undefined) {
      const unavailable = await delegatedBackendError(backend);
      if (unavailable !== undefined) return fail(output, json, unavailable);
    }
    planner = (factory ?? defaultDelegatedPlannerFactory)({
      backend,
      workspacePath,
      knownAgents,
      ...(modelId === undefined ? {} : { model: modelId }),
    });
    plannerModel = delegatedModelIdentity(backend, modelId);
  } else {
    const resolved = await resolvePlannerModel(
      project,
      policy,
      options,
      output,
    );
    if ("error" in resolved) return fail(output, json, resolved.error);
    const plannerFactory = deps.plannerFactory ?? defaultPlannerFactory;
    planner = plannerFactory({
      provider: resolved.provider,
      model: resolved.model,
      knownAgents,
    });
    plannerModel = resolved.model;
  }

  let planned: ExecutionPlan;
  try {
    planned = await planner.plan(objective, policy);
  } catch (error) {
    if (error instanceof PlanError) {
      const issues = (error.lastIssues ?? []).map(
        (issue) => `${issue.path}: ${issue.message}`,
      );
      if (json) {
        jsonLine(output, {
          ok: false,
          error: error.message,
          attempts: error.attempts,
          issues,
        });
      } else {
        output.error(error.message);
        output.error(`Attempts: ${error.attempts}`);
        for (const issue of issues) output.error(`  - ${issue}`);
      }
      return { exitCode: 1 };
    }
    throw error;
  }

  const rewrite = applyPolicyToPlan(planned, policy, project.knownAgentNames());
  if (rewrite.issues.length > 0) {
    if (json) {
      jsonLine(output, {
        ok: false,
        error: "The plan cannot be executed under this policy.",
        issues: rewrite.issues,
        notes: rewrite.notes,
      });
    } else {
      output.error("The plan cannot be executed under this policy:");
      for (const issue of rewrite.issues) output.error(`  - ${issue}`);
    }
    return { exitCode: 1 };
  }

  const router = new PolicyRouter();
  const routes: Record<string, string> = {};
  for (const task of rewrite.plan.tasks) {
    routes[task.id] = router.route(task, policy);
  }

  return {
    project,
    workspacePath,
    policy,
    plan: rewrite.plan,
    injectedReviews: rewrite.injectedReviews,
    notes: rewrite.notes,
    routes,
    plannerModel,
  };
}

function taskRow(
  task: PlannedTask,
  routes: Readonly<Record<string, string>>,
): readonly string[] {
  return [
    task.id,
    task.type,
    task.complexity,
    routes[task.id] ?? "?",
    task.dependencies.length === 0 ? "-" : task.dependencies.join(","),
    task.title,
  ];
}

/** Prints the plan preview both `/plan` and a dry-run orchestrate show. */
export function renderPlan(
  prepared: PreparedPlan,
  output: OrchestrationOutput,
  json: boolean,
): void {
  if (json) {
    jsonLine(output, {
      plan: prepared.plan,
      injectedReviews: prepared.injectedReviews,
      notes: prepared.notes,
      routes: prepared.routes,
    });
    return;
  }

  output.log(`Objective: ${prepared.plan.objective}`);
  output.log(
    `Planner: ${prepared.plannerModel.id} (${prepared.plannerModel.provider})`,
  );
  output.log(
    `Tasks: ${prepared.plan.tasks.length} (max concurrency ${prepared.policy.maxConcurrency})`,
  );
  output.log("");

  const lines = formatTable(
    ["ID", "TYPE", "COMPLEXITY", "AGENT", "DEPS", "TITLE"],
    prepared.plan.tasks.map((task) => taskRow(task, prepared.routes)),
  );
  for (const line of lines) output.log(line);

  if (prepared.injectedReviews.length > 0) {
    output.log("");
    output.log(`Injected reviews: ${prepared.injectedReviews.join(", ")}`);
  }
  if (prepared.notes.length > 0) {
    output.log("");
    printBulletList(output, "Notes", prepared.notes);
  }
}

/**
 * Why {@link PolicyRouter} would route one task — the body of the routing
 * rationale `/plan` prints. Re-derived straight from `PolicyRouter.decide` (the same decision
 * the scheduler itself makes) rather than reimplemented, so this can never
 * disagree with what actually routes the task at execution time.
 */
export interface TaskRouteExplanation {
  readonly taskId: string;
  readonly title: string;
  readonly type: string;
  readonly complexity: string;
  readonly agent: string;
  /** The model alias the target agent is configured with, when it's a known project agent. */
  readonly modelAlias?: string;
  readonly reason: RoutingReason;
  /** The routing rule that decided it, set only when `reason` is `"rule"`. */
  readonly rule?: RoutingRule;
}

function explainTaskRoute(
  task: PlannedTask,
  policy: OrchestrationPolicy,
  project: AgentProject,
): TaskRouteExplanation {
  const decision = new PolicyRouter().decide(task, policy);
  const rule =
    decision.rule === undefined
      ? undefined
      : policy.routing.find((candidate) => candidate.id === decision.rule);
  const modelAlias = project.agent(decision.agent)?.modelAlias;

  return {
    taskId: task.id,
    title: task.title,
    type: task.type,
    complexity: task.complexity,
    agent: decision.agent,
    reason: decision.reason,
    ...(modelAlias === undefined ? {} : { modelAlias }),
    ...(rule === undefined ? {} : { rule }),
  };
}

/** One sentence explaining why {@link explainTaskRoute} picked what it picked. */
function routeReasonSentence(explanation: TaskRouteExplanation): string {
  if (explanation.rule !== undefined) {
    const rule = explanation.rule;
    const criteria: string[] = [];
    if (rule.taskTypes.length > 0)
      criteria.push(`taskTypes=${rule.taskTypes.join(",")}`);
    if (rule.riskCategories.length > 0) {
      criteria.push(`riskCategories=${rule.riskCategories.join(",")}`);
    }
    if (rule.complexity.length > 0)
      criteria.push(`complexity=${rule.complexity.join(",")}`);
    const on = criteria.length === 0 ? "any task" : criteria.join(", ");
    return `rule ${rule.id} (${rule.strength}, weight ${rule.weight}) matched on ${on}`;
  }
  if (explanation.reason === "suggestedAgent") {
    return "no routing rule matched — used the plan's suggestedAgent";
  }
  return "no routing rule matched and no suggestedAgent — fell back to the policy's orchestrator";
}

/** Prints the rationale section: one line per task, below the plan table. */
function renderWhy(
  explanations: readonly TaskRouteExplanation[],
  output: OrchestrationOutput,
): void {
  output.log("Routing rationale:");
  for (const explanation of explanations) {
    const modelSuffix =
      explanation.modelAlias === undefined
        ? ""
        : ` [${explanation.modelAlias}]`;
    output.log(
      `${explanation.taskId} (${explanation.type}, ${explanation.complexity}) -> ${explanation.agent}${modelSuffix}`,
    );
    output.log(`    ${routeReasonSentence(explanation)}`);
  }
}

export type RunPlanDeps = PreparePlanDeps;

/**
 * Backs the REPL's `/plan`: preview the task graph without executing
 * anything. `options.why` additionally prints the routing rationale for one
 * task (or every task, with `true`) — see {@link explainTaskRoute}.
 */
export async function runPlan(
  objective: string,
  options: PlanCommandOptions,
  deps: RunPlanDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const prepared = await preparePlan(objective, options, deps);
  if ("exitCode" in prepared) return prepared.exitCode;

  if (options.why === undefined) {
    renderPlan(prepared, output, options.json);
    return 0;
  }

  const tasks =
    options.why === true
      ? prepared.plan.tasks
      : prepared.plan.tasks.filter((task) => task.id === options.why);
  if (tasks.length === 0) {
    const known = prepared.plan.tasks.map((task) => task.id).join(", ");
    return fail(
      output,
      options.json,
      `No task ${options.why} in this plan.${known === "" ? "" : ` Known tasks: ${known}.`}`,
    ).exitCode;
  }
  const explanations = tasks.map((task) =>
    explainTaskRoute(task, prepared.policy, prepared.project),
  );

  if (options.json) {
    jsonLine(output, {
      plan: prepared.plan,
      injectedReviews: prepared.injectedReviews,
      notes: prepared.notes,
      routes: prepared.routes,
      why: explanations,
    });
    return 0;
  }

  renderPlan(prepared, output, false);
  output.log("");
  renderWhy(explanations, output);
  return 0;
}
