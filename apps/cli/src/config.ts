import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defaultModelCatalog } from "@agent/ai";
import type { SelectChoice } from "./select-prompt.js";

/**
 * Machine-level kapel configuration: the answers the first-run wizard asks
 * for, stored once per user rather than once per repository.
 *
 * It lives next to the user, not next to the code, because "which coding
 * backend am I logged into" and "which models may I use" are facts about the
 * machine — checking them into a project would be wrong for everyone else on
 * it.
 */

export const KAPEL_CONFIG_VERSION = 2;

export type KapelBackend = "claude-code" | "codex" | "native";

const BACKENDS: readonly KapelBackend[] = ["claude-code", "codex", "native"];

export type KapelRole = "orchestrator" | "complex" | "middle" | "low";

export interface KapelModels {
  readonly orchestrator: string;
  /** The most complex coding work: cross-cutting changes, gnarly debugging. */
  readonly complex: string;
  /** Everyday, moderate implementation work. */
  readonly middle: string;
  /** Small, single-function-sized changes and read-only exploration. */
  readonly low: string;
}

export interface KapelConfig {
  readonly version: number;
  readonly backend: KapelBackend;
  readonly models: KapelModels;
  readonly updatedAt: number;
}

// --- Location ---------------------------------------------------------------

function envValue(
  env: NodeJS.ProcessEnv | undefined,
  name: string,
): string | undefined {
  const value = (env ?? process.env)[name];
  return value === undefined || value === "" ? undefined : value;
}

/** `$KAPEL_CONFIG_DIR`, or `~/.kapel`. */
export function kapelConfigDir(env?: NodeJS.ProcessEnv): string {
  return envValue(env, "KAPEL_CONFIG_DIR") ?? path.join(homedir(), ".kapel");
}

/** The config file itself: `<dir>/config.json`. */
export function kapelConfigPath(env?: NodeJS.ProcessEnv): string {
  return path.join(kapelConfigDir(env), "config.json");
}

// --- Reading and writing ----------------------------------------------------

function isBackend(value: unknown): value is KapelBackend {
  return (
    typeof value === "string" && (BACKENDS as readonly string[]).includes(value)
  );
}

function modelString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Migrates a version-1 `models` block onto the version-2 slots.
 *
 * Version 1 had three slots — `orchestrator`, `worker` ("normal complexity")
 * and `cheap` ("low complexity / exploration"). Version 2 splits the worker
 * tier in two, so the mapping is:
 *
 *     orchestrator := orchestrator
 *     complex      := worker      (an approximation — see below)
 *     middle       := worker
 *     low          := cheap
 *
 * `complex := worker` is the honest approximation: version 1 never asked
 * which model should take the hardest implementation work, so the best guess
 * available is the one worker model the user did pick. It is deliberately not
 * promoted to the orchestrator's model — silently spending a bigger model
 * than anyone asked for is worse than under-reaching, and `kapel config`
 * re-runs the wizard with these values pre-selected.
 *
 * Migration happens in memory only. Nothing is rewritten on disk until the
 * user saves a config, which {@link saveKapelConfig} always writes as
 * version 2.
 */
function migrateV1Models(
  modelRecord: Record<string, unknown>,
): KapelModels | undefined {
  const orchestrator = modelString(modelRecord.orchestrator);
  const worker = modelString(modelRecord.worker);
  const cheap = modelString(modelRecord.cheap);
  if (
    orchestrator === undefined ||
    worker === undefined ||
    cheap === undefined
  ) {
    return undefined;
  }
  return { orchestrator, complex: worker, middle: worker, low: cheap };
}

function parseV2Models(
  modelRecord: Record<string, unknown>,
): KapelModels | undefined {
  const orchestrator = modelString(modelRecord.orchestrator);
  const complex = modelString(modelRecord.complex);
  const middle = modelString(modelRecord.middle);
  const low = modelString(modelRecord.low);
  if (
    orchestrator === undefined ||
    complex === undefined ||
    middle === undefined ||
    low === undefined
  ) {
    return undefined;
  }
  return { orchestrator, complex, middle, low };
}

