import type { KapelConfig } from "./config.js";
import { describeConfig, kapelConfigPath, loadKapelConfig } from "./config.js";
import { checkBackendAvailability, ttyWizardPrompt } from "./config-runtime.js";
import type { ConfigWizardDeps } from "./config-wizard.js";
import { runConfigWizard } from "./config-wizard.js";

/**
 * `kapel config` — the one command that exists to *write* `~/.kapel/config.json`,
 * plus the two read-only spellings people reach for when something looks wrong:
 * `--show` (what is configured) and `--path` (where it lives).
 */

export interface ConfigCommandOptions {
  readonly show?: boolean;
  readonly path?: boolean;
}

export interface ConfigCommandDeps {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  /** False when there is no terminal to run the wizard on. */
  readonly interactive: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly load?: (env?: NodeJS.ProcessEnv) => Promise<KapelConfig | undefined>;
  readonly wizard?: (
    deps: ConfigWizardDeps,
  ) => Promise<KapelConfig | undefined>;
}

export const NOT_CONFIGURED = "not configured yet — run `kapel config`";

/** Runs `kapel config [--show|--path]`. Returns the process exit code. */
export async function runConfigCommand(
  options: ConfigCommandOptions,
  deps: ConfigCommandDeps,
): Promise<number> {
  const env = deps.env;
  const filePath = kapelConfigPath(env);

  if (options.path === true) {
    deps.log(filePath);
    return 0;
  }

  const load = deps.load ?? loadKapelConfig;
  const current = await load(env);

  if (options.show === true) {
    // Exit 0 either way: "is this machine configured?" is a question, and an
    // answer of "no" is not a failure of the command that asked it.
    if (current === undefined) {
      deps.log(NOT_CONFIGURED);
      deps.log(`path: ${filePath}`);
      return 0;
    }
    for (const line of describeConfig(current)) deps.log(line);
    deps.log(`path: ${filePath}`);
    return 0;
  }

  if (!deps.interactive) {
    deps.error(
      "`kapel config` needs an interactive terminal. Use `kapel config --show` to print the current configuration.",
    );
    return 1;
  }

  const wizard = deps.wizard ?? runConfigWizard;
  const wizardDeps: ConfigWizardDeps = {
    prompt: ttyWizardPrompt(),
    write: deps.log,
    checkBackend: (backend) => checkBackendAvailability(backend, env),
    ...(current === undefined ? {} : { current }),
    ...(env === undefined ? {} : { env }),
  };

  // A cancelled wizard has already said so and written nothing; the command
  // still succeeded at doing what was asked of it.
  await wizard(wizardDeps);
  return 0;
}
