import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServersInput } from "@agent/coding-agent";
import { McpServersInputSchema } from "@agent/coding-agent";
import type {
  KapelBackend,
  KapelConfig,
  KapelModels,
  KapelRole,
  KapelRoleModel,
} from "./config.js";
import {
  defaultModelsForBackends,
  defaultRoleModel,
  describeBackends,
  describeRoleModel,
  KAPEL_CONFIG_VERSION,
  KAPEL_ROLES,
  parseBackendList,
  parseRoleModel,
  ROLE_DESCRIPTIONS,
} from "./config.js";

/**
 * The per-project override of the machine-level configuration.
 *
 * `~/.kapel/config.json` answers "what is this *machine* logged into"; this
 * file answers "and what should *this directory* use instead". A repository
 * that must be worked on through Codex, or whose middle tier should be a
 * cheaper model than everything else on the machine, says so here — without
 * changing the answer for every other checkout.
 *
 * It is deliberately a partial: a project may override just the backends, just
 * some roles, or everything, and the machine config fills every gap. Like
 * `.agent/sessions.db`, it is a per-checkout fact rather than a project one,
 * so `kapel init` puts it in `.gitignore`.
 */

/** The file, relative to a workspace root. */
export const PROJECT_CONFIG_RELATIVE = path.join(".agent", "config.local.json");

/** `<workspace>/.agent/config.local.json`. */
export function projectConfigPath(workspacePath: string): string {
  return path.join(workspacePath, PROJECT_CONFIG_RELATIVE);
}

/** The `.agent` directory the file has to live in — `kapel init` creates it. */
export function projectAgentDir(workspacePath: string): string {
  return path.join(workspacePath, ".agent");
}

