#!/usr/bin/env node
import path from "node:path";
import type { AgentImageAttachment } from "@agent/core";
import { Command } from "commander";
import type { BackendName } from "./backend.js";
import {
  BACKEND_NAMES,
  DEFAULT_SANDBOX_MODE,
  fullAutoForSandbox,
  SANDBOX_MODES,
  validateSandboxMode,
} from "./backend.js";
import type { KapelConfig } from "./config.js";
import { loadKapelConfig } from "./config.js";
import { runConfigCommand } from "./config-cmd.js";
import {
  delegatedModelOverride,
  ensureFirstRunConfig,
  resolveBackendSetting,
  resolveOrchestratorModel,
} from "./config-runtime.js";
import { loadDotEnvFile } from "./env.js";
import { runExplainCommand } from "./explain-cmd.js";
import { resolveImageAttachments } from "./images.js";
import { runInit } from "./init.js";
import {
  CLI_VERSION,
  type InteractiveOptions,
  runInteractive,
} from "./interactive.js";
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
  type PolicyCompileOptions,
  runPolicyCheck,
  runPolicyCompile,
  runPolicyDiff,
  runPolicyExplain,
} from "./policy.js";
import { type ResumeCommandOptions, runResume } from "./resume-cmd.js";
import { objectiveWithPipedStdin, runObjective } from "./run.js";
import { runClaudeCodeObjective } from "./run-claude-code.js";
import { runCodexObjective } from "./run-codex.js";
import { DEFAULT_RUNS_LIMIT, runRunsCommand } from "./runs-cmd.js";
import {
  DEFAULT_SESSIONS_LIST_LIMIT,
  runSessionsForkCommand,
  runSessionsListCommand,
} from "./sessions.js";
import { runWorkerCommand } from "./worker-cmd.js";

interface RawRunOpts {
  readonly cwd: string;
  readonly model?: string;
  readonly maxIterations: string;
  readonly timeout?: string;
  readonly yes: boolean;
  readonly json: boolean;
  readonly system?: string;
  /** Undefined unless `--backend` was actually passed; see `resolveBackendSetting`. */
  readonly backend?: string;
  readonly sandbox: string;
  /** `--no-setup`: commander sets this false when the flag is passed. */
  readonly setup?: boolean;
  /** Raw `-i/--image` paths, in the order given; see `toResolvedImages` (P1-9). */
  readonly image: readonly string[];
}

/**
 * The machine's configuration for this invocation, asking for one on a first
 * run.
 *
 * Every command that needs a model or a backend goes through here, so the
 * wizard happens exactly once, before any work — and never at all when there
 * is nobody to answer it (piped input, `--json`, `--no-setup`), when the
 * command is `kapel config` (which runs its own), or for `kapel worker`, whose
 * stdin belongs to the orchestration protocol.
 */
