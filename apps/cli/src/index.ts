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
import { runObjective } from "./run.js";
import { runCodexObjective } from "./run-codex.js";

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

program
  .command("policy")
  .argument("<command>", "compile | check | explain")
  .description("Manage orchestration policies (not yet implemented)")
  .action((command: string) => {
    console.log(`policy ${command}: TODO`);
  });

await program.parseAsync();
