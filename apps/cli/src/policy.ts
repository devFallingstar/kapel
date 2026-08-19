import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelDefinition, ModelProvider } from "@agent/ai";
import type {
  AgentProject,
  OrchestrationPolicy,
  PolicyCompiler,
  PolicyLockfile,
} from "@agent/coding-agent";
import {
  checkLock,
  createLockfile,
  describePolicy,
  LlmPolicyCompiler,
  loadAgentProject,
  PolicyCompileError,
  ProjectConfigError,
  serializeLockfile,
  validatePolicy,
} from "@agent/coding-agent";
import { loadDotEnvFile } from "./env.js";
import { resolveModelAlias } from "./models.js";
import { resolveModelAndProvider } from "./run.js";

/** Options shared by all `kapel policy <command>` subcommands — the global `--cwd`/`-m`/`--json` flags. */
export interface PolicyCommandOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly json: boolean;
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

function printBulletList(
  output: PolicyOutput,
  label: string,
  items: readonly string[],
): void {
  if (items.length === 0) return;
  output.log(`${label}:`);
  for (const item of items) output.log(`  - ${item}`);
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

  const alias = resolveModelAlias(process.env, options.model);
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
    });
    return 0;
  }

  output.log(`Compiled policy using ${model.id} (${model.provider})`);
  output.log(`Lock written to ${lockPath}`);
  output.log(
    `Routing rules: ${result.policy.routing.length}, review rules: ${result.policy.review.length}, escalation rules: ${result.policy.escalation.length}`,
  );
  printBulletList(output, "Warnings", warnings);
  printBulletList(output, "Ambiguities", ambiguities);
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
      fresh: status.fresh,
    });
    return 0;
  }

  output.log(description);
  printBulletList(output, "Warnings", lock.warnings);
  printBulletList(output, "Ambiguities", lock.ambiguities);
  return 0;
}