/** Whether this directory has been `kapel init`-ed. Never throws. */
export async function hasProjectAgentDir(
  workspacePath: string,
): Promise<boolean> {
  try {
    return (await stat(projectAgentDir(workspacePath))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A project-level override. Every field is optional; an empty object is a
 * valid (if pointless) file, and unknown keys are ignored rather than
 * rejected — a future version's key must not make today's kapel drop the
 * file.
 */
export interface KapelProjectConfig {
  readonly backends?: readonly KapelBackend[];
  readonly models?: Readonly<Partial<Record<KapelRole, KapelRoleModel>>>;
  /**
   * This checkout's MCP servers, layered over `.agent/config.yaml`'s `mcp:`
   * block by `mergeMcpServers`. Field by field, so `{"github": {"env":
   * {"GITHUB_TOKEN": "…"}}}` adds a token to a server the project committed
   * without restating its command — which is the reason a machine-local
   * override exists at all: a token belongs next to the machine, not in the
   * repository.
   */
  readonly mcp?: McpServersInput;
}

// --- Reading and writing ----------------------------------------------------

const ALL_BACKENDS: readonly KapelBackend[] = [
  "claude-code",
  "codex",
  "native",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the file's contents. `undefined` means "not usable" — the caller
 * warns once and carries on with the machine config alone.
 *
 * A role naming a backend the *same file* does not enable is a contradiction
 * rather than an omission, so it invalidates the file; a role naming one the
 * file says nothing about is fine, and is checked against the merged backend
 * list later (see {@link mergeKapelConfigs}).
 */
export function parseProjectConfig(
  raw: unknown,
): KapelProjectConfig | undefined {
  if (!isRecord(raw)) return undefined;

  let backends: readonly KapelBackend[] | undefined;
  if (raw.backends !== undefined) {
    backends = parseBackendList(raw.backends);
    if (backends === undefined) return undefined;
  }

  let models: Partial<Record<KapelRole, KapelRoleModel>> | undefined;
  if (raw.models !== undefined) {
    if (!isRecord(raw.models)) return undefined;
    const allowed = backends ?? ALL_BACKENDS;
    const parsed: Partial<Record<KapelRole, KapelRoleModel>> = {};
    for (const role of KAPEL_ROLES) {
      const entry = raw.models[role];
      if (entry === undefined) continue;
      const roleModel = parseRoleModel(entry, allowed);
      if (roleModel === undefined) return undefined;
      parsed[role] = roleModel;
    }
    models = parsed;
  }

  let mcp: McpServersInput | undefined;
  if (raw.mcp !== undefined) {
    const parsed = McpServersInputSchema.safeParse(raw.mcp);
    if (!parsed.success) return undefined;
    mcp = parsed.data;
  }

  return {
    ...(backends === undefined ? {} : { backends }),
    ...(models === undefined ? {} : { models }),
    ...(mcp === undefined ? {} : { mcp }),
  };
}

/** Where a malformed project file reports itself. Overridable in tests. */
export type ProjectConfigWarn = (line: string) => void;

const consoleWarn: ProjectConfigWarn = (line) => {
  console.error(line);
};

/**
 * Reads `<workspace>/.agent/config.local.json`.
 *
 * Never throws, and never fails a command: a missing file is simply
 * `undefined`, and a malformed one is `undefined` plus a single line on
 * stderr naming the file — losing an override silently would be worse than
 * one warning, and refusing to run over it would be worse than both.
 */
export async function loadProjectConfig(
  workspacePath: string,
  warn: ProjectConfigWarn = consoleWarn,
): Promise<KapelProjectConfig | undefined> {
  const filePath = projectConfigPath(workspacePath);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: KapelProjectConfig | undefined;
  try {
    parsed = parseProjectConfig(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    warn(
      `warning: ignoring ${filePath} — it is not a readable kapel project config ` +
        '(expected {"backends": [...], "models": {"<role>": {"backend": "...", "model": "..."}}, ' +
        '"mcp": {"<server>": {"command": "...", "args": [...], "env": {...}, "enabled": true}}}).',
    );
    return undefined;
  }
  return parsed;
}

/**
 * Writes the project override, creating nothing: the `.agent` directory is
 * `kapel init`'s to make, and quietly scaffolding half a project here would
 * leave a directory holding one file nothing else expects.
 *
 * Rejects with a printable message when `.agent` is missing, which is what
 * `kapel config --project` turns into "run `kapel init` first".
 */
export async function saveProjectConfig(
  workspacePath: string,
  config: KapelProjectConfig,
): Promise<string> {
  if (!(await hasProjectAgentDir(workspacePath))) {
    throw new MissingAgentDirError(projectAgentDir(workspacePath));
  }

  const filePath = projectConfigPath(workspacePath);
  const body: Record<string, unknown> = {};
  if (config.backends !== undefined) body.backends = [...config.backends];
  if (config.models !== undefined) body.models = config.models;
  if (config.mcp !== undefined) body.mcp = config.mcp;
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return filePath;
}

/** Thrown by {@link saveProjectConfig} when there is no `.agent` to write into. */
export class MissingAgentDirError extends Error {
  constructor(readonly agentDir: string) {
    super(
      `${agentDir} does not exist — run \`kapel init\` in this directory first.`,
    );
    this.name = "MissingAgentDirError";
  }
}

// --- Merging ----------------------------------------------------------------

/** Which layer an effective value came from. */
export type ConfigOrigin = "project" | "machine" | "default";

export interface EffectiveConfigSources {
  readonly backends: ConfigOrigin;
  readonly models: Readonly<Record<KapelRole, ConfigOrigin>>;
}

export interface EffectiveConfig {
  /** The merged configuration, shaped exactly like a machine-level one. */
  readonly config: KapelConfig;
  /** Where each value came from, for `kapel config --show`. */
  readonly sources: EffectiveConfigSources;
}

/**
 * Layers a project override on top of the machine config.
 *
 * The backend list is all-or-nothing — a project either replaces it or
 * inherits it, because a half-overridden list is not a thing anyone can
 * reason about. Role models merge one role at a time, so overriding the
 * middle tier alone leaves the other three exactly as the machine has them.
 *
 * With no machine config at all, a project that names only models still
 * yields a usable one: the backend list is derived from the backends its
 * roles name, in role order. And a role left over from an earlier backend
 * list — one whose backend is no longer enabled — falls back to that role's
 * default (source `"default"`, so `--show` says so) instead of silently
 * naming a backend the config does not have.
 *
 * `undefined` means neither layer said anything at all.
 */
export function mergeKapelConfigs(
  machine: KapelConfig | undefined,
  project: KapelProjectConfig | undefined,
): EffectiveConfig | undefined {
  const projectModels = project?.models ?? {};
  const hasProjectModels = KAPEL_ROLES.some(
    (role) => projectModels[role] !== undefined,
  );
  if (
    machine === undefined &&
    project?.backends === undefined &&
    !hasProjectModels
  ) {
    return undefined;
  }

  const backends = project?.backends ??
    machine?.backends ??
    derivedBackends(projectModels) ?? ["native"];
  const backendsSource: ConfigOrigin =
    project?.backends !== undefined
      ? "project"
      : machine !== undefined
        ? "machine"
        : "default";

  const models: Partial<Record<KapelRole, KapelRoleModel>> = {};
  const sources: Partial<Record<KapelRole, ConfigOrigin>> = {};
  for (const role of KAPEL_ROLES) {
    const fromProject = projectModels[role];
    const fromMachine = machine?.models[role];
    if (fromProject !== undefined && backends.includes(fromProject.backend)) {
      models[role] = fromProject;
      sources[role] = "project";
    } else if (
      fromMachine !== undefined &&
      backends.includes(fromMachine.backend)
    ) {
      models[role] = fromMachine;
      sources[role] = "machine";
    } else {
      models[role] = defaultRoleModel(backends, role);
      sources[role] = "default";
    }
  }

  return {
    config: {
      version: KAPEL_CONFIG_VERSION,
      backends,
      models: models as KapelModels,
      updatedAt: machine?.updatedAt ?? 0,
      ...(machine?.permission === undefined
        ? {}
        : { permission: machine.permission }),
    },
    sources: {
      backends: backendsSource,
      models: sources as Readonly<Record<KapelRole, ConfigOrigin>>,
    },
  };
}

/** The backends a project's role models name, in role order, deduplicated. */
function derivedBackends(
  models: Readonly<Partial<Record<KapelRole, KapelRoleModel>>>,
): readonly KapelBackend[] | undefined {
  const backends: KapelBackend[] = [];
  for (const role of KAPEL_ROLES) {
    const entry = models[role];
    if (entry !== undefined && !backends.includes(entry.backend)) {
      backends.push(entry.backend);
    }
  }
  return backends.length === 0 ? undefined : backends;
}

/**
 * The effective configuration for a directory: the machine config with this
 * project's override layered on top.
 */
export async function loadEffectiveConfig(
  workspacePath: string,
  machine: KapelConfig | undefined,
  warn?: ProjectConfigWarn,
): Promise<EffectiveConfig | undefined> {
  const project = await loadProjectConfig(workspacePath, warn);
  return mergeKapelConfigs(machine, project);
}

/** The default `models` block for a set of backends, as a project override. */
export function projectDefaultsFor(
  backends: readonly KapelBackend[],
): KapelProjectConfig {
  return { backends, models: defaultModelsForBackends(backends) };
}

// --- Display ----------------------------------------------------------------

/**
 * `kapel config --show`: the merged view, with the file each value came from
 * named beside it — the whole point of a two-layer configuration is being
 * able to see which layer won.
 */
export function describeEffectiveConfig(
  effective: EffectiveConfig,
  paths: { readonly machine: string; readonly project: string },
): readonly string[] {
  const { config, sources } = effective;
  const from = (origin: ConfigOrigin): string => {
    if (origin === "project") return `  (from ${paths.project})`;
    if (origin === "machine") return `  (from ${paths.machine})`;
    return "  (built-in default)";
  };

  return [
    `backends: ${describeBackends(config.backends)}${from(sources.backends)}`,
    ...KAPEL_ROLES.map(
      (role) =>
        `${ROLE_DESCRIPTIONS[role]}: ${describeRoleModel(config.models[role])}${from(sources.models[role])}`,
    ),
    `updated: ${new Date(config.updatedAt).toISOString()}`,
  ];
}
