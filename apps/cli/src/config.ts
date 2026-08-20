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

export const KAPEL_CONFIG_VERSION = 3;

export type KapelBackend = "claude-code" | "codex" | "native";

const BACKENDS: readonly KapelBackend[] = ["claude-code", "codex", "native"];

export type KapelRole = "orchestrator" | "complex" | "middle" | "low";

/**
 * The four roles, in the order the wizard asks about them and every summary
 * prints them.
 *
 * - `orchestrator` — plans, routes and reviews.
 * - `complex` — the most complex coding work: cross-cutting changes, gnarly
 *   debugging.
 * - `middle` — everyday, moderate implementation work.
 * - `low` — small, single-function-sized changes and read-only exploration.
 */
export const KAPEL_ROLES: readonly KapelRole[] = [
  "orchestrator",
  "complex",
  "middle",
  "low",
];

/**
 * One role's answer: *which* model, and *whose* — because with more than one
 * backend configured, a bare model id no longer says who runs it (`opus` is a
 * Claude Code alias, `gpt-5.1` a Codex one, and `claude-opus-5` exists on both
 * the native and the Claude Code list).
 */
export interface KapelRoleModel {
  readonly backend: KapelBackend;
  readonly model: string;
}

/** Every role's chosen backend+model pair. */
export type KapelModels = Readonly<Record<KapelRole, KapelRoleModel>>;

/** One backend's bare per-role model ids — what {@link defaultModelsFor} suggests. */
export type KapelBackendModels = Readonly<Record<KapelRole, string>>;

