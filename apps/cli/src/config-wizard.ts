import type {
  KapelBackend,
  KapelConfig,
  KapelModels,
  KapelRole,
  KapelRoleModel,
} from "./config.js";
import {
  backendChoices,
  decodeRoleModel,
  defaultRoleModel,
  describeConfig,
  encodeRoleModel,
  KAPEL_CONFIG_VERSION,
  KAPEL_ROLES,
  loadKapelConfig,
  modelChoicesFor,
  parseBackendList,
  saveKapelConfig,
} from "./config.js";
import type { SelectChoice } from "./select-prompt.js";

/**
 * The setup wizard: five questions, in order, each one an arrow-key list —
 * the first a multi-select (which backends this machine may use at all), the
 * next four single-selects (which model, on which of those backends, each
 * role runs).
 *
 * It is written against a {@link WizardPrompt} rather than against a terminal
 * so the flow can be tested by scripting answers — the real terminal
 * implementation is `runSelectPrompt` in `select-prompt.ts`.
 */

export interface WizardPrompt {
  select(options: {
    readonly title: string;
    readonly choices: readonly SelectChoice[];
    readonly initial?: string | readonly string[];
    readonly multi?: boolean;
    readonly required?: boolean;
    readonly footer?: string;
  }): Promise<readonly string[] | undefined>;
}

export interface BackendCheckResult {
  readonly ok: boolean;
  readonly detail?: string;
  /**
   * Whether the CLI itself is present, when the backend is a delegating one
   * (`codex`/`claude-code`) — absent for `native`, which has no install step.
   * `warnIfUnavailable` uses it to tell "not installed" (today's guidance)
   * apart from "installed but not logged in" (which gets a per-backend fix
   * below instead).
   */
  readonly installed?: boolean;
}

/** What {@link runConfigWizard} hands to whoever persists its answers. */
export type SavedWizardConfig = Omit<KapelConfig, "version" | "updatedAt"> &
  Partial<Pick<KapelConfig, "updatedAt">>;

export interface ConfigWizardDeps {
  readonly prompt: WizardPrompt;
  readonly write: (line: string) => void;
  /** The config being re-run over, whose answers seed the prompts. */
  readonly current?: KapelConfig | undefined;
  /** Optional availability probe for the chosen backend. Warn-only. */
  readonly checkBackend?: (
    backend: KapelBackend,
  ) => Promise<BackendCheckResult>;
  /**
   * Runs `codex login` interactively (inheriting the terminal) and resolves
   * with the outcome, re-probed rather than assumed. Absent means the wizard
   * cannot offer to run it here — Codex installed-but-logged-out then falls
   * back to today's warn-and-continue, exactly like every other backend.
   *
   * Only ever consulted when `checkBackend` reports codex as installed but
   * not logged in; the caller (`config-runtime.ts`'s `codexLoginRunner`) is
   * the one that knows how to suspend whatever else owns the terminal around
   * the spawn.
   */
  readonly runCodexLogin?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  /**
   * {@link runCodexLogin}, for Claude Code: runs `claude auth login`
   * interactively and resolves with the re-probed outcome. Absent falls back
   * the same way — the ordinary install/login fix line, unchanged.
   */
  readonly runClaudeCodeLogin?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  readonly env?: NodeJS.ProcessEnv;
  /** `false` runs the whole flow without touching disk. Defaults to `true`. */
  readonly save?: boolean;
  /**
   * Where a saved config goes, returning the path written. Defaults to the
   * machine-level `~/.kapel/config.json`; `kapel config --project` passes one
   * that writes `<cwd>/.agent/config.local.json` instead.
   */
  readonly writeConfig?: (config: SavedWizardConfig) => Promise<string>;
  readonly now?: () => number;
}

export const BACKEND_TITLE =
  "Which coding backends should kapel use? (space to toggle, enter to confirm)";

const BACKEND_FOOTER =
  "↑↓ move · space toggle · enter confirm (at least one) · esc cancel";

const ROLE_TITLES: Readonly<Record<KapelRole, string>> = {
  orchestrator: "Main orchestrator model",
  complex: "Worker model — most complex coding tasks",
  middle: "Worker model — everyday tasks",
  low: "Worker model — small, single-function tasks",
};

/** How to get each backend working, printed when its check comes back bad. */
const BACKEND_FIX: Readonly<Record<KapelBackend, string>> = {
  "claude-code":
    "fix: npm install -g @anthropic-ai/claude-code, then `claude auth login`",
  codex: "fix: npm install -g @openai/codex, then `codex login`",
  native:
    "fix: set ANTHROPIC_API_KEY or OPENAI_API_KEY in your shell environment",
};

/**
 * Runs one single-select step. `undefined` means the user cancelled — an
 * empty answer counts as one too, since none of these questions has a
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
 * Step 1: every backend this machine may use. At least one is required, and
 * a re-run comes in with the previous answer already ticked.
 */
async function askBackends(
  deps: ConfigWizardDeps,
): Promise<readonly KapelBackend[] | undefined> {
  const values = await deps.prompt.select({
    title: BACKEND_TITLE,
    choices: backendChoices(),
    multi: true,
    required: true,
    footer: BACKEND_FOOTER,
    initial: deps.current?.backends ?? ["claude-code"],
  });
  if (values === undefined) return undefined;
  return parseBackendList(values);
}

/**
 * The initial for a role: the current config's answer when the new backend
 * selection still offers it, otherwise the suggested default for those
 * backends. Re-running the wizard after dropping a backend therefore never
 * pre-selects a model that backend was the only one to serve.
 */
