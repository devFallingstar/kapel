import path from "node:path";
import { Command } from "commander";
import { BACKEND_NAMES } from "./backend.js";
import type { KapelConfig } from "./config.js";
import { loadKapelConfig } from "./config.js";
import { runConfigCommand } from "./config-cmd.js";
import type { KapelProjectConfig } from "./config-project.js";
import { loadProjectConfig, mergeKapelConfigs } from "./config-project.js";
import {
  detectBackendSetting,
  ensureFirstRunConfig,
} from "./config-runtime.js";
import { loadDotEnvFile } from "./env.js";
import { runExplainCommand } from "./explain-cmd.js";
import { runInit } from "./init.js";
import {
  CLI_VERSION,
  type InteractiveOptions,
  runInteractive,
} from "./interactive.js";
import { listModels } from "./models.js";
import {
  type PolicyCommandOptions,
  type PolicyCompileOptions,
  runPolicyCheck,
  runPolicyCompile,
  runPolicyDiff,
  runPolicyEdit,
  runPolicyExplain,
} from "./policy.js";
import { ttyPolicyEditPrompt } from "./policy-edit.js";
import { DEFAULT_RUNS_LIMIT, runRunsCommand } from "./runs-cmd.js";
import {
  DEFAULT_SESSIONS_LIST_LIMIT,
  runSessionsForkCommand,
  runSessionsListCommand,
} from "./sessions.js";

/**
 * The options every command shares.
 *
 * Deliberately short: kapel is REPL-first, so the flags that used to configure
 * a one-shot run (`-i/--image`, `-y/--yes`, `--system`, `--max-iterations`,
 * `--json`, `--sandbox`, `--worker-mode`) went with it. What is left is the
 * three things any invocation may need to point somewhere else — a directory,
 * a model, a backend — plus a timeout and the setup opt-out. `--json` still
 * exists, but only on the query commands that actually emit machine-readable
 * output, as a local option of each.
 */
interface GlobalOpts {
  readonly cwd: string;
  readonly model?: string;
  readonly timeout?: string;
  /** Undefined unless `--backend` was actually passed; see `resolveBackendSetting`. */
  readonly backend?: string;
  /** `--no-setup`: commander sets this false when the flag is passed. */
  readonly setup?: boolean;
  /**
   * `--altscreen` sets this true, `--no-altscreen` false; the REPL's default
   * (the normal screen) applies when neither flag was passed.
   */
  readonly altscreen?: boolean;
}

/**
 * The machine's configuration for this invocation, asking for one on a first
 * run.
 *
 * Every command that needs a model or a backend goes through here, so the
 * wizard happens exactly once, before any work — and never at all when there
 * is nobody to answer it (piped input, a `--json` query, `--no-setup`), or
 * when the command is `kapel config`, which runs its own.
 */
