import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelDefinition, ModelProvider } from "@agent/ai";
import type {
  AgentProject,
  LocatedIssue,
  OrchestrationPolicy,
  PolicyCompiler,
  PolicyLockfile,
  SourceLocation,
} from "@agent/coding-agent";
import {
  checkLock,
  createLockfile,
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
import type { KapelConfig } from "./config.js";
import { resolveOrchestratorModel } from "./config-runtime.js";
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

export interface RunPolicyCompileDeps {
  readonly output?: PolicyOutput;
  readonly compilerFactory?: CompilerFactory;
}

/** Implements `kapel policy compile`: LLM-compiles `orchestration.md` and writes the policy lock. */
export async function runPolicyCompile(
  options: PolicyCommandOptions,
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

  const alias = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
  ).value;
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    if (options.json) jsonLine(output, { ok: false, error: resolved.error });
    else output.error(resolved.error);
    return 1;
  }
  const { model, provider } = resolved;

  const knownAgents = [...project.knownAgentNames()];
  const compilerFactory = deps.compilerFactory ?? defaultCompilerFactory;
  const compiler = compilerFactory({ provider, model, knownAgents });

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
  printLocatedList(output, "Warnings", locateIssues(warnings, markdown));
  printLocatedList(output, "Ambiguities", locateIssues(ambiguities, markdown));
  return 0;
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
 */
export async function runPolicyDiff(
  options: PolicyCommandOptions,
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

  const alias = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
  ).value;
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    if (options.json) jsonLine(output, { ok: false, error: resolved.error });
    else output.error(resolved.error);
    return 1;
  }
  const { model, provider } = resolved;

  const knownAgents = [...project.knownAgentNames()];
  const compilerFactory = deps.compilerFactory ?? defaultCompilerFactory;
  const compiler = compilerFactory({ provider, model, knownAgents });

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

  if (options.json) {
    jsonLine(output, {
      ok: true,
      unchanged: diff.unchanged,
      defaults: diff.defaults,
      routing: diff.routing,
      review: diff.review,
      escalation: diff.escalation,
      warnings: result.warnings,
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
  printLocatedList(output, "Warnings", locateIssues(result.warnings, markdown));
  printLocatedList(
    output,
    "Ambiguities",
    locateIssues(result.ambiguities, markdown),
  );
  output.log("");
  output.log("Run `kapel policy compile` to update the lock.");
  return 0;
}