async function runtimeConfig(
  raw: RawRunOpts,
): Promise<KapelConfig | undefined> {
  return await ensureFirstRunConfig({
    interactive:
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true &&
      !raw.json,
    noSetup: raw.setup === false,
  });
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

/** Accumulates repeated `-i/--image <path>` flags into an ordered list. */
function collectImage(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function toRunOptions(
  raw: RawRunOpts,
  config: KapelConfig | undefined,
  images: readonly AgentImageAttachment[],
): Parameters<typeof runObjective>[1] {
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
    ...(config === undefined ? {} : { config }),
    ...(images.length === 0 ? {} : { images }),
  };
}

/** The model id a delegating CLI is told to use, or `undefined` to let it choose. */
function delegatedModel(
  raw: RawRunOpts,
  config: KapelConfig | undefined,
): string | undefined {
  return delegatedModelOverride(
    resolveOrchestratorModel(raw.model, process.env, config),
  );
}

function toCodexRunOptions(
  raw: RawRunOpts,
  config: KapelConfig | undefined,
  images: readonly AgentImageAttachment[],
): Parameters<typeof runCodexObjective>[1] {
  const timeoutSeconds =
    raw.timeout === undefined
      ? undefined
      : parsePositive(raw.timeout, "--timeout", false);
  const sandbox = validateSandboxMode(raw.sandbox);
  const model = delegatedModel(raw, config);

  return {
    cwd: raw.cwd,
    json: raw.json,
    sandbox,
    fullAuto: fullAutoForSandbox(sandbox),
    ...(model === undefined ? {} : { model }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(images.length === 0 ? {} : { images }),
  };
}

/** `--continue` / `--session`, as `chat` receives them from commander. */
interface RawChatOpts {
  readonly continue?: boolean;
  readonly session?: string;
  readonly save?: boolean;
}

function toClaudeCodeRunOptions(
  raw: RawRunOpts,
  config: KapelConfig | undefined,
  images: readonly AgentImageAttachment[],
): Parameters<typeof runClaudeCodeObjective>[1] {
  const timeoutSeconds =
    raw.timeout === undefined
      ? undefined
      : parsePositive(raw.timeout, "--timeout", false);
  const model = delegatedModel(raw, config);

  return {
    cwd: raw.cwd,
    json: raw.json,
    ...(model === undefined ? {} : { model }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(images.length === 0 ? {} : { images }),
  };
}

function toInteractiveOptions(
  raw: RawRunOpts,
  chat: RawChatOpts = {},
  config?: KapelConfig,
): InteractiveOptions {
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
    save: chat.save !== false,
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(raw.system === undefined ? {} : { system: raw.system }),
    ...(chat.continue === undefined ? {} : { continue: chat.continue }),
    ...(chat.session === undefined ? {} : { session: chat.session }),
    ...(raw.backend === undefined ? {} : { backend: raw.backend }),
    ...(config === undefined ? {} : { config }),
  };
}

/** Runs the interactive REPL, turning a setup failure into a printable error. */
async function chatAndExit(
  raw: RawRunOpts,
  chat: RawChatOpts = {},
): Promise<void> {
  try {
    const config = await runtimeConfig(raw);
    process.exitCode = await runInteractive(
      toInteractiveOptions(raw, chat, config),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runAndExit(
  objectiveParts: readonly string[],
  raw: RawRunOpts,
): Promise<void> {
  const objective = objectiveParts.join(" ").trim();
  if (objective === "") {
    console.error('Usage: kapel [options] "<objective>"');
    process.exitCode = 1;
    return;
  }

  try {
    const objectiveWithStdin = await objectiveWithPipedStdin(
      objective,
      process.stdin,
    );

    // Resolved once regardless of backend: codex forwards the original
    // paths as `-i <path>` flags, the native path sends the same base64
    // bytes read here, and claude-code fails fast on whatever comes through
    // (see `ClaudeCodeBackend.run`) — either way the file only needs to be
    // read and validated once.
    const resolvedImages = await resolveImageAttachments(raw.image, raw.cwd);
    if (!resolvedImages.ok) {
      console.error(resolvedImages.error);
      process.exitCode = 1;
      return;
    }
    const images = resolvedImages.images;

    const config = await runtimeConfig(raw);
    const backend = resolveBackendSetting(
      raw.backend,
      process.env,
      config,
    ).value;
    if (backend === "codex") {
      process.exitCode = await runCodexObjective(
        objectiveWithStdin,
        toCodexRunOptions(raw, config, images),
      );
      return;
    }
    if (backend === "claude-code") {
      process.exitCode = await runClaudeCodeObjective(
        objectiveWithStdin,
        toClaudeCodeRunOptions(raw, config, images),
      );
      return;
    }
    process.exitCode = await runObjective(
      objectiveWithStdin,
      toRunOptions(raw, config, images),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name("kapel")
  .description(
    "Kapel — a multi-model orchestration coding agent: point it at a repository " +
      "and an objective, and it plans, routes, and edits via LLM tool-call loops.",
  )
  .version(CLI_VERSION)
  // These run options live on the top-level program (not repeated on `exec`)
  // so both the default command and `exec` share one definition; commander
  // resolves them for subcommands too via Command#optsWithGlobals().
  .option("--cwd <dir>", "workspace root to operate in", process.cwd())
  .option("-m, --model <alias>", "model alias to use (see `kapel models`)")
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
    `execution backend to use: ${BACKEND_NAMES.join(" | ")} (default: native, or AGENT_BACKEND, or your \`kapel config\`)`,
  )
  .option(
    "--sandbox <mode>",
    `codex sandbox mode: ${SANDBOX_MODES.join(" | ")}`,
    DEFAULT_SANDBOX_MODE,
  )
  .option(
    "-i, --image <path>",
    "attach an image (PNG/JPEG/GIF/WEBP; repeatable, up to 4, 5 MiB each) " +
      "— supported by the native and codex backends, not claude-code",
    collectImage,
    [] as string[],
  )
  .option(
    "--no-setup",
    "skip the first-run setup wizard and use environment variables and defaults",
  );

program
  .argument(
    "[objective...]",
    'the coding objective to work on, e.g. "fix the failing test"',
  )
  .action(async (objective: string[], opts: RawRunOpts) => {
    if (objective.length === 0) {
      // No objective: on a terminal that means "talk to the agent about this
      // directory". Piped or redirected, there is nobody to talk to, so the
      // help text stays what a bare `kapel` prints.
      if (process.stdin.isTTY === true) {
        await chatAndExit(opts);
        return;
      }
      program.help();
      return;
    }
    await runAndExit(objective, opts);
  });

program
  .command("chat")
  .description(
    "Open an interactive conversation with the coding agent in this directory",
  )
  .option("-c, --continue", "resume this directory's most recent conversation")
  .option(
    "--session <id>",
    "resume a specific conversation (id, id prefix, or /name)",
  )
  .option("--no-save", "do not record this conversation in .agent/sessions.db")
  .action(async (opts: RawChatOpts, command: Command) => {
    await chatAndExit(command.optsWithGlobals() as RawRunOpts, opts);
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
    // Read-only: `kapel init` seeds the project from an existing setup, but
    // scaffolding a repository is not a reason to ask someone to configure a
    // backend they may not have chosen yet.
    const config = await loadKapelConfig();
    process.exitCode = await runInit({
      cwd: path.resolve(cwd),
      force: opts.force,
      ...(config === undefined ? {} : { config }),
    });
  });

program
  .command("config")
  .description(
    "Configure which backend and models kapel uses (stored in ~/.kapel/config.json)",
  )
  .option("--show", "print the current configuration and where it lives", false)
  .option("--path", "print the configuration file path", false)
  .action(async (opts: { show: boolean; path: boolean }) => {
    process.exitCode = await runConfigCommand(opts, {
      log: (line) => {
        console.log(line);
      },
      error: (line) => {
        console.error(line);
      },
      interactive:
        process.stdin.isTTY === true && process.stdout.isTTY === true,
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
        '(run: kapel --backend codex "...")',
    );
    console.log(
      "backend claude-code — uses the Claude Code CLI with your Claude " +
        'subscription login (run: kapel --backend claude-code "...")',
    );
  });

function planOptions(
  command: Command,
  config: KapelConfig | undefined,
): PlanCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    cwd: raw.cwd,
    json: raw.json,
    // Planning goes through the same backend the run would: under `--backend
    // codex`/`claude-code` that is what keeps `kapel plan` working with no
    // API key at all.
    backend: resolveBackendSetting(raw.backend, process.env, config).value,
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(config === undefined ? {} : { config }),
  };
}

interface RawExecutionOpts {
  readonly workerMode: string;
  readonly isolation: string;
  readonly validate: boolean;
  readonly tui: boolean;
}

interface RawOrchestrateOpts extends RawExecutionOpts {
  readonly dryRun: boolean;
  readonly save: boolean;
}

/** The execution flags `orchestrate` and `resume` share, validated. */
function executionOptions(
  command: Command,
  opts: RawExecutionOpts,
  backend: BackendName,
): Omit<ResumeCommandOptions, "cwd" | "json"> {
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
    workerMode: validateWorkerMode(opts.workerMode),
    isolation: validateIsolation(opts.isolation),
    backend,
    maxIterations,
    validate: opts.validate,
    tui: opts.tui,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

function orchestrateOptions(
  command: Command,
  opts: RawOrchestrateOpts,
  config: KapelConfig | undefined,
): OrchestrateCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    ...planOptions(command, config),
    ...executionOptions(
      command,
      opts,
      resolveBackendSetting(raw.backend, process.env, config).value,
    ),
    dryRun: opts.dryRun,
    save: opts.save,
  };
}

function resumeOptions(
  command: Command,
  opts: RawExecutionOpts,
  config: KapelConfig | undefined,
): ResumeCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...executionOptions(
      command,
      opts,
      resolveBackendSetting(raw.backend, process.env, config).value,
    ),
  };
}

/** The execution flags registered on both `orchestrate` and `resume`. */
function withExecutionOptions(command: Command): Command {
  return command
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
    .option(
      "--no-validate",
      "skip the project's configured validators for this run",
    )
    .option(
      "--tui",
      "show the live orchestration dashboard instead of event lines (not with --json)",
      false,
    );
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
  .option(
    "--why [taskId]",
    "print routing rationale for one task, or every task if no id is given",
  )
  .action(
    async (
      objective: string[],
      opts: { why?: string | boolean },
      command: Command,
    ) => {
      const config = await runtimeConfig(
        command.optsWithGlobals() as RawRunOpts,
      );
      await objectiveCommand(
        objective,
        'Usage: kapel plan "<objective>"',
        (text) =>
          runPlan(text, {
            ...planOptions(command, config),
            ...(typeof opts.why === "string"
              ? { why: opts.why }
              : opts.why === true
                ? { why: true }
                : {}),
          }),
      );
    },
  );

withExecutionOptions(
  program
    .command("orchestrate")
    .description(
      "Plan an objective and execute the resulting task graph across routed workers",
    )
    .argument("<objective...>", "the objective to orchestrate"),
)
  .option("--dry-run", "plan only — same output as `kapel plan`", false)
  .option("--no-save", "do not record this run in .agent/sessions.db")
  .action(
    async (objective: string[], opts: RawOrchestrateOpts, command: Command) => {
      const config = await runtimeConfig(
        command.optsWithGlobals() as RawRunOpts,
      );
      await objectiveCommand(
        objective,
        'Usage: kapel orchestrate "<objective>"',
        (text) =>
          runOrchestrate(text, orchestrateOptions(command, opts, config)),
      );
    },
  );

withExecutionOptions(
  program
    .command("resume")
    .description("Re-execute the unfinished tasks of a recorded run")
    .argument("<runId>", "the run to resume (see `kapel runs`)"),
).action(async (runId: string, opts: RawExecutionOpts, command: Command) => {
  try {
    const config = await runtimeConfig(command.optsWithGlobals() as RawRunOpts);
    process.exitCode = await runResume(
      runId,
      resumeOptions(command, opts, config),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});

program
  .command("runs")
  .description("List orchestration runs recorded in this workspace")
  .option("--limit <n>", "how many runs to list", String(DEFAULT_RUNS_LIMIT))
  .action(async (opts: { limit: string }, command: Command) => {
    const raw = command.optsWithGlobals() as RawRunOpts;
    try {
      process.exitCode = await runRunsCommand({
        cwd: raw.cwd,
        json: raw.json,
        limit: parsePositive(opts.limit, "--limit", true),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

const sessionsCommand = program
  .command("sessions")
  .description("List interactive chat sessions recorded in this workspace")
  .option(
    "--limit <n>",
    "how many sessions to list",
    String(DEFAULT_SESSIONS_LIST_LIMIT),
  )
  .action(async (opts: { limit: string }, command: Command) => {
    const raw = command.optsWithGlobals() as RawRunOpts;
    try {
      process.exitCode = await runSessionsListCommand({
        cwd: raw.cwd,
        json: raw.json,
        limit: parsePositive(opts.limit, "--limit", true),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

sessionsCommand
  .command("fork")
  .description(
    "Copy a chat session's transcript into a new, independent session",
  )
  .argument("<session>", "the session to fork (id, id prefix, or name)")
  .option("--name <name>", "name for the new session")
  .action(
    async (session: string, opts: { name?: string }, command: Command) => {
      const raw = command.optsWithGlobals() as RawRunOpts;
      try {
        process.exitCode = await runSessionsForkCommand({
          cwd: raw.cwd,
          json: raw.json,
          session,
          ...(opts.name === undefined ? {} : { name: opts.name }),
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    },
  );

program
  .command("explain")
  .description(
    "Explain how one task of a recorded run was routed, scheduled and finished",
  )
  .argument("<taskId>", "the task to explain, e.g. T03")
  .option("--run <runId>", "which run to read (default: the most recent)")
  .action(async (taskId: string, opts: { run?: string }, command: Command) => {
    const raw = command.optsWithGlobals() as RawRunOpts;
    try {
      process.exitCode = await runExplainCommand(taskId, {
        cwd: raw.cwd,
        json: raw.json,
        ...(opts.run === undefined ? {} : { run: opts.run }),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("worker")
  .description(
    "Run one orchestration task from a protocol request on stdin (used by --worker-mode child)",
  )
  .action(async () => {
    process.exitCode = await runWorkerCommand();
  });

function policyOptions(
  command: Command,
  config: KapelConfig | undefined,
): PolicyCommandOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    cwd: raw.cwd,
    json: raw.json,
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(config === undefined ? {} : { config }),
  };
}

/**
 * {@link policyOptions} plus the backend, resolved exactly as `planOptions`
 * resolves it: compiling the policy is a model conversation, and under
 * `--backend codex`/`claude-code` it is delegated to that CLI, which is what
 * keeps `kapel policy compile` working with no API key at all.
 *
 * `policy diff` recompiles too — the same LLM call, just thrown away instead
 * of written — so it takes the same options rather than the API-key-only
 * ones.
 */
function policyCompileOptions(
  command: Command,
  config: KapelConfig | undefined,
): PolicyCompileOptions {
  const raw = command.optsWithGlobals() as RawRunOpts;
  return {
    ...policyOptions(command, config),
    backend: resolveBackendSetting(raw.backend, process.env, config).value,
  };
}

const POLICY_SUBCOMMANDS = ["compile", "check", "explain", "diff"] as const;

const policyCommand = program
  .command("policy")
  .description("Manage orchestration policies (compile, check, explain, diff)")
  .argument("[unknownCommand]", "compile | check | explain | diff");

policyCommand
  .command("compile")
  .description(
    "Compile .agent/orchestration.md into a policy lock using an LLM",
  )
  .action(async (_opts: unknown, command: Command) => {
    const config = await runtimeConfig(command.optsWithGlobals() as RawRunOpts);
    process.exitCode = await runPolicyCompile(
      policyCompileOptions(command, config),
    );
  });

policyCommand
  .command("diff")
  .description(
    "Show what would change if the policy lock were recompiled, without writing it",
  )
  .action(async (_opts: unknown, command: Command) => {
    const config = await runtimeConfig(command.optsWithGlobals() as RawRunOpts);
    process.exitCode = await runPolicyDiff(
      policyCompileOptions(command, config),
    );
  });

policyCommand
  .command("check")
  .description("Check that the policy lock is fresh and valid (no LLM calls)")
  .action(async (_opts: unknown, command: Command) => {
    process.exitCode = await runPolicyCheck(policyOptions(command, undefined));
  });

policyCommand
  .command("explain")
  .description("Print a human-readable summary of the compiled policy")
  .action(async (_opts: unknown, command: Command) => {
    process.exitCode = await runPolicyExplain(
      policyOptions(command, undefined),
    );
  });

policyCommand.action((unknownCommand: string | undefined) => {
  // Reached only when `policy` is run with no subcommand, or with a first
  // token that doesn't match `compile` | `check` | `explain` | `diff` (commander
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