export interface KapelConfig {
  readonly version: number;
  /**
   * Every backend this machine may use, in the order they were chosen. Never
   * empty and never repeating; the first entry is the default for anything
   * that still needs a single backend and has no role to read one from.
   */
  readonly backends: readonly KapelBackend[];
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
 * A `backends` list as written on disk: a non-empty array of known backend
 * names with no repeats. Anything else is `undefined`, which every caller
 * treats as "this file is unreadable".
 */
export function parseBackendList(
  raw: unknown,
): readonly KapelBackend[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const backends: KapelBackend[] = [];
  for (const entry of raw) {
    if (!isBackend(entry) || backends.includes(entry)) return undefined;
    backends.push(entry);
  }
  return backends;
}

/**
 * One `{backend, model}` pair as written on disk, checked against the
 * backends the file declares: a role may only name a backend the config
 * actually enables, or the pair is meaningless.
 */
export function parseRoleModel(
  raw: unknown,
  allowed: readonly KapelBackend[],
): KapelRoleModel | undefined {
  if (!isRecord(raw)) return undefined;
  const backend = raw.backend;
  if (!isBackend(backend) || !allowed.includes(backend)) return undefined;
  const model = modelString(raw.model);
  if (model === undefined) return undefined;
  return { backend, model };
}

/**
 * Migrates a version-1 or version-2 `models` block onto the version-3 slots.
 *
 * Version 1 had three slots — `orchestrator`, `worker` ("normal complexity")
 * and `cheap` ("low complexity / exploration"). Version 2 split the worker
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
 * Version 3 keeps the four slots but pairs each with the backend that runs
 * it; a version-1 or -2 file had exactly one backend, so every role migrates
 * onto that one.
 *
 * Migration happens in memory only. Nothing is rewritten on disk until the
 * user saves a config, which {@link saveKapelConfig} always writes as
 * version 3.
 */
function migrateLegacyModels(
  version: 1 | 2,
  modelRecord: Record<string, unknown>,
  backend: KapelBackend,
): KapelModels | undefined {
  const orchestrator = modelString(modelRecord.orchestrator);
  const complex =
    version === 1
      ? modelString(modelRecord.worker)
      : modelString(modelRecord.complex);
  const middle =
    version === 1
      ? modelString(modelRecord.worker)
      : modelString(modelRecord.middle);
  const low =
    version === 1
      ? modelString(modelRecord.cheap)
      : modelString(modelRecord.low);
  if (
    orchestrator === undefined ||
    complex === undefined ||
    middle === undefined ||
    low === undefined
  ) {
    return undefined;
  }
  return {
    orchestrator: { backend, model: orchestrator },
    complex: { backend, model: complex },
    middle: { backend, model: middle },
    low: { backend, model: low },
  };
}

function parseV3Models(
  modelRecord: Record<string, unknown>,
  backends: readonly KapelBackend[],
): KapelModels | undefined {
  const models: Partial<Record<KapelRole, KapelRoleModel>> = {};
  for (const role of KAPEL_ROLES) {
    const parsed = parseRoleModel(modelRecord[role], backends);
    if (parsed === undefined) return undefined;
    models[role] = parsed;
  }
  return models as KapelModels;
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
  const legacy = version === 1 || version === 2;
  if (version !== KAPEL_CONFIG_VERSION && !legacy) return none;

  const backends = legacy
    ? isBackend(record.backend)
      ? [record.backend]
      : undefined
    : parseBackendList(record.backends);
  if (backends === undefined) return none;

  const models = record.models;
  if (typeof models !== "object" || models === null) return none;
  const modelRecord = models as Record<string, unknown>;
  const firstBackend = backends[0];
  const parsed =
    legacy && firstBackend !== undefined
      ? migrateLegacyModels(version, modelRecord, firstBackend)
      : parseV3Models(modelRecord, backends);
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
      backends,
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
 * A version-1 or version-2 file is *not* unreadable: it is migrated in memory
 * by {@link migrateLegacyModels}, because throwing away a working setup over a
 * slot rename — or over multi-backend support the file predates — would be
 * hostile.
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
    backends: [...config.backends],
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

/**
 * Step 1 of the wizard: how kapel talks to a model at all.
 *
 * Multi-select since version 3 — picking Claude Code *and* Codex is a real
 * answer, and the role questions then offer the union of both lists.
 */
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
 * How a role's answer is encoded as one picker value: `"<backend>:<model>"`.
 *
 * The prefix is what makes a union list unambiguous — `claude-opus-5` is on
 * both the native and the Claude Code list, and `default` is on two of the
 * three. Backend names never contain a colon and model ids never start with
 * one, so splitting at the first colon round-trips every pair.
 */
export function encodeRoleModel(entry: KapelRoleModel): string {
  return `${entry.backend}:${entry.model}`;
}

/** {@link encodeRoleModel} in reverse; `undefined` for anything unparseable. */
export function decodeRoleModel(value: string): KapelRoleModel | undefined {
  const separator = value.indexOf(":");
  if (separator === -1) return undefined;
  const backend = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!isBackend(backend) || model === "") return undefined;
  return { backend, model };
}

/**
 * The models on offer for one role across every selected backend, with the
 * one this role defaults to marked so the list explains itself without a
 * second prompt.
 *
 * With a single backend selected this is exactly that backend's own list, in
 * its own order. With several, the lists are concatenated in the order the
 * backends were chosen and every hint is prefixed with the backend's name, so
 * two identically-named models stay tellable apart on screen — the values
 * themselves are qualified either way (see {@link encodeRoleModel}).
 */
export function modelChoicesFor(
  backends: readonly KapelBackend[],
  role: KapelRole,
): readonly SelectChoice[] {
  const suggested = defaultRoleModel(backends, role);
  const qualify = backends.length > 1;
  const choices: SelectChoice[] = [];

  for (const backend of backends) {
    for (const choice of choicesForBackend(backend)) {
      const parts: string[] = [];
      if (qualify) parts.push(backendLabel(backend));
      if (choice.hint !== undefined) parts.push(choice.hint);
      if (backend === suggested.backend && choice.value === suggested.model) {
        parts.push("suggested for this role");
      }
      const hint = parts.join(" · ");
      choices.push({
        value: encodeRoleModel({ backend, model: choice.value }),
        label: choice.label,
        ...(hint === "" ? {} : { hint }),
      });
    }
  }
  return choices;
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
export function defaultModelsFor(backend: KapelBackend): KapelBackendModels {
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

/**
 * Which selected backend's tier defaults a role's suggestion comes from,
 * in preference order: Claude Code, then Codex, then native.
 *
 * The order is not a quality ranking — it is a *specificity* one. Claude
 * Code's defaults are the only ones that actually spread the four roles
 * across different models (opus / opus / sonnet / haiku), so when it is on the
 * list its suggestions carry the most information. Codex's are all the
 * `"default"` sentinel, which suggests nothing in particular, and native's
 * repeat Claude Code's spread through catalog aliases that need a key. A
 * suggestion is only ever a pre-selection; every list still offers every
 * model of every selected backend.
 */
const DEFAULT_MODEL_PREFERENCE: readonly KapelBackend[] = [
  "claude-code",
  "codex",
  "native",
];

/** The backend+model pair the wizard pre-selects for one role. */
export function defaultRoleModel(
  backends: readonly KapelBackend[],
  role: KapelRole,
): KapelRoleModel {
  const backend =
    DEFAULT_MODEL_PREFERENCE.find((candidate) =>
      backends.includes(candidate),
    ) ??
    backends[0] ??
    "native";
  return { backend, model: defaultModelsFor(backend)[role] };
}

/** {@link defaultRoleModel} for every role — a whole default `models` block. */
export function defaultModelsForBackends(
  backends: readonly KapelBackend[],
): KapelModels {
  return {
    orchestrator: defaultRoleModel(backends, "orchestrator"),
    complex: defaultRoleModel(backends, "complex"),
    middle: defaultRoleModel(backends, "middle"),
    low: defaultRoleModel(backends, "low"),
  };
}

// --- The one backend a single-backend consumer runs on -----------------------

/**
 * The single backend to run everything on, for the consumers that still only
 * understand one: the REPL's chat turns, the planner, the policy compiler and
 * the orchestration executor factory.
 *
 * It is the **orchestrator role's** backend — the orchestrator is the agent
 * those consumers actually are (a chat turn, a plan, a compile are all its
 * work), so reading its answer is the honest single choice among several. A
 * config always has one; the merge in `config-project.ts` falls back to the
 * first entry of `backends` when no layer named a model for the role.
 *
 * Every call site of this is a place mixed execution has not reached yet: the
 * follow-up that runs each agent on its own role's backend narrows this down
 * to the few spots that genuinely have no role in hand, instead of standing in
 * for four different answers.
 */
export function soleExecutionBackend(config: KapelConfig): KapelBackend {
  return config.models.orchestrator.backend;
}

// --- Display ----------------------------------------------------------------

/** The wizard's label for a backend (`"Claude Code"`), or the raw name. */
export function backendLabel(backend: KapelBackend): string {
  return (
    backendChoices().find((choice) => choice.value === backend)?.label ??
    backend
  );
}

/** What each role is called in a printed summary. */
export const ROLE_DESCRIPTIONS: Readonly<Record<KapelRole, string>> = {
  orchestrator: "orchestrator model",
  complex: "worker model (complex tasks)",
  middle: "worker model (everyday tasks)",
  low: "worker model (small tasks)",
};

/** `"Claude Code (claude-code), Codex (codex)"`. */
export function describeBackends(backends: readonly KapelBackend[]): string {
  return backends
    .map((backend) => `${backendLabel(backend)} (${backend})`)
    .join(", ");
}

/** `"opus (claude-code)"` — the model, and who runs it. */
export function describeRoleModel(entry: KapelRoleModel): string {
  return `${entry.model} (${entry.backend})`;
}

/** The human-readable form, as printed by `kapel config --show`. */
export function describeConfig(config: KapelConfig): readonly string[] {
  return [
    `backends: ${describeBackends(config.backends)}`,
    ...KAPEL_ROLES.map(
      (role) =>
        `${ROLE_DESCRIPTIONS[role]}: ${describeRoleModel(config.models[role])}`,
    ),
    `updated: ${new Date(config.updatedAt).toISOString()}`,
  ];
}
