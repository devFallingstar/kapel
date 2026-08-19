#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import {
  codexModelOverride,
  DEFAULT_SANDBOX_MODE,
  fullAutoForSandbox,
  resolveBackendName,
  SANDBOX_MODES,
  validateBackendName,
  validateSandboxMode,
} from "./backend.js";
import { loadDotEnvFile } from "./env.js";
import { runInit } from "./init.js";
import { listModels } from "./models.js";
import {
  DEFAULT_ISOLATION,
  DEFAULT_WORKER_MODE,
  ISOLATION_MODES,
  type OrchestrateCommandOptions,
  runOrchestrate,
  validateIsolation,
  validateWorkerMode,
  WORKER_MODES,
} from "./orchestrate.js";
import { type PlanCommandOptions, runPlan } from "./plan.js";
import {
  type PolicyCommandOptions,
  runPolicyCheck,
  runPolicyCompile,
  runPolicyExplain,
} from "./policy.js";
import { runObjective } from "./run.js";
import { runCodexObjective } from "./run-codex.js";
import { runWorkerCommand } from "./worker-cmd.js";

interface RawRunOpts {
  readonly cwd: string;
  readonly model?: string;
  readonly maxIterations: string;
  readonly timeout?: string;
  readonly yes: boolean;
  readonly json: boolean;
  readonly system?: string;
  readonly backend: string;
  readonly sandbox: string;
}