async function runtimeConfig(
  raw: GlobalOpts,
  json = false,
): Promise<KapelConfig | undefined> {
  return await ensureFirstRunConfig({
    interactive:
      process.stdin.isTTY === true && process.stdout.isTTY === true && !json,
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

/** `--continue` / `--session` / `--no-save`, as `chat` receives them. */
interface RawChatOpts {
  readonly continue?: boolean;
  readonly session?: string;
  readonly save?: boolean;
}

/**
 * This directory's `.agent/config.local.json`, if it has one.
 *
 * Loaded per command rather than once, because `--cwd` makes the workspace a
 * per-invocation fact; a malformed file warns once on stderr from inside the
 * loader and is then ignored.
 */
async function projectConfigFor(
  raw: GlobalOpts,
): Promise<KapelProjectConfig | undefined> {
  return await loadProjectConfig(path.resolve(raw.cwd));
}

function toInteractiveOptions(
  raw: GlobalOpts,
  chat: RawChatOpts = {},
  config?: KapelConfig,
  projectConfig?: KapelProjectConfig,
): InteractiveOptions {
  const timeoutSeconds =
    raw.timeout === undefined
      ? undefined
      : parsePositive(raw.timeout, "--timeout", false);

  return {
    cwd: raw.cwd,
    save: chat.save !== false,
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(chat.continue === undefined ? {} : { continue: chat.continue }),
    ...(chat.session === undefined ? {} : { session: chat.session }),
    ...(raw.backend === undefined ? {} : { backend: raw.backend }),
    // Carried through so the REPL's own setup question — the automatic
    // project onboarding offer — obeys the same flag the wizard does.
    ...(raw.setup === undefined ? {} : { setup: raw.setup }),
    // `--no-altscreen`, spelled `altScreen` inside the REPL.
    ...(raw.altscreen === undefined ? {} : { altScreen: raw.altscreen }),
    ...(config === undefined ? {} : { config }),
    ...(projectConfig === undefined ? {} : { projectConfig }),
  };
}

/** Runs the interactive REPL, turning a setup failure into a printable error. */
async function chatAndExit(
  raw: GlobalOpts,
  chat: RawChatOpts = {},
): Promise<void> {
  try {
    const config = await runtimeConfig(raw);
    const projectConfig = await projectConfigFor(raw);
    process.exitCode = await runInteractive(
      toInteractiveOptions(raw, chat, config, projectConfig),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Builds the CLI's commander program, without parsing anything.
 *
 * Separate from the `kapel` entry point (`index.ts`) so the command surface —
 * which commands exist, which flags they take, what a removed one answers —
 * can be asserted directly, instead of only through a spawned process.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("kapel")
    .description(
      "Kapel — a multi-model orchestration coding agent. Run `kapel` with no " +
        "command to open the REPL, where the agent plans, routes and edits; the " +
        "commands below set it up and inspect what it did.",
    )
    .version(CLI_VERSION)
    // `[args...]` below would otherwise show up in the usage line beside
    // `[command]`; it exists only to catch a removed or misspelled command.
    .usage("[options] [command]")
    // A program with its own action handler suppresses commander's implicit
    // `help` command, and `kapel help` is worth keeping.
    .helpCommand(true)
    .option("--cwd <dir>", "workspace root to operate in", process.cwd())
    .option(
      "-m, --model <alias>",
      "override the planner/orchestrator model (see `kapel models`)",
    )
    .option("--timeout <seconds>", "model call timeout, in seconds")
    .option(
      "--backend <name>",
      `override the execution backend: ${BACKEND_NAMES.join(" | ")} (default: AGENT_BACKEND, your \`kapel config\`, or auto-detected)`,
    )
    .option(
      "--no-setup",
      "skip the first-run setup wizard and use environment variables and defaults",
    )
    .option(
      "--altscreen",
      "run the REPL on the alternate screen (a clean screen that restores your terminal on exit; no scrollback while inside)",
    )
    .option(
      "--no-altscreen",
      "keep the REPL on the terminal's normal screen — the default — so the transcript stays in your scrollback and the mouse wheel scrolls it",
    );

  program
    .argument("[args...]")
    .action(async (args: string[], opts: GlobalOpts) => {
      if (args.length > 0) {
        // Commander's own wording, because a removed command deserves the same
        // terse answer as a misspelled one — and nothing more.
        program.error(`error: unknown command '${args[0]}'`, {
          code: "commander.unknownCommand",
        });
      }
      // On a terminal, no command means "talk to the agent about this
      // directory". Piped or redirected, there is nobody to talk to, so the
      // help text stays what a bare `kapel` prints.
      if (process.stdin.isTTY === true) {
        await chatAndExit(opts);
        return;
      }
      program.help();
    });

  program
    .command("chat")
    .description(
      "Open the interactive REPL — where all agent work happens (same as bare `kapel`)",
    )
    .option(
      "-c, --continue",
      "resume this directory's most recent conversation",
    )
    .option(
      "--session <id>",
      "resume a specific conversation (id, id prefix, or /name)",
    )
    .option(
      "--no-save",
      "do not record this conversation in .agent/sessions.db",
    )
    .action(async (opts: RawChatOpts, command: Command) => {
      await chatAndExit(command.optsWithGlobals() as GlobalOpts, opts);
    });

  program
    .command("init")
    .description("Create a .agent configuration in the current repository")
    .option("--force", "overwrite an existing .agent directory", false)
    .action(async (opts: { force: boolean }, command: Command) => {
      const raw = command.optsWithGlobals() as GlobalOpts;
      const cwd = path.resolve(raw.cwd);
      // Read-only: `kapel init` seeds the project from an existing setup, but
      // scaffolding a repository is not a reason to ask someone to configure a
      // backend they may not have chosen yet. A re-init over a directory that
      // already has an override seeds from the effective view, so the models
      // written into `.agent/config.yaml` are the ones this directory runs.
      const config = mergeKapelConfigs(
        await loadKapelConfig(),
        await loadProjectConfig(cwd),
      )?.config;
      process.exitCode = await runInit({
        cwd,
        force: opts.force,
        ...(config === undefined ? {} : { config }),
      });
    });

  program
    .command("config")
    .description(
      "Manage which backends and models kapel uses (stored in ~/.kapel/config.json, or this directory's .agent/config.local.json with --project)",
    )
    .option(
      "--show",
      "print the effective configuration and which file each value came from",
      false,
    )
    .option("--path", "print the configuration file path", false)
    .option(
      "--project",
      "read/write this directory's .agent/config.local.json instead of the machine-level file",
      false,
    )
    .action(
      async (
        opts: { show: boolean; path: boolean; project: boolean },
        command: Command,
      ) => {
        const raw = command.optsWithGlobals() as GlobalOpts;
        process.exitCode = await runConfigCommand(opts, {
          log: (line) => {
            console.log(line);
          },
          error: (line) => {
            console.error(line);
          },
          cwd: path.resolve(raw.cwd),
          interactive:
            process.stdin.isTTY === true && process.stdout.isTTY === true,
        });
      },
    );

  program
    .command("models")
    .description("List available model aliases and provider credential status")
    .action(async (_opts: unknown, command: Command) => {
      const cwd = (command.optsWithGlobals() as GlobalOpts).cwd;
      await loadDotEnvFile(path.resolve(cwd));

      const entries = await listModels(process.env);
      if (entries.length === 0) {
        console.log("(no models registered)");
        return;
      }

      const aliasWidth = Math.max(
        ...entries.map((entry) => entry.alias.length),
      );
      for (const entry of entries) {
        console.log(
          `${entry.alias.padEnd(aliasWidth)}  ${entry.provider.padEnd(10)}  ${entry.credentialStatus}`,
        );
      }

      console.log();
      console.log(
        "backend codex — uses the OpenAI Codex CLI with its own ChatGPT OAuth " +
          "(select it with `kapel config`, or `kapel --backend codex`)",
      );
      console.log(
        "backend claude-code — uses the Claude Code CLI with your Claude " +
          "subscription login (same two ways)",
      );
    });

  program
    .command("runs")
    .description("List orchestration runs recorded in this workspace")
    .option("--limit <n>", "how many runs to list", String(DEFAULT_RUNS_LIMIT))
    .option("--json", "emit the listing as JSON", false)
    .action(
      async (opts: { limit: string; json: boolean }, command: Command) => {
        const raw = command.optsWithGlobals() as GlobalOpts;
        try {
          process.exitCode = await runRunsCommand({
            cwd: raw.cwd,
            json: opts.json,
            limit: parsePositive(opts.limit, "--limit", true),
          });
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      },
    );

  const sessionsCommand = program
    .command("sessions")
    .description("List interactive chat sessions recorded in this workspace")
    .option(
      "--limit <n>",
      "how many sessions to list",
      String(DEFAULT_SESSIONS_LIST_LIMIT),
    )
    .option("--json", "emit the listing as JSON", false)
    .action(
      async (opts: { limit: string; json: boolean }, command: Command) => {
        const raw = command.optsWithGlobals() as GlobalOpts;
        try {
          process.exitCode = await runSessionsListCommand({
            cwd: raw.cwd,
            json: opts.json,
            limit: parsePositive(opts.limit, "--limit", true),
          });
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      },
    );

  sessionsCommand
    .command("fork")
    .description(
      "Copy a chat session's transcript into a new, independent session",
    )
    .argument("<session>", "the session to fork (id, id prefix, or name)")
    .option("--name <name>", "name for the new session")
    .option("--json", "emit the result as JSON", false)
    .action(
      async (
        session: string,
        opts: { name?: string; json: boolean },
        command: Command,
      ) => {
        const raw = command.optsWithGlobals() as GlobalOpts;
        try {
          process.exitCode = await runSessionsForkCommand({
            cwd: raw.cwd,
            json: opts.json,
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
    .option("--json", "emit the explanation as JSON", false)
    .action(
      async (
        taskId: string,
        opts: { run?: string; json: boolean },
        command: Command,
      ) => {
        const raw = command.optsWithGlobals() as GlobalOpts;
        try {
          process.exitCode = await runExplainCommand(taskId, {
            cwd: raw.cwd,
            json: opts.json,
            ...(opts.run === undefined ? {} : { run: opts.run }),
          });
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      },
    );

  function policyOptions(
    command: Command,
    json: boolean,
    config: KapelConfig | undefined,
    projectConfig?: KapelProjectConfig,
  ): PolicyCommandOptions {
    const raw = command.optsWithGlobals() as GlobalOpts;
    return {
      cwd: raw.cwd,
      json,
      ...(raw.model === undefined ? {} : { model: raw.model }),
      ...(config === undefined ? {} : { config }),
      ...(projectConfig === undefined ? {} : { projectConfig }),
    };
  }

  /**
   * {@link policyOptions} plus the backend, resolved the way every model
   * conversation resolves it: compiling the policy is an LLM call, and under
   * `--backend codex`/`claude-code` it is delegated to that CLI, which is what
   * keeps `kapel policy compile` working with no API key at all. With nothing
   * chosen anywhere, {@link detectBackendSetting} looks for a logged-in CLI
   * before falling back to native.
   *
   * `policy diff` recompiles too — the same LLM call, just thrown away instead
   * of written — so it takes the same options rather than the API-key-only
   * ones.
   */
  async function policyCompileOptions(
    command: Command,
    json: boolean,
    config: KapelConfig | undefined,
  ): Promise<PolicyCompileOptions> {
    const raw = command.optsWithGlobals() as GlobalOpts;
    const projectConfig = await projectConfigFor(raw);
    return {
      ...policyOptions(command, json, config, projectConfig),
      backend: (
        await detectBackendSetting(
          raw.backend,
          process.env,
          config,
          projectConfig,
        )
      ).value,
    };
  }

  const POLICY_SUBCOMMANDS = ["compile", "check", "explain", "diff"] as const;

  const policyCommand = program
    .command("policy")
    .description(
      "Manage orchestration policies (edit, compile, check, explain, diff)",
    )
    .argument("[unknownCommand]", "edit | compile | check | explain | diff");

  policyCommand
    .command("edit")
    .description(
      "Edit the orchestration policy and rewrite it in canonical form (no LLM calls)",
    )
    .action(async (_opts: unknown, command: Command) => {
      // No `runtimeConfig` here on purpose: the editor never resolves a model
      // or a backend, so a machine with neither still edits its policy.
      process.exitCode = await runPolicyEdit(
        policyOptions(command, false, undefined),
        process.stdin.isTTY === true && process.stdout.isTTY === true
          ? { prompt: ttyPolicyEditPrompt() }
          : {},
      );
    });

  policyCommand
    .command("compile")
    .description(
      "Compile .agent/orchestration.md into a policy lock, calling an LLM only for a policy written as prose",
    )
    .option("--json", "emit the compile result as JSON", false)
    .action(async (opts: { json: boolean }, command: Command) => {
      const config = await runtimeConfig(
        command.optsWithGlobals() as GlobalOpts,
        opts.json,
      );
      process.exitCode = await runPolicyCompile(
        await policyCompileOptions(command, opts.json, config),
      );
    });

  policyCommand
    .command("diff")
    .description(
      "Show what would change if the policy lock were recompiled, without writing it",
    )
    .option("--json", "emit the diff as JSON", false)
    .action(async (opts: { json: boolean }, command: Command) => {
      const config = await runtimeConfig(
        command.optsWithGlobals() as GlobalOpts,
        opts.json,
      );
      process.exitCode = await runPolicyDiff(
        await policyCompileOptions(command, opts.json, config),
      );
    });

  policyCommand
    .command("check")
    .description("Check that the policy lock is fresh and valid (no LLM calls)")
    .option("--json", "emit the result as JSON", false)
    .action(async (opts: { json: boolean }, command: Command) => {
      process.exitCode = await runPolicyCheck(
        policyOptions(command, opts.json, undefined),
      );
    });

  policyCommand
    .command("explain")
    .description("Print a human-readable summary of the compiled policy")
    .option("--json", "emit the summary as JSON", false)
    .action(async (opts: { json: boolean }, command: Command) => {
      process.exitCode = await runPolicyExplain(
        policyOptions(command, opts.json, undefined),
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

  return program;
}
