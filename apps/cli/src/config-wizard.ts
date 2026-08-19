import type {
  KapelBackend,
  KapelConfig,
  KapelModels,
  KapelRole,
} from "./config.js";
import {
  backendChoices,
  defaultModelsFor,
  describeConfig,
  KAPEL_CONFIG_VERSION,
  loadKapelConfig,
  modelChoicesFor,
  saveKapelConfig,
} from "./config.js";
import type { SelectChoice } from "./select-prompt.js";

/**
 * The first-run setup wizard: five questions, in order, each one an arrow-key
 * list. It is written against a {@link WizardPrompt} rather than against a
 * terminal so the flow can be tested by scripting answers — the real terminal
 * implementation is `runSelectPrompt` in `select-prompt.ts`.
 */

export interface WizardPrompt {
  select(options: {
    readonly title: string;
    readonly choices: readonly SelectChoice[];
    readonly initial?: string | readonly string[];
    readonly footer?: string;
  }): Promise<readonly string[] | undefined>;
}

export interface BackendCheckResult {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ConfigWizardDeps {
  readonly prompt: WizardPrompt;
  readonly write: (line: string) => void;
  /** The config being re-run over, whose answers seed the prompts. */
  readonly current?: KapelConfig | undefined;
  /** Optional availability probe for the chosen backend. Warn-only. */
  readonly checkBackend?: (
    backend: KapelBackend,
  ) => Promise<{ readonly ok: boolean; readonly detail?: string }>;
  readonly env?: NodeJS.ProcessEnv;
  /** `false` runs the whole flow without touching disk. Defaults to `true`. */
  readonly save?: boolean;
  readonly now?: () => number;
}

const BACKEND_TITLE = "Which coding backend should kapel use?";

const ROLE_TITLES: Readonly<Record<KapelRole, string>> = {
  orchestrator: "Main orchestrator model",
  complex: "Worker model — most complex coding tasks",
  middle: "Worker model — everyday tasks",
  low: "Worker model — small, single-function tasks",
};

const ROLES: readonly KapelRole[] = [
  "orchestrator",
  "complex",
  "middle",
  "low",
];

/** How to get each backend working, printed when its check comes back bad. */
const BACKEND_FIX: Readonly<Record<KapelBackend, string>> = {
  "claude-code":
    "fix: npm install -g @anthropic-ai/claude-code, then run `claude` once and log in",
  codex: "fix: npm install -g @openai/codex, then `codex login`",
  native:
    "fix: set ANTHROPIC_API_KEY or OPENAI_API_KEY in your shell environment",
};

function isBackend(value: string): value is KapelBackend {
  return value === "claude-code" || value === "codex" || value === "native";
}

/**
 * Runs one single-select step. `undefined` means the user cancelled — an
 * empty answer counts as one too, since none of these five questions has a
 * meaningful "nothing" answer.
 */
async function ask(
  deps: ConfigWizardDeps,
  title: string,
  choices: readonly SelectChoice[],
  initial: string,
): Promise<string | undefined> {
  const values = await deps.prompt.select({ title, choices, initial });
  if (values === undefined) return undefined;
  return values[0];
}

/**
 * The initial for a role: the current config's answer when the new backend
 * still offers it, otherwise that backend's own default. Re-running the
 * wizard after switching backends therefore never pre-selects a model the
 * chosen backend cannot use.
 */
function initialFor(
  backend: KapelBackend,
  role: KapelRole,
  choices: readonly SelectChoice[],
  current: KapelConfig | undefined,
): string {
  const previous = current?.models[role];
  if (
    previous !== undefined &&
    choices.some((choice) => choice.value === previous)
  ) {
    return previous;
  }
  return defaultModelsFor(backend)[role];
}

async function warnIfUnavailable(
  deps: ConfigWizardDeps,
  backend: KapelBackend,
): Promise<void> {
  const check = deps.checkBackend;
  if (check === undefined) return;

  let result: BackendCheckResult;
  try {
    result = await check(backend);
  } catch (error) {
    // A probe that blows up is a broken probe, not a broken backend: say so
    // and keep going, exactly as an `ok: false` would.
    result = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.ok) return;

  const detail = result.detail === undefined ? "" : `: ${result.detail}`;
  deps.write(`warning: ${backend} does not look ready${detail}`);
  deps.write(BACKEND_FIX[backend]);
  deps.write(
    "continuing setup — you can fix this later and re-run `kapel config`.",
  );
}

/**
 * Asks the five questions and (unless `save: false`) persists the answers.
 *
 * Resolves `undefined` the moment the user cancels, without writing anything:
 * a half-answered wizard must never leave a half-valid config behind.
 */
export async function runConfigWizard(
  deps: ConfigWizardDeps,
): Promise<KapelConfig | undefined> {
  const cancelled = (): undefined => {
    deps.write("setup cancelled");
    return undefined;
  };

  const backendValue = await ask(
    deps,
    BACKEND_TITLE,
    backendChoices(),
    deps.current?.backend ?? "claude-code",
  );
  if (backendValue === undefined || !isBackend(backendValue)) {
    return cancelled();
  }
  const backend: KapelBackend = backendValue;

  await warnIfUnavailable(deps, backend);

  const picked: Record<string, string> = {};
  for (const role of ROLES) {
    const choices = modelChoicesFor(backend, role);
    const answer = await ask(
      deps,
      ROLE_TITLES[role],
      choices,
      initialFor(backend, role, choices, deps.current),
    );
    if (answer === undefined) return cancelled();
    picked[role] = answer;
  }

  const defaults = defaultModelsFor(backend);
  const models: KapelModels = {
    orchestrator: picked.orchestrator ?? defaults.orchestrator,
    complex: picked.complex ?? defaults.complex,
    middle: picked.middle ?? defaults.middle,
    low: picked.low ?? defaults.low,
  };

  // The wizard has no permission-editing step (P1-5 is file-edited only) —
  // whatever `permission` block the config already had on disk rides along
  // unchanged rather than being dropped by this rewrite.
  const config: KapelConfig = {
    version: KAPEL_CONFIG_VERSION,
    backend,
    models,
    updatedAt: (deps.now ?? Date.now)(),
    ...(deps.current?.permission === undefined
      ? {}
      : { permission: deps.current.permission }),
  };

  for (const line of describeConfig(config)) deps.write(line);

  if (deps.save !== false) {
    const filePath = await saveKapelConfig(
      {
        backend,
        models,
        updatedAt: config.updatedAt,
        ...(config.permission === undefined
          ? {}
          : { permission: config.permission }),
      },
      deps.env,
    );
    deps.write(`saved to ${filePath}`);
  }

  return config;
}

/**
 * First-run detection: use the stored config when there is one, otherwise ask
 * — but only when there is a human at a terminal to ask.
 *
 * Non-interactive callers get `undefined` rather than a wizard they cannot
 * answer, and fall back to env vars and defaults; a CI job must never block
 * on a prompt.
 */
export async function ensureKapelConfig(
  deps: ConfigWizardDeps & { readonly interactive: boolean },
): Promise<KapelConfig | undefined> {
  const existing = await loadKapelConfig(deps.env);
  if (existing !== undefined) return existing;
  if (!deps.interactive) return undefined;
  return await runConfigWizard(deps);
}
