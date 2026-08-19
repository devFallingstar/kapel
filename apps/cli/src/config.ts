import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defaultModelCatalog } from "@agent/ai";
import type { PermissionRuleSet } from "@agent/coding-agent";
import type { PermissionDecision } from "@agent/core";
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
  /**
   * The machine-level permission layer (P1-5): tool name -> `"allow" |
   * "ask" | "deny"`, or, for `bash`, a map of command-prefix patterns to
   * verdicts — opencode's `{"*": "ask", "git *": "allow"}` syntax. Omitted
   * when the file has no `permission` block, or when everything in it was
   * invalid. Hand-edited only — the `/config` wizard never writes this key,
   * but preserves it across a save (see `saveKapelConfig`).
   */
  readonly permission?: PermissionRuleSet;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === "allow" || value === "ask" || value === "deny";
}

interface ParsedPermission {
  readonly rules: PermissionRuleSet;
  readonly warnings: readonly string[];
}

/**
 * Parses the optional `permission` block leniently: a malformed entry — the
 * wrong type, an unrecognised verdict, a `bash` pattern whose value isn't a
 * verdict — is dropped and its problem collected, but never invalidates the
 * rest of the block or (unlike every other field here) the config file it
 * lives in. Backend/model settings are load-bearing enough to justify
 * `parseConfig` discarding the whole file when they're wrong; a hand-edited
 * permission typo is not worth losing someone's backend and model choices
 * over, so the file loads with the bad entries simply ignored and reported.
 */
function parsePermissionBlock(raw: unknown): ParsedPermission {
  if (raw === undefined) return { rules: {}, warnings: [] };
  if (!isRecord(raw)) {
    return {
      rules: {},
      warnings: ['"permission" must be an object; ignoring it entirely.'],
    };
  }

  const rules: Record<string, PermissionRuleSet[string]> = {};
  const warnings: string[] = [];

  for (const [tool, value] of Object.entries(raw)) {
    if (isPermissionDecision(value)) {
      rules[tool] = value;
      continue;
    }
    if (isRecord(value)) {
      const patterns: Record<string, PermissionDecision> = {};
      for (const [pattern, verdict] of Object.entries(value)) {
        if (isPermissionDecision(verdict)) {
          patterns[pattern] = verdict;
        } else {
          warnings.push(
            `permission.${tool}["${pattern}"]: expected "allow" | "ask" | "deny", got ${JSON.stringify(verdict)} — ignoring.`,
          );
        }
      }
      if (Object.keys(patterns).length > 0) {
        rules[tool] = patterns;
      } else {
        warnings.push(`permission.${tool}: no valid patterns — ignoring.`);
      }
      continue;
    }
    warnings.push(
      `permission.${tool}: expected "allow" | "ask" | "deny" or a pattern map, got ${JSON.stringify(value)} — ignoring.`,
    );
  }

  return { rules, warnings };
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

interface ParsedConfig {
  readonly config: KapelConfig | undefined;
  readonly warnings: readonly string[];
}

function parseConfig(raw: unknown): ParsedConfig {
  const none: ParsedConfig = { config: undefined, warnings: [] };
  if (typeof raw !== "object" || raw === null) return none;
  const record = raw as Record<string, unknown>;
  const version = record.version;
  if (version !== KAPEL_CONFIG_VERSION && version !== 1) return none;
  if (!isBackend(record.backend)) return none;

  const models = record.models;
  if (typeof models !== "object" || models === null) return none;
  const modelRecord = models as Record<string, unknown>;
  const parsed =
    version === 1 ? migrateV1Models(modelRecord) : parseV2Models(modelRecord);
  if (parsed === undefined) return none;

  // The permission block is version-independent: it was never part of the
  // models schema, so a migrated version-1 file keeps whatever it had.
  const { rules: permission, warnings } = parsePermissionBlock(
    record.permission,
  );

  const updatedAt = record.updatedAt;
  return {
    config: {
      version: KAPEL_CONFIG_VERSION,
      backend: record.backend,
      models: parsed,
      updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
      ...(Object.keys(permission).length > 0 ? { permission } : {}),
    },
    warnings,
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
  let parsed: ParsedConfig;
  try {
    parsed = parseConfig(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (parsed.warnings.length > 0) {
    console.error(
      `warning: ignoring invalid entries in ${kapelConfigPath(env)}'s "permission" block:`,
    );
    for (const warning of parsed.warnings) console.error(`  - ${warning}`);
  }
  return parsed.config;
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
    // Hand-edited only (see `KapelConfig.permission`) — carried through
    // verbatim so a `/config` re-save never silently drops it.
    ...(config.permission === undefined
      ? {}
      : { permission: config.permission }),
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
