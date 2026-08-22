import path from "node:path";
import type { KapelConfig } from "./config.js";
import { kapelConfigPath, loadKapelConfig } from "./config.js";
import type { EffectiveConfig, KapelProjectConfig } from "./config-project.js";
import {
  describeEffectiveConfig,
  hasProjectAgentDir,
  loadProjectConfig,
  MissingAgentDirError,
  mergeKapelConfigs,
  projectAgentDir,
  projectConfigPath,
  saveProjectConfig,
} from "./config-project.js";
import { checkBackendAvailability, ttyWizardPrompt } from "./config-runtime.js";
import type { ConfigWizardDeps } from "./config-wizard.js";
import { runConfigWizard } from "./config-wizard.js";

/**
 * `kapel config` — the one command that exists to *write* a configuration,
 * machine-level (`~/.kapel/config.json`) by default and per-directory
 * (`<cwd>/.agent/config.local.json`) under `--project`, plus the two
 * read-only spellings people reach for when something looks wrong: `--show`
 * (what is configured, and which file each value came from) and `--path`
 * (where it lives).
 */

export interface ConfigCommandOptions {
  readonly show?: boolean;
  readonly path?: boolean;
  /** Read/write this directory's `.agent/config.local.json` instead. */
  readonly project?: boolean;
}

export interface ConfigCommandDeps {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  /** False when there is no terminal to run the wizard on. */
  readonly interactive: boolean;
  /** The workspace `--project` and `--show` read; defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly load?: (env?: NodeJS.ProcessEnv) => Promise<KapelConfig | undefined>;
  readonly loadProject?: (
    workspacePath: string,
  ) => Promise<KapelProjectConfig | undefined>;
  readonly wizard?: (
    deps: ConfigWizardDeps,
  ) => Promise<KapelConfig | undefined>;
}

export const NOT_CONFIGURED = "not configured yet — run `kapel config`";

/** Runs `kapel config [--show|--path] [--project]`. Returns the process exit code. */
export async function runConfigCommand(
  options: ConfigCommandOptions,
  deps: ConfigCommandDeps,
): Promise<number> {
  const env = deps.env;
  const workspacePath = path.resolve(deps.cwd ?? process.cwd());
  const machinePath = kapelConfigPath(env);
  const localPath = projectConfigPath(workspacePath);
  const forProject = options.project === true;

  if (options.path === true) {
    deps.log(forProject ? localPath : machinePath);
    return 0;
  }

  const load = deps.load ?? loadKapelConfig;
  const loadLocal = deps.loadProject ?? loadProjectConfig;
  const machine = await load(env);
  const project = await loadLocal(workspacePath);

  if (options.show === true) {
    // Exit 0 either way: "is this machine configured?" is a question, and an
    // answer of "no" is not a failure of the command that asked it.
    const effective: EffectiveConfig | undefined = mergeKapelConfigs(
      machine,
      project,
    );
    if (effective === undefined) {
      deps.log(NOT_CONFIGURED);
      deps.log(`path: ${machinePath}`);
      deps.log(`project path: ${localPath} (none)`);
      return 0;
    }
    for (const line of describeEffectiveConfig(effective, {
      machine: machinePath,
      project: localPath,
    })) {
      deps.log(line);
    }
    deps.log(`path: ${machinePath}`);
    deps.log(
      `project path: ${localPath}${project === undefined ? " (none)" : ""}`,
    );
    return 0;
  }

  if (!deps.interactive) {
    deps.error(
      "`kapel config` needs an interactive terminal. Use `kapel config --show` to print the current configuration.",
    );
    return 1;
  }

  // Checked before the first question rather than at the save: making
  // someone answer five prompts and only then telling them there is nowhere
  // to put the answers would be the rudest possible ordering.
  if (forProject && !(await hasProjectAgentDir(workspacePath))) {
    deps.error(
      new MissingAgentDirError(projectAgentDir(workspacePath)).message,
    );
    return 1;
  }

  // `--project` seeds the wizard from the *effective* configuration, so a
  // re-run in a directory that only overrides one role still comes in with
  // every other answer pre-selected — and saves whatever comes out as a
  // complete project override.
  const seed = forProject
    ? mergeKapelConfigs(machine, project)?.config
    : machine;

  const wizard = deps.wizard ?? runConfigWizard;
  const wizardDeps: ConfigWizardDeps = {
    prompt: ttyWizardPrompt(),
    write: deps.log,
    checkBackend: (backend) => checkBackendAvailability(backend, env),
    ...(seed === undefined ? {} : { current: seed }),
    ...(env === undefined ? {} : { env }),
    ...(forProject
      ? {
          writeConfig: (saved) =>
            saveProjectConfig(workspacePath, {
              backends: saved.backends,
              models: saved.models,
              // Hand-edited only — the wizard never asks about MCP servers, so
              // it is carried through verbatim rather than dropped by a save
              // that was only ever about backends and models.
              ...(project?.mcp === undefined ? {} : { mcp: project.mcp }),
            }),
        }
      : {}),
  };

  try {
    // A cancelled wizard has already said so and written nothing; the command
    // still succeeded at doing what was asked of it.
    await wizard(wizardDeps);
  } catch (error) {
    if (error instanceof MissingAgentDirError) {
      deps.error(error.message);
      return 1;
    }
    throw error;
  }
  return 0;
}