function initialFor(
  backends: readonly KapelBackend[],
  role: KapelRole,
  choices: readonly SelectChoice[],
  current: KapelConfig | undefined,
): string {
  const previous = current?.models[role];
  if (previous !== undefined) {
    const encoded = encodeRoleModel(previous);
    if (choices.some((choice) => choice.value === encoded)) return encoded;
  }
  return encodeRoleModel(defaultRoleModel(backends, role));
}

const CONTINUING_LINE =
  "continuing setup — you can fix this later and re-run `kapel config`.";

/**
 * Offers to run `codex login` right now, when the wizard can: asks, and on
 * "yes" runs it (via `deps.runCodexLogin`, which suspends whatever else owns
 * the terminal and re-probes afterward) and reports the real outcome.
 *
 * Resolves `true` only when codex is confirmed logged in afterward — the
 * caller falls back to the ordinary fix line whenever this is `false`,
 * whether that is because the user said no, nothing was wired to run it, or
 * the login attempt itself did not end up logged in.
 */
async function offerCodexLogin(deps: ConfigWizardDeps): Promise<boolean> {
  const runLogin = deps.runCodexLogin;
  if (runLogin === undefined) return false;

  const answer = await ask(
    deps,
    "Codex is installed but not logged in — run `codex login` now?",
    [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    "no",
  );
  if (answer !== "yes") return false;

  deps.write("running `codex login` — follow the prompts in your terminal…");
  let result: { readonly ok: boolean; readonly detail?: string };
  try {
    result = await runLogin();
  } catch (error) {
    result = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.ok) {
    deps.write("codex: now logged in.");
    return true;
  }
  const detail = result.detail === undefined ? "" : `: ${result.detail}`;
  deps.write(`codex: still not logged in${detail}`);
  return false;
}

/** {@link offerCodexLogin}, for Claude Code — same offer, `claude auth login`. */
async function offerClaudeCodeLogin(deps: ConfigWizardDeps): Promise<boolean> {
  const runLogin = deps.runClaudeCodeLogin;
  if (runLogin === undefined) return false;

  const answer = await ask(
    deps,
    "Claude Code is installed but not logged in — run `claude auth login` now?",
    [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    "no",
  );
  if (answer !== "yes") return false;

  deps.write(
    "running `claude auth login` — follow the prompts in your terminal…",
  );
  let result: { readonly ok: boolean; readonly detail?: string };
  try {
    result = await runLogin();
  } catch (error) {
    result = {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.ok) {
    deps.write("claude-code: now logged in.");
    return true;
  }
  const detail = result.detail === undefined ? "" : `: ${result.detail}`;
  deps.write(`claude-code: still not logged in${detail}`);
  return false;
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

  // `installed === true` is what tells "not installed" (today's guidance,
  // below) apart from "installed but not logged in" (each backend's own
  // fix) — a `checkBackend` that doesn't report it at all (older callers,
  // and every hand-rolled test fake) falls straight through to today's
  // behaviour, unchanged.
  if (backend === "codex" && result.installed === true) {
    if (await offerCodexLogin(deps)) return;
    deps.write(BACKEND_FIX.codex);
    deps.write(CONTINUING_LINE);
    return;
  }

  if (backend === "claude-code" && result.installed === true) {
    if (await offerClaudeCodeLogin(deps)) return;
    deps.write(BACKEND_FIX["claude-code"]);
    deps.write(CONTINUING_LINE);
    return;
  }

  deps.write(BACKEND_FIX[backend]);
  deps.write(CONTINUING_LINE);
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

  const backends = await askBackends(deps);
  if (backends === undefined || backends.length === 0) return cancelled();

  // Every chosen backend is probed, in the order they were chosen: with two
  // selected, a logged-out one is worth hearing about even when the other is
  // fine, because roles can be pointed at either.
  for (const backend of backends) await warnIfUnavailable(deps, backend);

  const picked: Partial<Record<KapelRole, KapelRoleModel>> = {};
  for (const role of KAPEL_ROLES) {
    const choices = modelChoicesFor(backends, role);
    const answer = await ask(
      deps,
      ROLE_TITLES[role],
      choices,
      initialFor(backends, role, choices, deps.current),
    );
    if (answer === undefined) return cancelled();
    // A picker can only return one of the values it was given, so a value
    // that will not decode is a bug rather than a user answer — fall back to
    // the suggestion instead of writing nonsense to disk.
    picked[role] = decodeRoleModel(answer) ?? defaultRoleModel(backends, role);
  }

  const models: KapelModels = {
    orchestrator:
      picked.orchestrator ?? defaultRoleModel(backends, "orchestrator"),
    complex: picked.complex ?? defaultRoleModel(backends, "complex"),
    middle: picked.middle ?? defaultRoleModel(backends, "middle"),
    low: picked.low ?? defaultRoleModel(backends, "low"),
  };

  // The wizard has no permission-editing step (P1-5 is file-edited only) —
  // whatever `permission` block the config already had on disk rides along
  // unchanged rather than being dropped by this rewrite.
  const config: KapelConfig = {
    version: KAPEL_CONFIG_VERSION,
    backends,
    models,
    updatedAt: (deps.now ?? Date.now)(),
    ...(deps.current?.permission === undefined
      ? {}
      : { permission: deps.current.permission }),
  };

  for (const line of describeConfig(config)) deps.write(line);

  if (deps.save !== false) {
    const persist =
      deps.writeConfig ??
      ((saved: SavedWizardConfig) => saveKapelConfig(saved, deps.env));
    const filePath = await persist({
      backends,
      models,
      updatedAt: config.updatedAt,
      ...(config.permission === undefined
        ? {}
        : { permission: config.permission }),
    });
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
