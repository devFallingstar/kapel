import type { ModelDefinition } from "@agent/ai";
import type {
  ClaudeCodeAvailability,
  CodexAvailability,
} from "@agent/coding-agent";
import { ClaudeCodeBackend, CodexBackend } from "@agent/coding-agent";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Execution backends the CLI can dispatch an objective to. */
export const BACKEND_NAMES = ["native", "codex", "claude-code"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export const DEFAULT_BACKEND: BackendName = "native";

/** The backends that hand the work to an external coding CLI. */
export type DelegatedBackendName = Exclude<BackendName, "native">;

function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

/**
 * Whether a backend hands the work to an external coding CLI rather than
 * running kapel's own provider loop.
 *
 * Narrows to {@link DelegatedBackendName} so callers that then have to pick
 * between the two CLIs do not have to re-test for `"native"`.
 *
 * The distinction decides more than which class gets constructed: a delegated
 * backend authenticates itself, enforces its own approvals, and needs no API
 * credential from us — so the model registry, the `PermissionEngine` and the
 * permission prompter are all skipped on those paths.
 */
export function isDelegatedBackend(
  backend: BackendName,
): backend is DelegatedBackendName {
  return backend === "codex" || backend === "claude-code";
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

/**
 * Human-readable guidance printed when the Claude Code CLI isn't installed.
 * Mirrors {@link codexInstallGuidance} — same shape, same exit path.
 */
export function claudeCodeInstallGuidance(
  availability: ClaudeCodeAvailability,
): string {
  const lines = [
    "The Claude Code CLI is not installed.",
    "Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in with your Claude subscription.",
  ];
  if (availability.detail !== undefined && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}

/**
 * Human-readable guidance printed when the Claude Code CLI is installed but
 * no subscription login is present.
 */
export function claudeCodeLoginGuidance(
  availability: ClaudeCodeAvailability,
): string {
  const lines = [
    "The Claude Code CLI is installed but you are not logged in.",
    "Run `claude` once and log in with your Claude subscription — no Anthropic API key needed.",
  ];
  if (availability.detail !== undefined && availability.detail !== "") {
    lines.push(availability.detail);
  }
  return lines.join("\n");
}

/**
 * A `ModelDefinition` that stands for "whatever the delegating CLI runs".
 *
 * Display only: commands print who planned or who compiled, and on this path
 * nobody resolves a real model definition — the CLI owns its own catalog and
 * account. So the two fields that are actually knowable are filled in
 * honestly (the CLI's provider, and the model id we asked for, or a visible
 * placeholder when we asked for nothing), capabilities are left flat, and no
 * pricing is claimed: we are not billed per token here and inventing rates
 * would put fictional costs in the usage line.
 *
 * The id is also what `kapel policy compile` records as the lockfile's
 * `model`, which is an informational field (`LockfileSchema` only asks for a
 * string, and `checkLock` never reads it), so a placeholder there is honest
 * rather than load-bearing.
 */
export function delegatedModelIdentity(
  backend: DelegatedBackendName,
  model: string | undefined,
): ModelDefinition {
  return {
    provider: backend === "codex" ? "openai" : "anthropic",
    id: model ?? `<${backend} default>`,
    capabilities: {
      tools: false,
      reasoning: false,
      vision: false,
      structuredOutput: false,
    },
  };
}

/**
 * Checks that the delegating CLI is actually usable before work is asked of
 * it. The same probe (and the same guidance text) the worker side runs in
 * `workspaceExecutorFactory`: a sentence naming the install or login command
 * beats a spawn failure surfacing three attempts later as "no plan".
 */
export async function delegatedBackendError(
  backend: DelegatedBackendName,
): Promise<string | undefined> {
  if (backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    if (!availability.installed) return claudeCodeInstallGuidance(availability);
    if (!availability.loggedIn) return claudeCodeLoginGuidance(availability);
    return undefined;
  }
  const availability = await CodexBackend.checkAvailability();
  if (!availability.installed) return codexInstallGuidance(availability);
  if (!availability.loggedIn) return codexLoginGuidance(availability);
  return undefined;
}
