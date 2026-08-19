import type { CodexAvailability } from "@agent/coding-agent";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Execution backends the CLI can dispatch an objective to. */
export const BACKEND_NAMES = ["native", "codex"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export const DEFAULT_BACKEND: BackendName = "native";

function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

/**
 * The effective backend name for a run: an explicit `--backend` flag wins,
 * then `AGENT_BACKEND`, then the built-in default. Mirrors
 * {@link resolveModelAlias}'s precedence in `models.ts`.
 */
export function resolveBackendName(env: EnvLike, flag?: string): string {
  if (flag !== undefined && flag !== "") return flag;
  const fromEnv = env.AGENT_BACKEND;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_BACKEND;
}

/**
 * Validates a resolved backend name. Throws a friendly, printable error for
 * anything other than a known backend — callers surface `error.message` and
 * exit 1, same as the existing `--max-iterations`/`--timeout` validation in
 * `index.ts`.
 */
export function validateBackendName(raw: string): BackendName {
  if (isBackendName(raw)) return raw;
  throw new Error(
    `Invalid --backend value "${raw}": expected one of ${BACKEND_NAMES.join(", ")}.`,
  );
}

/** Codex sandbox modes, as accepted by `codex exec --sandbox`. */
export const SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";

function isSandboxMode(value: string): value is SandboxMode {
  return (SANDBOX_MODES as readonly string[]).includes(value);
}

/** Validates a `--sandbox` value; throws a friendly error otherwise. */
export function validateSandboxMode(raw: string): SandboxMode {
  if (isSandboxMode(raw)) return raw;
  throw new Error(
    `Invalid --sandbox value "${raw}": expected one of ${SANDBOX_MODES.join(", ")}.`,
  );
}

/**
 * Whether Codex should run in `--full-auto` mode: true for every sandbox
 * except `"read-only"`, which has nothing to auto-approve and is passed
 * through as an explicit `--sandbox read-only` instead (see
 * `CodexBackend#buildArgs`).
 */
export function fullAutoForSandbox(sandbox: SandboxMode): boolean {
  return sandbox !== "read-only";
}

/**
 * The model id to forward to Codex's `-m` flag: only when the user
 * explicitly gave `-m`/`--model` on the command line.
 *
 * This deliberately does *not* go through `resolveModelAlias`, which folds
 * in the native backend's default alias (`claude-sonnet-5` or `AGENT_MODEL`)
 * when nothing was passed — forwarding that default to Codex would ask it to
 * run an Anthropic model id it doesn't understand. `raw` should be the
 * literal `--model` flag value (undefined/empty when the flag was omitted);
 * Codex picks its own default in that case.
 */
export function codexModelOverride(raw?: string): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Human-readable guidance printed when Codex isn't installed. Includes
 * `checkAvailability`'s own detail string when it has one.
 */
export function codexInstallGuidance(availability: CodexAvailability): string {
  const lines = [
    "The Codex CLI is not installed.",
    "Install it with `npm install -g @openai/codex`, then authenticate with `codex login`.",
  ];
  if (availability.detail !== undefined && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}

/**
 * Human-readable guidance printed when Codex is installed but the user
 * hasn't run `codex login` yet. Includes `checkAvailability`'s own detail
 * string when it has one.
 */
export function codexLoginGuidance(availability: CodexAvailability): string {
  const lines = [
    "The Codex CLI is installed but you are not logged in.",
    "Run `codex login` to authenticate with your ChatGPT account — no OpenAI API key needed.",
  ];
  if (availability.detail !== undefined && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}
