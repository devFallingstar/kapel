import { ClaudeCodeBackend, CodexBackend } from "@agent/coding-agent";
import type { BackendName, EnvLike } from "./backend.js";
import { DEFAULT_BACKEND, validateBackendName } from "./backend.js";
import type { KapelBackend, KapelConfig, KapelRole } from "./config.js";
import type { ConfigWizardDeps, WizardPrompt } from "./config-wizard.js";
import { ensureKapelConfig } from "./config-wizard.js";
import { DEFAULT_MODEL_ALIAS } from "./models.js";
import type { SelectPromptIo } from "./select-prompt.js";
import { runSelectPrompt } from "./select-prompt.js";

/**
 * Where a runtime setting came from, and the one order every command applies:
 *
 *     explicit CLI flag > environment variable > ~/.kapel/config.json > default
 *
 * The order is spelled out once, here, as pure functions over their inputs —
 * every caller passes the flag it parsed, an env bag and the loaded config,
 * and nothing else in the CLI is allowed to invent its own precedence.
 *
 * The *source* travels with the value because some callers need it: a
 * delegating backend is only told which model to use when a human actually
 * chose one (see {@link delegatedModelOverride}), and "the built-in default"
 * is not a choice.
 */

export type SettingSource = "flag" | "env" | "config" | "default";

export interface ResolvedSetting<T> {
  readonly value: T;
  readonly source: SettingSource;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * The effective backend: `--backend`, then `AGENT_BACKEND`, then the stored
 * config, then `native`.
 *
 * Both the flag and the environment variable are validated, so a typo in
 * either is a printable error rather than a silent fallback; the config's
 * backend is already a checked value by the time it is parsed.
 */
export function resolveBackendSetting(
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
): ResolvedSetting<BackendName> {
  if (present(flag)) {
    return { value: validateBackendName(flag), source: "flag" };
  }
  const fromEnv = env.AGENT_BACKEND;
  if (present(fromEnv)) {
    return { value: validateBackendName(fromEnv), source: "env" };
  }
  if (config !== undefined) {
    return { value: config.backend, source: "config" };
  }
  return { value: DEFAULT_BACKEND, source: "default" };
}

/**
 * The effective model for one role: `--model`, then `AGENT_MODEL`, then the
 * stored config's model for that role, then the built-in default alias.
 *
 * `AGENT_MODEL` outranks the config for every role on purpose — it is the
 * per-shell override, and a config that could not be overridden from the
 * environment would make a one-off `AGENT_MODEL=… kapel …` impossible.
 */
export function resolveRoleModel(
  role: KapelRole,
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
): ResolvedSetting<string> {
  if (present(flag)) return { value: flag, source: "flag" };
  const fromEnv = env.AGENT_MODEL;
  if (present(fromEnv)) return { value: fromEnv, source: "env" };
  if (config !== undefined) {
    return { value: config.models[role], source: "config" };
  }
  return { value: DEFAULT_MODEL_ALIAS, source: "default" };
}

/** {@link resolveRoleModel} for the orchestrator — the model a chat or a one-shot run uses. */
export function resolveOrchestratorModel(
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
): ResolvedSetting<string> {
  return resolveRoleModel("orchestrator", flag, env, config);
}

/**
 * The model id to hand a delegating CLI through its own `--model`/`-m` flag,
 * or `undefined` to let that CLI pick.
 *
 * Two values are deliberately never forwarded: the CLI's built-in default
 * alias (`claude-sonnet-5` — an Anthropic catalog name Codex would reject),
 * and the wizard's `"default"` sentinel, which means "whatever the account
 * defaults to" and is not a model id at all.
 */
export function delegatedModelOverride(
  resolved: ResolvedSetting<string>,
): string | undefined {
  if (resolved.source === "default") return undefined;
  if (resolved.value === "default") return undefined;
  return resolved.value;
}

// --- First-run setup --------------------------------------------------------

/** The lines printed once, immediately before the first wizard question. */
export const FIRST_RUN_INTRO: readonly string[] = [
  "kapel is not configured yet — a few questions, once (skip with --no-setup).",
  "",
];

/** A {@link WizardPrompt} backed by the real terminal picker. */
export function ttyWizardPrompt(io?: SelectPromptIo): WizardPrompt {
  const target: SelectPromptIo = io ?? {
    input: process.stdin,
    output: process.stdout,
  };
  return { select: (options) => runSelectPrompt(target, options) };
}

/**
 * The wizard's availability probe: is this backend actually usable right now?
 *
 * Warn-only by contract (see `ConfigWizardDeps.checkBackend`), so the answer
 * for `native` is an offline environment check rather than a network call —
 * "you have no key configured" is the failure worth naming before someone
 * finishes setup and immediately hits a credential error.
 */
export async function checkBackendAvailability(
  backend: KapelBackend,
  env: EnvLike = process.env,
): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  if (backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    return {
      ok: availability.installed && availability.loggedIn,
      ...(availability.detail === undefined
        ? {}
        : { detail: availability.detail }),
    };
  }
  if (backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    return {
      ok: availability.installed && availability.loggedIn,
      ...(availability.detail === undefined
        ? {}
        : { detail: availability.detail }),
    };
  }
  const configured =
    present(env.ANTHROPIC_API_KEY) ||
    present(env.ANTHROPIC_AUTH_TOKEN) ||
    present(env.OPENAI_API_KEY);
  return configured
    ? { ok: true }
    : { ok: false, detail: "no provider credential is set in this shell" };
}

/** `ensureKapelConfig`, as the injection point of {@link ensureFirstRunConfig}. */
export type EnsureConfig = (
  deps: ConfigWizardDeps & { readonly interactive: boolean },
) => Promise<KapelConfig | undefined>;

export interface FirstRunOptions {
  /**
   * True only when there is a human who can answer: stdin *and* stdout are
   * terminals and the command is not producing a machine-readable stream.
   */
  readonly interactive: boolean;
  /** `--no-setup`: never ask, even on a terminal. */
  readonly noSetup?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (line: string) => void;
  /** Overridable in tests; defaults to the real wizard. */
  readonly ensure?: EnsureConfig;
  readonly io?: SelectPromptIo;
}

/**
 * The stored config, asking for one first if this is a first run.
 *
 * Everything about the fallback is silent on purpose: a piped, redirected or
 * `--no-setup` invocation gets `undefined` and carries on with env vars and
 * defaults, because a CI job that blocks on a prompt nobody can see is worse
 * than one that runs unconfigured.
 */
export async function ensureFirstRunConfig(
  options: FirstRunOptions,
): Promise<KapelConfig | undefined> {
  const interactive = options.interactive && options.noSetup !== true;
  const ensure = options.ensure ?? ensureKapelConfig;
  const write =
    options.write ??
    ((line: string): void => {
      console.log(line);
    });

  // The intro is printed from inside the prompt rather than up front, because
  // only the prompt knows the wizard is really about to run — an already
  // configured machine must print nothing at all.
  const prompt = ttyWizardPrompt(options.io);
  let announced = false;
  const announcingPrompt: WizardPrompt = {
    select: async (selectOptions) => {
      if (!announced) {
        announced = true;
        for (const line of FIRST_RUN_INTRO) write(line);
      }
      return await prompt.select(selectOptions);
    },
  };

  return await ensure({
    interactive,
    prompt: announcingPrompt,
    write,
    checkBackend: (backend) =>
      checkBackendAvailability(backend, options.env ?? process.env),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}
