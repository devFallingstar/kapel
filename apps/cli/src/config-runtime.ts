import { ClaudeCodeBackend, CodexBackend } from "@agent/coding-agent";
import type { BackendName, EnvLike } from "./backend.js";
import {
  DEFAULT_BACKEND,
  spawnClaudeCodeLogin,
  spawnCodexLogin,
  validateBackendName,
} from "./backend.js";
import type {
  KapelBackend,
  KapelConfig,
  KapelRole,
  KapelRoleModel,
} from "./config.js";
import { soleExecutionBackend } from "./config.js";
import type { KapelProjectConfig } from "./config-project.js";
import { mergeKapelConfigs } from "./config-project.js";
import type { ConfigWizardDeps, WizardPrompt } from "./config-wizard.js";
import { ensureKapelConfig } from "./config-wizard.js";
import { DEFAULT_MODEL_ALIAS } from "./models.js";
import type { NotifySetting } from "./notify.js";
import type { SelectPromptIo } from "./select-prompt.js";
import { runSelectPrompt } from "./select-prompt.js";

/**
 * Where a runtime setting came from, and the one order every command applies:
 *
 *     explicit CLI flag > environment variable
 *       > <cwd>/.agent/config.local.json > ~/.kapel/config.json > default
 *
 * The order is spelled out once, here, as pure functions over their inputs —
 * every caller passes the flag it parsed, an env bag, the loaded machine
 * config and this directory's override, and nothing else in the CLI is
 * allowed to invent its own precedence.
 *
 * The *source* travels with the value because some callers need it: a
 * delegating backend is only told which model to use when a human actually
 * chose one (see {@link delegatedModelOverride}), and "the built-in default"
 * is not a choice.
 */

export type SettingSource =
  | "flag"
  | "env"
  | "project"
  | "config"
  | "detected"
  | "default";

