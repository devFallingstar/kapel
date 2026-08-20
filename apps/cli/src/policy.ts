import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelDefinition, ModelProvider, UsageTotals } from "@agent/ai";
import { UsageTracker, usageRecordingProvider } from "@agent/ai";
import type {
  AgentProject,
  DelegatedUsageSink,
  EscalationRule,
  LocatedIssue,
  OrchestrationPolicy,
  PolicyCompiler,
  PolicyLockfile,
  RoutingRule,
  SourceLocation,
} from "@agent/coding-agent";
import {
  checkLock,
  createLockfile,
  DelegatedPolicyCompiler,
  describePolicy,
  diffPolicies,
  formatPolicyDiff,
  formatSourceLocation,
  LlmPolicyCompiler,
  loadAgentProject,
  locateIssues,
  PolicyCompileError,
  ProjectConfigError,
  parseLockfile,
  serializeLockfile,
  validatePolicy,
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
import { resolveModelAndProvider } from "./run.js";

/** Options shared by all `kapel policy <command>` subcommands — the global `--cwd`/`-m`/`--json` flags. */
export interface PolicyCommandOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly json: boolean;
  /** The machine's configuration, when there is one; see `config-runtime.ts`. */
  readonly config?: KapelConfig;
}

/** Where a policy subcommand writes its output. Overridable in tests. */
export interface PolicyOutput {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

const consoleOutput: PolicyOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const LOCK_FILE_NAME = "orchestration.lock.json";

/** Builds the `PolicyCompiler` used by `kapel policy compile`. Overridable in tests. */
export type CompilerFactory = (args: {
  readonly provider: ModelProvider;
  readonly model: ModelDefinition;
  readonly knownAgents: readonly string[];
}) => PolicyCompiler;

const defaultCompilerFactory: CompilerFactory = (args) =>
  new LlmPolicyCompiler(args);

/** Builds the compiler used under a delegating backend. Overridable in tests. */
export type DelegatedCompilerFactory = (args: {
  readonly backend: DelegatedBackendName;
  readonly workspacePath: string;
  /** `undefined` means "let the CLI pick its own model". */
  readonly model?: string;
  readonly knownAgents: readonly string[];
  /**
   * Where the delegated compile reports what the CLI said it spent — the
   * delegating counterpart of `usageRecordingProvider` on the native path,
   * which has no provider here to wrap.
   */
  readonly usage?: DelegatedUsageSink;
}) => PolicyCompiler;

const defaultDelegatedCompilerFactory: DelegatedCompilerFactory = (args) =>
  new DelegatedPolicyCompiler(args);

function jsonLine(output: PolicyOutput, value: unknown): void {
  output.log(JSON.stringify(value));
}

/** Reads a file's UTF-8 contents, or `undefined` if it doesn't exist (or can't be read). */
async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Prints a labeled bullet list of warnings/ambiguities, each carrying a
 * best-effort {@link LocatedIssue} location: a trailing `[orchestration.md:12]`
 * when the source phrase the message quotes was found in the policy source.
 */
function printLocatedList(
  output: PolicyOutput,
  label: string,
  located: readonly LocatedIssue[],
): void {
  if (located.length === 0) return;
  output.log(`${label}:`);
  for (const item of located) {
    const suffix =
      item.location === undefined
        ? ""
        : ` [${formatSourceLocation(item.location)}]`;
    output.log(`  - ${item.message}${suffix}`);
  }
}

/** JSON-friendly parallel array: one location (or `null`) per message, in order. */
function jsonLocations(
  messages: readonly string[],
  markdown: string,
): ReadonlyArray<SourceLocation | null> {
  return locateIssues(messages, markdown).map(
    (issue) => issue.location ?? null,
  );
}

/**
 * Flags routing/escalation rule targets whose project role is `orchestrator`
 * (e.g. the default template's `lead`).
 *
 * Under a delegated backend a worker agent's tools come from its `tools:`
 * front matter; an orchestrator-role agent's tools (`task.*`, `plan.*`, …)
 * map to none of that, so dispatching one as a worker runs it with the CLI's
 * unscoped default toolset instead, where it can stall on an approval
 * prompt. This is a warning, not a validation error: `validatePolicy` already
 * rejects a target that isn't a known agent at all, so this only fires for
 * agents the project *does* define. The policy's own `orchestrator` field
 * (its planner) is unaffected — only routing/escalation targets are worker
 * dispatches.
 */
function orchestratorTargetWarnings(
  policy: OrchestrationPolicy,
  project: AgentProject,
): string[] {
  const isOrchestratorRole = (name: string): boolean =>
    project.agent(name)?.role === "orchestrator";

  const warnings: string[] = [];
  for (const rule of policy.routing as readonly RoutingRule[]) {
    if (isOrchestratorRole(rule.agent)) {
      warnings.push(
        `warning: routing rule ${rule.id} targets "${rule.agent}", an orchestrator-role agent — under codex/claude-code backends it runs without tool scoping`,
      );
    }
  }
  for (const rule of policy.escalation as readonly EscalationRule[]) {
    if (isOrchestratorRole(rule.toAgent)) {
      warnings.push(
        `warning: escalation rule ${rule.id} targets "${rule.toAgent}", an orchestrator-role agent — under codex/claude-code backends it runs without tool scoping`,
      );
    }
  }
  return warnings;
}

type ProjectLoadResult =
  | { readonly project: AgentProject; readonly markdown: string }
  | { readonly exitCode: number };

/**
 * Loads the `.agent` project and its `orchestration.md`, reporting the three
 * failure modes shared by every `policy` subcommand: no `.agent` directory,
 * an invalid `.agent` configuration, or a missing/empty orchestration
 * policy. Writes the error itself (respecting `--json`) so callers only need
 * to branch on the returned shape.
 */
async function loadProjectForPolicy(
  workspacePath: string,
  output: PolicyOutput,
  json: boolean,
): Promise<ProjectLoadResult> {
  let project: AgentProject | undefined;
  try {
    project = await loadAgentProject(workspacePath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      if (json) {
        jsonLine(output, {
          ok: false,
          error: error.message,
          file: error.file,
          problems: error.problems,
        });
      } else {
        output.error(error.message);
      }
      return { exitCode: 1 };
    }
    throw error;
  }

  if (project === undefined) {
    const message = "No .agent directory found — run `kapel init` first";
    if (json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return { exitCode: 1 };
  }

  const markdown = project.orchestrationMarkdown;
  if (markdown === undefined || markdown.trim() === "") {
    const message =
      "No orchestration policy found — .agent/orchestration.md is missing or empty";
    if (json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return { exitCode: 1 };
  }

  return { project, markdown };
}

/**
 * `kapel policy compile`, which — unlike `check` and `explain` — talks to a
 * model and therefore has to know which backend to talk through.
 */
export interface PolicyCompileOptions extends PolicyCommandOptions {
  /**
   * The resolved backend for this command. A delegated backend compiles
   * through that CLI instead of a native provider, which is what lets
   * `kapel policy compile` run with no API key at all.
   */
  readonly backend: BackendName;
}

export interface RunPolicyCompileDeps {
  readonly output?: PolicyOutput;
  readonly compilerFactory?: CompilerFactory;
  /**
   * Test-only injection point, mirroring {@link compilerFactory} and
   * `PreparePlanDeps.delegatedPlannerFactory`. Supplying it also skips the
   * CLI availability probe: an injected compiler is not going to spawn that
   * CLI.
   */
  readonly delegatedCompilerFactory?: DelegatedCompilerFactory;
}

/** The agent name a policy compile's spend is attributed to. */
const POLICY_AGENT = "policy";

/**
 * A compiler ready to run, plus the ledger it spends into.
 *
 * Both `compile` and `diff` make the same call — the difference is only what
 * they do with the result — so both resolve their compiler here, and neither
 * can end up supporting a backend the other doesn't.
 */
interface ResolvedPolicyCompiler {
  readonly compiler: PolicyCompiler;
  readonly model: ModelDefinition;
  readonly usage: UsageTracker;
  /** The CLI the compile is delegated to; `undefined` on the native path. */
  readonly delegatedTo?: DelegatedBackendName;
}

/**
 * Resolves the compiler for a policy command, along with the ledger it
 * records into.
 *
 * P1-1 (leftover): the compile call is a model turn like any other, but it
 * runs outside the agent loop and its `UsageTracker`, so it spends nothing
 * anyone sees unless it is wired to record. On the native path that means
 * wrapping the provider handed to the compiler (`usageRecordingProvider`) —
 * the same technique `orchestrate` uses for the planner (`planningThrough`
 * in `orchestrate.ts`). A delegating CLI has no provider to wrap, so it gets
 * the equivalent seam instead: a `DelegatedUsageSink` the compiler pushes
 * whatever token counts the subprocess reported into. Those two paths do not
 * report the same fidelity, and {@link policyUsageLine} is careful to say
 * "none reported" rather than print a zero the CLI never claimed.
 */
async function buildPolicyCompiler(
  options: PolicyCompileOptions,
  deps: RunPolicyCompileDeps,
  context: {
    readonly workspacePath: string;
    readonly project: AgentProject;
    readonly output: PolicyOutput;
  },
): Promise<ResolvedPolicyCompiler | { readonly exitCode: number }> {
  const { workspacePath, project, output } = context;
  const usage = new UsageTracker();
  const knownAgents = [...project.knownAgentNames()];

  const fail = (error: string): { readonly exitCode: number } => {
    if (options.json) jsonLine(output, { ok: false, error });
    else output.error(error);
    return { exitCode: 1 };
  };

  if (isDelegatedBackend(options.backend)) {
    // The whole point of a delegating backend is that the user has a CLI
    // subscription and no API key, so nothing on this path may touch the
    // provider registry — not even to name the compiler's model.
    const backend = options.backend;
    // `-m/--model` wins verbatim: the flag names a model in *that CLI's*
    // catalog, so it is forwarded untranslated. Otherwise the orchestrator's
    // model setting decides, since compiling the policy is the orchestrator's
    // kind of job; `undefined` lets the CLI pick.
    const modelId = delegatedModelOverride(
      resolveOrchestratorModel(options.model, process.env, options.config),
    );
    const factory = deps.delegatedCompilerFactory;
    if (factory === undefined) {
      const unavailable = await delegatedBackendError(backend);
      if (unavailable !== undefined) return fail(unavailable);
    }
    const model = delegatedModelIdentity(backend, modelId);
    const compiler = (factory ?? defaultDelegatedCompilerFactory)({
      backend,
      workspacePath,
      knownAgents,
      ...(modelId === undefined ? {} : { model: modelId }),
      usage: { recorder: usage, model, tags: { agent: POLICY_AGENT } },
    });
    return { compiler, model, usage, delegatedTo: backend };
  }

  const alias = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
  ).value;
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) return fail(resolved.error);
  const compilerFactory = deps.compilerFactory ?? defaultCompilerFactory;
  const compiler = compilerFactory({
    provider: usageRecordingProvider(resolved.provider, usage, {
      agent: POLICY_AGENT,
    }),
    model: resolved.model,
    knownAgents,
  });
  return { compiler, model: resolved.model, usage };
}

/** Implements `kapel policy compile`: LLM-compiles `orchestration.md` and writes the policy lock. */
export async function runPolicyCompile(
  options: PolicyCompileOptions,
  deps: RunPolicyCompileDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const loaded = await loadProjectForPolicy(
    workspacePath,
    output,
    options.json,
  );
  if ("exitCode" in loaded) return loaded.exitCode;
  const { project, markdown } = loaded;

  const built = await buildPolicyCompiler(options, deps, {
    workspacePath,
    project,
    output,
  });
  if ("exitCode" in built) return built.exitCode;
  const { compiler, model, usage, delegatedTo } = built;

  let result: Awaited<ReturnType<PolicyCompiler["compile"]>>;
  try {
    result = await compiler.compile(markdown);
  } catch (error) {
    if (error instanceof PolicyCompileError) {
      if (options.json) {
        jsonLine(output, {
          ok: false,
          error: error.message,
          attempts: error.attempts,
          issues: (error.lastIssues ?? []).map(
            (issue) => `${issue.path}: ${issue.message}`,
          ),
        });
      } else {
        output.error(error.message);
      }
      return 1;
    }
    throw error;
  }

  const validation = validatePolicy(result.policy, project.knownAgentNames());
  const validationErrors = validation.filter(
    (issue) => issue.severity === "error",
  );
  const validationWarnings = validation.filter(
    (issue) => issue.severity === "warning",
  );

  if (validationErrors.length > 0) {
    if (options.json) {
      jsonLine(output, {
        ok: false,
        errors: validationErrors.map((issue) => issue.message),
      });
    } else {
      output.error("Policy validation failed — no lock was written:");
      for (const issue of validationErrors)
        output.error(`  - ${issue.message}`);
    }
    return 1;
  }

  const lock = createLockfile({ markdown, result, model: model.id });
  const serialized = serializeLockfile(lock);
  const lockPath = path.join(project.root, LOCK_FILE_NAME);
  await writeFile(lockPath, serialized, "utf8");

  const warnings = [
    ...result.warnings,
    ...validationWarnings.map((issue) => issue.message),
    ...orchestratorTargetWarnings(result.policy, project),
  ];
  const ambiguities = result.ambiguities;

  if (options.json) {
    jsonLine(output, {
      ok: true,
      lockPath,
      policy: result.policy,
      warnings,
      ambiguities,
      // Best-effort `.agent/orchestration.md` locations for each warning/
      // ambiguity above, one entry per index (`null` when unresolved). See
      // `locateIssues` in `@agent/policy`.
      warningLocations: jsonLocations(warnings, markdown),
      ambiguityLocations: jsonLocations(ambiguities, markdown),
    });
    return 0;
  }

  output.log(`Compiled policy using ${model.id} (${model.provider})`);
  output.log(`Lock written to ${lockPath}`);
  output.log(
    `Routing rules: ${result.policy.routing.length}, review rules: ${result.policy.review.length}, escalation rules: ${result.policy.escalation.length}`,
  );
  output.log(policyUsageLine(usage.totals(), delegatedTo));
  printLocatedList(output, "Warnings", locateIssues(warnings, markdown));
  printLocatedList(output, "Ambiguities", locateIssues(ambiguities, markdown));
  return 0;
}

/**
 * `tokens — input: N, output: N  (~$X)` — what a policy compile spent.
 *
 * A delegating CLI reports token counts only when it feels like it, and never
 * a price (a subscription is not billed per token). So an empty ledger under
 * a delegated backend is reported as "none reported by the codex CLI" rather
 * than as `input: 0, output: 0`, which would read as "this compile was free"
 * — the same distinction the run summary draws between `-` and `$ n/a`.
 *
 * The native path keeps printing zeros: there the ledger is fed by the very
 * provider the compiler streams through, so an empty one really does mean no
 * tokens crossed it.
 */
function policyUsageLine(
  totals: UsageTotals,
  delegatedTo?: DelegatedBackendName,
): string {
  const nothingReported =
    totals.usage.inputTokens === 0 && totals.usage.outputTokens === 0;
  if (nothingReported && delegatedTo !== undefined) {
    return `tokens — none reported by the ${delegatedTo} CLI`;
  }
  const line = `tokens — input: ${totals.usage.inputTokens}, output: ${totals.usage.outputTokens}`;
  return totals.costUsd > 0
    ? `${line}  (~$${totals.costUsd.toFixed(4)})`
    : line;
}

/** Implements `kapel policy check`: validates the policy lock's freshness without calling an LLM. */
export async function runPolicyCheck(
  options: PolicyCommandOptions,
  deps: { readonly output?: PolicyOutput } = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const loaded = await loadProjectForPolicy(
    workspacePath,
    output,
    options.json,
  );
  if ("exitCode" in loaded) return loaded.exitCode;
  const { project, markdown } = loaded;

  const lockPath = path.join(project.root, LOCK_FILE_NAME);
  const lockContent = await readOptionalFile(lockPath);
  const status = checkLock(markdown, lockContent);

  if (!status.fresh) {
    if (options.json) {
      jsonLine(output, {
        fresh: false,
        reason: status.reason,
        ...(status.detail === undefined ? {} : { detail: status.detail }),
      });
    } else if (status.reason === "missing") {
      output.error(
        `No policy lock found at ${lockPath}. Run \`kapel policy compile\` to create one.`,
      );
    } else if (status.reason === "stale-source") {
      output.error(
        "orchestration.md has changed since the policy lock was compiled. Run `kapel policy compile` to refresh it.",
      );
    } else {
      output.error(
        `Invalid policy lock at ${lockPath}: ${status.detail ?? "unknown error"}`,
      );
    }
    return 1;
  }

  // The lock's source hash matches, but the agents it names may have been
  // renamed or removed since it was compiled — check that too.
  const validation = validatePolicy(
    status.lock.policy,
    project.knownAgentNames(),
  );
  const validationErrors = validation.filter(
    (issue) => issue.severity === "error",
  );
  if (validationErrors.length > 0) {
    if (options.json) {
      jsonLine(output, {
        fresh: true,
        errors: validationErrors.map((issue) => issue.message),
      });
    } else {
      output.error(
        "Policy lock matches orchestration.md but is no longer valid against the current agents:",
      );
      for (const issue of validationErrors)
        output.error(`  - ${issue.message}`);
    }
    return 1;
  }

  const warningCount = status.lock.warnings.length;
  if (options.json) {
    jsonLine(output, { fresh: true, warnings: warningCount });
    return 0;
  }
  output.log(
    warningCount > 0
      ? `policy lock is up to date (${warningCount} warning${warningCount === 1 ? "" : "s"})`
      : "policy lock is up to date",
  );
  return 0;
}

/** Implements `kapel policy explain`: prints a human-readable summary of the locked policy. */
export async function runPolicyExplain(
  options: PolicyCommandOptions,
  deps: { readonly output?: PolicyOutput } = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const loaded = await loadProjectForPolicy(
    workspacePath,
    output,
    options.json,
  );
  if ("exitCode" in loaded) return loaded.exitCode;
  const { project, markdown } = loaded;

  const lockPath = path.join(project.root, LOCK_FILE_NAME);
  const lockContent = await readOptionalFile(lockPath);
  const status = checkLock(markdown, lockContent);

  let lock: PolicyLockfile;
  if (status.fresh) {
    lock = status.lock;
  } else if (status.reason === "stale-source" && status.lock !== undefined) {
    lock = status.lock;
  } else if (status.reason === "missing") {
    const message = `No policy lock found at ${lockPath}. Run \`kapel policy compile\` to create one.`;
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return 1;
  } else {
    const message = `Invalid policy lock at ${lockPath}: ${status.detail ?? "unknown error"}. Run \`kapel policy compile\` to recreate it.`;
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return 1;
  }

  if (!status.fresh && !options.json) {
    output.error(
      "Warning: orchestration.md has changed since this lock was compiled — this explanation may be stale. Run `kapel policy compile` to refresh it.",
    );
  }

  const description = describePolicy(lock.policy);

  if (options.json) {
    jsonLine(output, {
      policy: lock.policy satisfies OrchestrationPolicy,
      description,
      warnings: lock.warnings,
      ambiguities: lock.ambiguities,
      // Located against the *current* orchestration.md — when the lock is
      // stale (`fresh: false` above) these are still best-effort against
      // text that may have moved since the lock was compiled.
      warningLocations: jsonLocations(lock.warnings, markdown),
      ambiguityLocations: jsonLocations(lock.ambiguities, markdown),
      fresh: status.fresh,
    });
    return 0;
  }

  output.log(description);
  printLocatedList(output, "Warnings", locateIssues(lock.warnings, markdown));
  printLocatedList(
    output,
    "Ambiguities",
    locateIssues(lock.ambiguities, markdown),
  );
  return 0;
}

export type RunPolicyDiffDeps = RunPolicyCompileDeps;

/**
 * Implements `kapel policy diff`: recompiles `orchestration.md` (same LLM
 * call as `kapel policy compile`) and diffs the result against the
 * currently locked policy, without writing anything — a way to preview what
 * `kapel policy compile` would change before committing to it.
 *
 * "Same LLM call" includes the backend: the compiler comes from the same
 * {@link buildPolicyCompiler} `compile` uses, so a delegated compile diffs
 * with no API key exactly as it compiles with none.
 */
export async function runPolicyDiff(
  options: PolicyCompileOptions,
  deps: RunPolicyDiffDeps = {},
): Promise<number> {
  const output = deps.output ?? consoleOutput;
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const loaded = await loadProjectForPolicy(
    workspacePath,
    output,
    options.json,
  );
  if ("exitCode" in loaded) return loaded.exitCode;
  const { project, markdown } = loaded;

  const lockPath = path.join(project.root, LOCK_FILE_NAME);
  const lockContent = await readOptionalFile(lockPath);
  if (lockContent === undefined || lockContent.trim() === "") {
    const message = `No policy lock found at ${lockPath}. Run \`kapel policy compile\` first — there is nothing to diff against.`;
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return 1;
  }

  let existingLock: PolicyLockfile;
  try {
    existingLock = parseLockfile(lockContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) jsonLine(output, { ok: false, error: message });
    else output.error(message);
    return 1;
  }

  const built = await buildPolicyCompiler(options, deps, {
    workspacePath,
    project,
    output,
  });
  if ("exitCode" in built) return built.exitCode;
  const { compiler, usage, delegatedTo } = built;

  let result: Awaited<ReturnType<PolicyCompiler["compile"]>>;
  try {
    result = await compiler.compile(markdown);
  } catch (error) {
    if (error instanceof PolicyCompileError) {
      if (options.json) {
        jsonLine(output, {
          ok: false,
          error: error.message,
          attempts: error.attempts,
          issues: (error.lastIssues ?? []).map(
            (issue) => `${issue.path}: ${issue.message}`,
          ),
        });
      } else {
        output.error(error.message);
      }
      return 1;
    }
    throw error;
  }

  const diff = diffPolicies(existingLock.policy, result.policy);
  const warnings = [
    ...result.warnings,
    ...orchestratorTargetWarnings(result.policy, project),
  ];

  if (options.json) {
    jsonLine(output, {
      ok: true,
      unchanged: diff.unchanged,
      defaults: diff.defaults,
      routing: diff.routing,
      review: diff.review,
      escalation: diff.escalation,
      warnings,
      ambiguities: result.ambiguities,
    });
    return 0;
  }

  output.log(
    diff.unchanged
      ? "No changes from the locked policy."
      : "Policy diff (locked -> recompiled):",
  );
  if (!diff.unchanged) {
    output.log("");
    for (const line of formatPolicyDiff(diff)) output.log(line);
  }
  // A diff costs a real compile, so it reports its spend like `compile` does.
  output.log(policyUsageLine(usage.totals(), delegatedTo));
  printLocatedList(output, "Warnings", locateIssues(warnings, markdown));
  printLocatedList(
    output,
    "Ambiguities",
    locateIssues(result.ambiguities, markdown),
  );
  output.log("");
  output.log("Run `kapel policy compile` to update the lock.");
  return 0;
}
