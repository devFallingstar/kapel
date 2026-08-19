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

export const KAPEL_CONFIG_VERSION = 1;

export type KapelBackend = "claude-code" | "codex" | "native";

const BACKENDS: readonly KapelBackend[] = ["claude-code", "codex", "native"];

export type KapelRole = "orchestrator" | "worker" | "cheap";

export interface KapelModels {
  readonly orchestrator: string;
  readonly worker: string;
  readonly cheap: string;
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

function parseConfig(raw: unknown): KapelConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== KAPEL_CONFIG_VERSION) return undefined;
  if (!isBackend(record.backend)) return undefined;

  const models = record.models;
  if (typeof models !== "object" || models === null) return undefined;
  const modelRecord = models as Record<string, unknown>;
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

  const updatedAt = record.updatedAt;
  return {
    version: KAPEL_CONFIG_VERSION,
    backend: record.backend,
    models: { orchestrator, worker, cheap },
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
      worker: config.models.worker,
      cheap: config.models.cheap,
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
 * Claude Code's `--model` takes both aliases and full model ids; the aliases
 * are the stable half, so those are what the wizard offers.
 */
const CLAUDE_CODE_CHOICES: readonly SelectChoice[] = [
  { value: "opus", label: "opus", hint: "Claude Opus — highest capability" },
  { value: "sonnet", label: "sonnet", hint: "Claude Sonnet — balanced" },
  { value: "haiku", label: "haiku", hint: "Claude Haiku — fastest/cheapest" },
  {
    value: "default",
    label: "default",
    hint: "whatever your Claude Code account defaults to",
  },
];

/**
 * The Codex CLI picks its own default when no `-m` is passed, and which ids
 * an account can actually use varies by plan and CLI version. So `default`
 * leads and is what the wizard recommends; the named ids are offered, clearly
 * marked as account-dependent, for people who know they have them.
 */
const CODEX_CHOICES: readonly SelectChoice[] = [
  { value: "default", label: "default", hint: "let the Codex CLI choose" },
  {
    value: "gpt-5.1-codex",
    label: "gpt-5.1-codex",
    hint: "only if your account has it",
  },
  { value: "gpt-5.1", label: "gpt-5.1", hint: "only if your account has it" },
  {
    value: "gpt-5-mini",
    label: "gpt-5-mini",
    hint: "only if your account has it",
  },
];

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
  if (backend === "claude-code") return CLAUDE_CODE_CHOICES;
  if (backend === "codex") return CODEX_CHOICES;
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
    return { orchestrator: "opus", worker: "sonnet", cheap: "haiku" };
  }
  if (backend === "codex") {
    return { orchestrator: "default", worker: "default", cheap: "default" };
  }
  return {
    orchestrator: pickNative("claude-opus-5"),
    worker: pickNative("claude-sonnet-5"),
    cheap: pickNative("claude-haiku-4-5"),
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
    `worker model (normal complexity): ${config.models.worker}`,
    `worker model (low complexity): ${config.models.cheap}`,
    `updated: ${new Date(config.updatedAt).toISOString()}`,
  ];
}