function parsePositive(raw: string, flag: string, integer: boolean): number {
  const value = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${flag} value "${raw}": expected a positive ${integer ? "integer" : "number"}.`,
    );
  }
  return value;
}

function toRunOptions(raw: RawRunOpts): Parameters<typeof runObjective>[1] {
  const maxIterations = parsePositive(
    raw.maxIterations,
    "--max-iterations",
    true,
  );
  const timeoutSeconds =
    raw.timeout === undefined
      ? undefined
      : parsePositive(raw.timeout, "--timeout", false);

  return {
    cwd: raw.cwd,
    maxIterations,
    yes: raw.yes,
    json: raw.json,
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(raw.system === undefined ? {} : { system: raw.system }),
  };
}

function toCodexRunOptions(
  raw: RawRunOpts,
): Parameters<typeof runCodexObjective>[1] {
  const timeoutSeconds =
    raw.timeout === undefined
      ? undefined
      : parsePositive(raw.timeout, "--timeout", false);
  const sandbox = validateSandboxMode(raw.sandbox);
  const model = codexModelOverride(raw.model);

  return {
    cwd: raw.cwd,
    json: raw.json,
    sandbox,
    fullAuto: fullAutoForSandbox(sandbox),
    ...(model === undefined ? {} : { model }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

async function runAndExit(
  objectiveParts: readonly string[],
  raw: RawRunOpts,
): Promise<void> {
  const objective = objectiveParts.join(" ").trim();
  if (objective === "") {
    console.error('Usage: agent [options] "<objective>"');
    process.exitCode = 1;
    return;
  }

  try {
    const backend = validateBackendName(raw.backend);
    if (backend === "codex") {
      const options = toCodexRunOptions(raw);
      process.exitCode = await runCodexObjective(objective, options);
      return;
    }
    const options = toRunOptions(raw);
    process.exitCode = await runObjective(objective, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name("agent")
  .description(
    "A multi-model coding agent: point it at a repository and an objective, " +
      "and it inspects and edits files via an LLM tool-call loop.",
  )
  .version("0.1.0")
  // These run options live on the top-level program (not repeated on `exec`)
  // so both the default command and `exec` share one definition; commander
  // resolves them for subcommands too via Command#optsWithGlobals().
  .option("--cwd <dir>", "workspace root to operate in", process.cwd())
  .option("-m, --model <alias>", "model alias to use (see `agent models`)")
  .option(
    "--max-iterations <n>",
    "maximum tool-call iterations before giving up",
    "32",
  )
  .option("--timeout <seconds>", "overall run timeout, in seconds")
  .option("-y, --yes", "auto-approve every permission prompt", false)
  .option("--json", "emit newline-delimited JSON events instead of text", false)
  .option("--system <text>", "override the default system prompt")
  .option(
    "--backend <name>",
    "execution backend to use: native | codex",
    resolveBackendName(process.env),
  )
  .option(
    "--sandbox <mode>",
    `codex sandbox mode: ${SANDBOX_MODES.join(" | ")}`,
    DEFAULT_SANDBOX_MODE,
  );

program
  .argument(
    "[objective...]",
    'the coding objective to work on, e.g. "fix the failing test"',
  )
  .action(async (objective: string[], opts: RawRunOpts) => {
    if (objective.length === 0) {
      program.help();
      return;
    }
    await runAndExit(objective, opts);
  });

program
  .command("exec")
  .description("Run the coding agent loop (same as the default command)")
  .argument("<objective...>", "the coding objective to work on")
  .action(async (objective: string[], _opts: unknown, command: Command) => {
    await runAndExit(objective, command.optsWithGlobals() as RawRunOpts);
  });

program
  .command("init")
  .description("Create a .agent configuration in the current repository")
  .option("--force", "overwrite an existing .agent directory", false)
  .action(async (opts: { force: boolean }, command: Command) => {
    const cwd = (command.optsWithGlobals() as RawRunOpts).cwd;
    process.exitCode = await runInit({
      cwd: path.resolve(cwd),
      force: opts.force,
    });
  });

program
  .command("models")
  .description("List available model aliases and provider credential status")
  .action(async (_opts: unknown, command: Command) => {
    const cwd = (command.optsWithGlobals() as RawRunOpts).cwd;
    await loadDotEnvFile(path.resolve(cwd));

    const entries = await listModels(process.env);
    if (entries.length === 0) {
      console.log("(no models registered)");
      return;
    }

    const aliasWidth = Math.max(...entries.map((entry) => entry.alias.length));
    for (const entry of entries) {
      console.log(
        `${entry.alias.padEnd(aliasWidth)}  ${entry.provider.padEnd(10)}  ${entry.credentialStatus}`,
      );
    }

    console.log();
    console.log(
      "backend codex — uses the OpenAI Codex CLI with its own ChatGPT OAuth " +
        '(run: agent --backend codex "...")',
    );
  });

function planOptions(command: Command): PlanCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...(raw.model === undefined ? {} : { model: raw.model }),
  };
}

interface RawOrchestrateOpts {
  readonly workerMode: string;
  readonly isolation: string;
  readonly dryRun: boolean;
}

function orchestrateOptions(
  command: Command,
  opts: RawOrchestrateOpts,
): OrchestrateCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  const timeoutSeconds =
    raw.timeout === undefined
      ? undefined
      : parsePositive(raw.timeout, "--timeout", false);
  const maxIterations = parsePositive(
    raw.maxIterations,
    "--max-iterations",
    true,
  );

  return {
    ...planOptions(command),
    dryRun: opts.dryRun,
    workerMode: validateWorkerMode(opts.workerMode),
    isolation: validateIsolation(opts.isolation),
    backend: validateBackendName(raw.backend),
    maxIterations,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

async function objectiveCommand(
  parts: readonly string[],
  usage: string,
  run: (objective: string) => Promise<number>,
): Promise<void> {
  const objective = parts.join(" ").trim();
  if (objective === "") {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await run(objective);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

program
  .command("plan")
  .description(
    "Plan an objective into a task graph and print it, without executing anything",
  )
  .argument("<objective...>", "the objective to plan")
  .action(async (objective: string[], _opts: unknown, command: Command) => {
    await objectiveCommand(
      objective,
      'Usage: agent plan "<objective>"',
      (text) => runPlan(text, planOptions(command)),
    );
  });

program
  .command("orchestrate")
  .description(
    "Plan an objective and execute the resulting task graph across routed workers",
  )
  .argument("<objective...>", "the objective to orchestrate")
  .option(
    "--worker-mode <mode>",
    `where workers run: ${WORKER_MODES.join(" | ")}`,
    DEFAULT_WORKER_MODE,
  )
  .option(
    "--isolation <mode>",
    `how mutating tasks are kept apart: ${ISOLATION_MODES.join(" | ")}`,
    DEFAULT_ISOLATION,
  )
  .option("--dry-run", "plan only — same output as `agent plan`", false)
  .action(
    async (objective: string[], opts: RawOrchestrateOpts, command: Command) => {
      await objectiveCommand(
        objective,
        'Usage: agent orchestrate "<objective>"',
        (text) => runOrchestrate(text, orchestrateOptions(command, opts)),
      );
    },
  );

program
  .command("worker")
  .description(
    "Run one orchestration task from a protocol request on stdin (used by --worker-mode child)",
  )
  .action(async () => {
    process.exitCode = await runWorkerCommand();
  });

function policyOptions(command: Command): PolicyCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...(raw.model === undefined ? {} : { model: raw.model }),
  };
}

const POLICY_SUBCOMMANDS = ["compile", "check", "explain"] as const;

const policyCommand = program
  .command("policy")
  .description("Manage orchestration policies (compile, check, explain)")
  .argument("[unknownCommand]", "compile | check | explain");

policyCommand
  .command("compile")
  .description(
    "Compile .agent/orchestration.md into a policy lock using an LLM",
  )
  .action(async (_opts: unknown, command: Command) => {
    process.exitCode = await runPolicyCompile(policyOptions(command));
  });

policyCommand
  .command("check")
  .description("Check that the policy lock is fresh and valid (no LLM calls)")
  .action(async (_opts: unknown, command: Command) => {
    process.exitCode = await runPolicyCheck(policyOptions(command));
  });

policyCommand
  .command("explain")
  .description("Print a human-readable summary of the compiled policy")
  .action(async (_opts: unknown, command: Command) => {
    process.exitCode = await runPolicyExplain(policyOptions(command));
  });

policyCommand.action((unknownCommand: string | undefined) => {
  // Reached only when `policy` is run with no subcommand, or with a first
  // token that doesn't match `compile` | `check` | `explain` (commander
  // dispatches recognized subcommands to their own `.action()` above
  // without ever reaching this one).
  if (unknownCommand === undefined) {
    policyCommand.help();
    return;
  }
  console.error(
    `Unknown policy command "${unknownCommand}". Expected one of: ${POLICY_SUBCOMMANDS.join(", ")}.`,
  );
  process.exitCode = 1;
});

await program.parseAsync();