function parseConfig(raw: unknown): KapelConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const version = record.version;
  if (version !== KAPEL_CONFIG_VERSION && version !== 1) return undefined;
  if (!isBackend(record.backend)) return undefined;

  const models = record.models;
  if (typeof models !== "object" || models === null) return undefined;
  const modelRecord = models as Record<string, unknown>;
  const parsed =
    version === 1 ? migrateV1Models(modelRecord) : parseV2Models(modelRecord);
  if (parsed === undefined) return undefined;

  const updatedAt = record.updatedAt;
  return {
    version: KAPEL_CONFIG_VERSION,
    backend: record.backend,
    models: parsed,
    updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
  };
}

/**
 * Reads the stored config.
 *
 * Anything unreadable — missing, truncated, hand-edited into nonsense, or
 * written by a future version — reads as `undefined` rather than throwing:
 * the only consequence of an unusable config is that the wizard offers to
 * write a new one, which is strictly better than refusing to start.
 *
 * A version-1 file is *not* unreadable: it is migrated in memory by
 * {@link migrateV1Models}, because throwing away a working setup over a slot
 * rename would be hostile.
 */
export async function loadKapelConfig(
  env?: NodeJS.ProcessEnv,
): Promise<KapelConfig | undefined> {
  let text: string;
  try {
    text = await readFile(kapelConfigPath(env), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Writes the config, creating `~/.kapel` if needed, and returns its path.
 *
 * The file is chmod-ed to 0600 on a best-effort basis: it holds no secrets
 * today, but it decides which account's models get spent, and the permission
 * call is a no-op-ish failure on Windows rather than something to abort over.
 */
export async function saveKapelConfig(
  config: Omit<KapelConfig, "version" | "updatedAt"> &
    Partial<Pick<KapelConfig, "updatedAt">>,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const filePath = kapelConfigPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });

  const full: KapelConfig = {
    version: KAPEL_CONFIG_VERSION,
    backend: config.backend,
    models: {
      orchestrator: config.models.orchestrator,
      complex: config.models.complex,
      middle: config.models.middle,
      low: config.models.low,
    },
    updatedAt: config.updatedAt ?? Date.now(),
  };

  await writeFile(filePath, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best effort: Windows and exotic filesystems do not have to cooperate.
  }
  return filePath;
}

// --- Choice lists -----------------------------------------------------------

/** Step 1 of the wizard: how kapel talks to a model at all. */
export function backendChoices(): readonly SelectChoice[] {
  return [
    {
      value: "claude-code",
      label: "Claude Code",
      hint: "use your Claude Code subscription login — no API key",
    },
    {
      value: "codex",
      label: "Codex",
      hint: "use your ChatGPT login via the OpenAI Codex CLI — no API key",
    },
    {
      value: "native",
      label: "API key (Anthropic/OpenAI)",
      hint: "call model APIs directly with a key or token",
    },
  ];
}

/**
 * Every catalog id for one provider, sorted alphabetically.
 *
 * The choice lists below are built from this instead of a hand-maintained
 * snippet so that adding a model to {@link defaultModelCatalog} automatically
 * widens what every backend's wizard offers — nobody has to remember to keep
 * `config.ts` in sync with the catalog by hand.
 */
function catalogIdsForProvider(
  provider: "anthropic" | "openai",
): readonly string[] {
  const catalog = defaultModelCatalog();
  return Object.keys(catalog)
    .filter((id) => catalog[id]?.provider === provider)
    .sort();
}

/**
 * Claude Code's `--model` takes both aliases and full model ids. The wizard
 * offers every model the provider serves — kapel does not pre-guess which
 * tier an account is on, since that guess is exactly the kind of gatekeeping
 * that goes stale the moment a plan changes. A model the account cannot
 * actually use fails clearly at run time instead (see the model-access hint
 * in `packages/coding-agent/src/backends/claude-code.ts`).
 *
 * Order: the three stable aliases first (what most people want, and they
 * stay valid across catalog churn), then every Anthropic catalog id sorted
 * alphabetically, then `default` last as the catch-all "whatever the account
 * defaults to" choice.
 */
function claudeCodeChoices(): readonly SelectChoice[] {
  const aliases: readonly SelectChoice[] = [
    { value: "opus", label: "opus", hint: "Claude Opus — highest capability" },
    { value: "sonnet", label: "sonnet", hint: "Claude Sonnet — balanced" },
    { value: "haiku", label: "haiku", hint: "Claude Haiku — fastest/cheapest" },
  ];
  const fullIds: readonly SelectChoice[] = catalogIdsForProvider(
    "anthropic",
  ).map((id) => ({
    value: id,
    label: id,
    hint: "full model id — errors at run time if your plan lacks it",
  }));
  return [
    ...aliases,
    ...fullIds,
    {
      value: "default",
      label: "default",
      hint: "whatever your Claude Code account defaults to",
    },
  ];
}

/**
 * The Codex CLI accepts any model id a plan allows, and which ids that is
 * varies by account — kapel does not pre-filter the list down to a guess.
 * `default` leads because it is what the wizard recommends (the Codex CLI
 * picks its own default when no `-m` is passed); every other id is offered
 * with a neutral hint since there is no way to know from here whether the
 * signed-in account has it.
 *
 * `gpt-5.1-codex` is listed by hand because it is a real, Codex-CLI-specific
 * id that is not part of the shared catalog (it is never used through the
 * native API path {@link defaultModelCatalog} models). Every other id comes
 * from the catalog's OpenAI entries, sorted alphabetically alongside it.
 */
function codexChoices(): readonly SelectChoice[] {
  const runTimeHint = "errors at run time if your plan lacks it";
  const named = Array.from(
    new Set(["gpt-5.1-codex", ...catalogIdsForProvider("openai")]),
  ).sort();
  return [
    { value: "default", label: "default", hint: "let the Codex CLI choose" },
    ...named.map((id) => ({ value: id, label: id, hint: runTimeHint })),
  ];
}

function nativeChoices(): readonly SelectChoice[] {
  const catalog = defaultModelCatalog();
  return Object.keys(catalog)
    .sort()
    .map((alias) => {
      const definition = catalog[alias];
      const provider = definition?.provider ?? "unknown";
      const hint =
        definition?.pricing === undefined
          ? provider
          : `${provider} · pricing available`;
      return { value: alias, label: alias, hint };
    });
}

function choicesForBackend(backend: KapelBackend): readonly SelectChoice[] {
  if (backend === "claude-code") return claudeCodeChoices();
  if (backend === "codex") return codexChoices();
  return nativeChoices();
}

/**
 * The models on offer for one role, with the one this role defaults to marked
 * so the list explains itself without a second prompt.
 */
export function modelChoicesFor(
  backend: KapelBackend,
  role: KapelRole,
): readonly SelectChoice[] {
  const suggested = defaultModelsFor(backend)[role];
  return choicesForBackend(backend).map((choice) => {
    if (choice.value !== suggested) return choice;
    const hint =
      choice.hint === undefined
        ? "suggested for this role"
        : `${choice.hint} · suggested for this role`;
    return { value: choice.value, label: choice.label, hint };
  });
}

/**
 * Picks `preferred` when the catalog has it, then the first Anthropic alias,
 * then simply the first alias — so a trimmed or extended catalog still yields
 * a usable default instead of a dangling model id.
 */
function pickNative(preferred: string): string {
  const catalog = defaultModelCatalog();
  const aliases = Object.keys(catalog).sort();
  if (aliases.includes(preferred)) return preferred;
  const anthropic = aliases.find(
    (alias) => catalog[alias]?.provider === "anthropic",
  );
  return anthropic ?? aliases[0] ?? preferred;
}

/** The per-role defaults the wizard pre-selects for a backend. */
export function defaultModelsFor(backend: KapelBackend): KapelModels {
  if (backend === "claude-code") {
    return {
      orchestrator: "opus",
      complex: "opus",
      middle: "sonnet",
      low: "haiku",
    };
  }
  if (backend === "codex") {
    return {
      orchestrator: "default",
      complex: "default",
      middle: "default",
      low: "default",
    };
  }
  return {
    orchestrator: pickNative("claude-opus-5"),
    complex: pickNative("claude-opus-5"),
    middle: pickNative("claude-sonnet-5"),
    low: pickNative("claude-haiku-4-5"),
  };
}

// --- Display ----------------------------------------------------------------

function backendLabel(backend: KapelBackend): string {
  return (
    backendChoices().find((choice) => choice.value === backend)?.label ??
    backend
  );
}

/** The human-readable form, as printed by `kapel config --show`. */
export function describeConfig(config: KapelConfig): readonly string[] {
  return [
    `backend: ${backendLabel(config.backend)} (${config.backend})`,
    `orchestrator model: ${config.models.orchestrator}`,
    `worker model (complex tasks): ${config.models.complex}`,
    `worker model (everyday tasks): ${config.models.middle}`,
    `worker model (small tasks): ${config.models.low}`,
    `updated: ${new Date(config.updatedAt).toISOString()}`,
  ];
}