export interface ResolvedSetting<T> {
  readonly value: T;
  readonly source: SettingSource;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * The effective backend: `--backend`, then `AGENT_BACKEND`, then this
 * directory's `.agent/config.local.json`, then the stored machine config,
 * then `native`.
 *
 * Both the flag and the environment variable are validated, so a typo in
 * either is a printable error rather than a silent fallback; a config's
 * backends are already checked values by the time they are parsed.
 *
 * Which backend a config yields is {@link soleExecutionBackend}'s decision —
 * the orchestrator role's — because runtime execution is still
 * single-backend in this phase.
 *
 * Callers that can await should prefer {@link detectBackendSetting}, which
 * only differs in the `default` case — where it looks for a backend that is
 * actually usable before settling for `native`.
 */
export function resolveBackendSetting(
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
  project?: KapelProjectConfig | undefined,
): ResolvedSetting<BackendName> {
  if (present(flag)) {
    return { value: validateBackendName(flag), source: "flag" };
  }
  const fromEnv = env.AGENT_BACKEND;
  if (present(fromEnv)) {
    return { value: validateBackendName(fromEnv), source: "env" };
  }
  const effective = mergeKapelConfigs(config, project);
  if (effective !== undefined) {
    return {
      value: soleExecutionBackend(effective.config),
      source:
        effective.sources.models.orchestrator === "project" ||
        effective.sources.backends === "project"
          ? "project"
          : "config",
    };
  }
  return { value: DEFAULT_BACKEND, source: "default" };
}

/**
 * The effective `notify` setting: `KAPEL_NO_NOTIFY=1`, then this directory's
 * `.agent/config.local.json`, then the stored machine config, then `"auto"`.
 *
 * `KAPEL_NO_NOTIFY` sits where a flag would in every other setting's order
 * here, ahead of both config layers — it exists for the same reason
 * `--no-altscreen` and `NO_COLOR` do: a hard, per-shell "not for this run"
 * that does not require finding and editing a config file, for a CI runner, a
 * screen-reader session, or anyone who simply never wants the bell. It is
 * spelled as an environment variable rather than a CLI flag because every
 * caller of `notify` — the REPL, `/orchestrate` inside it — is long-running
 * and has no flag of its own to carry it; `AGENT_BACKEND`/`AGENT_MODEL` are
 * `kapel`'s existing precedent for "a setting that only makes sense as a
 * shell variable". Any value other than the literal string `"1"` is not a
 * request to turn notifications off — same rule `present()` applies to every
 * other environment override below, so an accidentally-exported empty
 * `KAPEL_NO_NOTIFY=` does not silently disable the feature.
 */
export function resolveNotifySetting(
  env: EnvLike,
  config: KapelConfig | undefined,
  project?: KapelProjectConfig | undefined,
): ResolvedSetting<NotifySetting> {
  if (env.KAPEL_NO_NOTIFY === "1") {
    return { value: "off", source: "env" };
  }
  const effective = mergeKapelConfigs(config, project);
  if (effective !== undefined) {
    return {
      value: effective.config.notify ?? "auto",
      source: effective.sources.notify === "project" ? "project" : "config",
    };
  }
  return { value: "auto", source: "default" };
}

// --- Backend auto-detection -------------------------------------------------

/**
 * The probes {@link detectBackendSetting} runs, in order. Overridable in tests
 * so the detection logic can be exercised without a CLI on the machine.
 */
export interface BackendDetectionProbe {
  /** Whether the Claude Code CLI is installed *and* logged in. */
  claudeCode(): Promise<boolean>;
  /** Whether the Codex CLI is installed *and* logged in. */
  codex(): Promise<boolean>;
  /** Whether this environment carries a provider credential the native loop can use. */
  nativeCredential(env: EnvLike): boolean;
}

export const defaultBackendDetectionProbe: BackendDetectionProbe = {
  claudeCode: async () => {
    const availability = await ClaudeCodeBackend.checkAvailability();
    return availability.installed && availability.loggedIn;
  },
  codex: async () => {
    const availability = await CodexBackend.checkAvailability();
    return availability.installed && availability.loggedIn;
  },
  nativeCredential: (env) =>
    present(env.ANTHROPIC_API_KEY) ||
    present(env.ANTHROPIC_AUTH_TOKEN) ||
    present(env.OPENAI_API_KEY),
};

/**
 * The probe's verdict for this process. Each probe spawns a CLI, so it runs
 * once no matter how many callers ask; `undefined` inside the promise means
 * "nothing to detect", which is not the same as "not probed yet".
 */
let detectionCache: Promise<BackendName | undefined> | undefined;
/** Whether the one-line announcement has already been printed this process. */
let detectionAnnounced = false;

/** Forgets the cached probe and the announcement. Test-only. */
export function resetBackendDetection(): void {
  detectionCache = undefined;
  detectionAnnounced = false;
}

async function probeBackend(
  probe: BackendDetectionProbe,
  env: EnvLike,
): Promise<BackendName | undefined> {
  if (await probe.claudeCode()) return "claude-code";
  if (await probe.codex()) return "codex";
  if (probe.nativeCredential(env)) return "native";
  return undefined;
}

export interface DetectBackendDeps {
  /**
   * The probe to run. Only consulted on the first detection of the process —
   * the result is cached (see {@link detectionCache}), so a test that wants a
   * different answer calls {@link resetBackendDetection} first.
   */
  readonly probe?: BackendDetectionProbe;
  /** Where the announcement goes. Defaults to stderr, so `--json` stays clean. */
  readonly announce?: (line: string) => void;
}

/**
 * {@link resolveBackendSetting}, with one extra step for the case it cannot
 * answer honestly: nobody has chosen a backend anywhere.
 *
 * Falling straight through to `native` there is what used to send someone with
 * a logged-in `claude` sitting right next to them into a missing-credential
 * error. So when — and only when — the flag, the environment and the config
 * are all silent, the CLIs are probed in order (claude-code, then codex), then
 * a provider credential, and whatever is actually usable is chosen and said
 * out loud. With nothing usable found, the old `native` default stands, in
 * silence: a machine with no backend at all should hear about the credential,
 * not about the detection.
 *
 * The wizard path deliberately does not come through here — it asks.
 */
export async function detectBackendSetting(
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
  project?: KapelProjectConfig | undefined,
  deps: DetectBackendDeps = {},
): Promise<ResolvedSetting<BackendName>> {
  const chosen = resolveBackendSetting(flag, env, config, project);
  if (chosen.source !== "default") return chosen;

  detectionCache ??= probeBackend(
    deps.probe ?? defaultBackendDetectionProbe,
    env,
  );
  const detected = await detectionCache;
  if (detected === undefined) return chosen;

  if (!detectionAnnounced) {
    detectionAnnounced = true;
    const announce =
      deps.announce ??
      ((line: string): void => {
        console.error(line);
      });
    announce(
      `backend: ${detected} (auto-detected — set one with \`kapel config\`)`,
    );
  }
  return { value: detected, source: "detected" };
}

/**
 * The effective model for one role, and the backend that runs it: `--model`,
 * then `AGENT_MODEL`, then this directory's `.agent/config.local.json`, then
 * the stored machine config, then the built-in default alias.
 *
 * `AGENT_MODEL` outranks both config layers for every role on purpose — it is
 * the per-shell override, and a config that could not be overridden from the
 * environment would make a one-off `AGENT_MODEL=… kapel …` impossible. A
 * model that came from the flag or the environment keeps the *configured*
 * backend for that role: naming a model says nothing about who should run it,
 * and `--backend`/`AGENT_BACKEND` is how that half is overridden.
 */
export function resolveRoleModel(
  role: KapelRole,
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
  project?: KapelProjectConfig | undefined,
): ResolvedSetting<KapelRoleModel> {
  const effective = mergeKapelConfigs(config, project);
  const configured = effective?.config.models[role];
  const backend: KapelBackend = configured?.backend ?? DEFAULT_BACKEND;

  if (present(flag)) {
    return { value: { backend, model: flag }, source: "flag" };
  }
  const fromEnv = env.AGENT_MODEL;
  if (present(fromEnv)) {
    return { value: { backend, model: fromEnv }, source: "env" };
  }
  if (effective !== undefined && configured !== undefined) {
    return {
      value: configured,
      source:
        effective.sources.models[role] === "project" ? "project" : "config",
    };
  }
  return {
    value: { backend, model: DEFAULT_MODEL_ALIAS },
    source: "default",
  };
}

/** {@link resolveRoleModel} for the orchestrator — the model a chat or a one-shot run uses. */
export function resolveOrchestratorModel(
  flag: string | undefined,
  env: EnvLike,
  config: KapelConfig | undefined,
  project?: KapelProjectConfig | undefined,
): ResolvedSetting<KapelRoleModel> {
  return resolveRoleModel("orchestrator", flag, env, config, project);
}

/**
 * The model id to hand a delegating CLI through its own `--model`/`-m` flag,
 * or `undefined` to let that CLI pick.
 *
 * Takes either a bare model setting or a whole {@link KapelRoleModel} pair —
 * the pair's backend is not this function's business, only its model is.
 *
 * Two values are deliberately never forwarded: the CLI's built-in default
 * alias (`claude-sonnet-5` — an Anthropic catalog name Codex would reject),
 * and the wizard's `"default"` sentinel, which means "whatever the account
 * defaults to" and is not a model id at all.
 */
export function delegatedModelOverride(
  resolved: ResolvedSetting<string | KapelRoleModel>,
): string | undefined {
  if (resolved.source === "default") return undefined;
  const model =
    typeof resolved.value === "string" ? resolved.value : resolved.value.model;
  if (model === "default") return undefined;
  return model;
}

// --- First-run setup --------------------------------------------------------

/** The lines printed once, immediately before the first wizard question. */
export const FIRST_RUN_INTRO: readonly string[] = [
  "kapel is not configured yet — a few questions, once (skip with --no-setup).",
  "",
];

/**
 * Runs an async unit of work in isolation from whatever else owns the
 * terminal right now — e.g. a persistent `InputManager`'s `withSuspended`,
 * pausing its readline so `runSelectPrompt`'s own raw-mode keypress handling
 * doesn't fight it. Defaults to running the work as-is.
 */
export type Suspend = <T>(fn: () => Promise<T>) => Promise<T>;

const noSuspend: Suspend = (fn) => fn();

/**
 * A {@link WizardPrompt} backed by the real terminal picker.
 *
 * `suspend` lets a caller that owns a longer-lived readline (the interactive
 * REPL's `/config`) hand the terminal to the picker for the question and get
 * it back afterward; callers with nothing else on stdin can omit it.
 */
export function ttyWizardPrompt(
  io?: SelectPromptIo,
  suspend?: Suspend,
): WizardPrompt {
  const target: SelectPromptIo = io ?? {
    input: process.stdin,
    output: process.stdout,
  };
  const run = suspend ?? noSuspend;
  return { select: (options) => run(() => runSelectPrompt(target, options)) };
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
): Promise<{
  readonly ok: boolean;
  /** See `BackendCheckResult.installed` in `config-wizard.ts`. Absent for `native`. */
  readonly installed?: boolean;
  readonly detail?: string;
}> {
  if (backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    return {
      ok: availability.installed && availability.loggedIn,
      installed: availability.installed,
      ...(availability.detail === undefined
        ? {}
        : { detail: availability.detail }),
    };
  }
  if (backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    return {
      ok: availability.installed && availability.loggedIn,
      installed: availability.installed,
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

/**
 * Composes the wizard's `runCodexLogin` dependency (see `ConfigWizardDeps` in
 * `config-wizard.ts`): spawns `codex login` interactively — suspended around
 * whatever else owns the terminal, through the same {@link Suspend} seam
 * `ttyWizardPrompt` uses for the picker — then re-probes with
 * {@link checkBackendAvailability} rather than assuming the spawn worked, so
 * the wizard reports what is actually true afterward.
 */
export function codexLoginRunner(
  suspend: Suspend = noSuspend,
  env: EnvLike = process.env,
): () => Promise<{ readonly ok: boolean; readonly detail?: string }> {
  return async () => {
    const outcome = await suspend(() => spawnCodexLogin());
    if ("error" in outcome) return { ok: false, detail: outcome.error };
    const result = await checkBackendAvailability("codex", env);
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
  };
}

/**
 * {@link codexLoginRunner}, for Claude Code: spawns `claude auth login`
 * (through {@link spawnClaudeCodeLogin}) suspended the same way, then
 * re-probes with {@link checkBackendAvailability} rather than assuming the
 * spawn worked.
 */
export function claudeCodeLoginRunner(
  suspend: Suspend = noSuspend,
  env: EnvLike = process.env,
): () => Promise<{ readonly ok: boolean; readonly detail?: string }> {
  return async () => {
    const outcome = await suspend(() => spawnClaudeCodeLogin());
    if ("error" in outcome) return { ok: false, detail: outcome.error };
    const result = await checkBackendAvailability("claude-code", env);
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
  };
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
  /** See {@link Suspend}. Only meaningful when something else already owns stdin. */
  readonly suspend?: Suspend;
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
  const prompt = ttyWizardPrompt(options.io, options.suspend);
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
    // Only wired when there is actually a human to ask — a non-interactive
    // run never reaches the wizard at all (see `ensureKapelConfig`), but this
    // keeps `runCodexLogin`/`runClaudeCodeLogin` from implying otherwise.
    ...(interactive
      ? {
          runCodexLogin: codexLoginRunner(
            options.suspend,
            options.env ?? process.env,
          ),
          runClaudeCodeLogin: claudeCodeLoginRunner(
            options.suspend,
            options.env ?? process.env,
          ),
        }
      : {}),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}
