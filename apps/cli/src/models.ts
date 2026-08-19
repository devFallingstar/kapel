import type { ModelProvider } from "@agent/ai";
import {
  AnthropicProvider,
  defaultModelCatalog,
  OpenAIProvider,
  StaticModelRegistry,
} from "@agent/ai";
import type { AnthropicCredential } from "./auth.js";
import { resolveAnthropicCredential } from "./auth.js";

export const DEFAULT_MODEL_ALIAS = "claude-sonnet-5";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The effective model alias for a run: an explicit `--model` flag wins, then
 * `AGENT_MODEL`, then the built-in default.
 */
export function resolveModelAlias(env: EnvLike, flag?: string): string {
  if (flag !== undefined && flag !== "") return flag;
  const fromEnv = env.AGENT_MODEL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_MODEL_ALIAS;
}

/** The environment variable that must be set to authenticate a provider. */
export function envVarForProvider(provider: string): string | undefined {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openai" || provider === "openai-compatible") {
    return "OPENAI_API_KEY";
  }
  return undefined;
}

export function baseUrlEnvVarForProvider(provider: string): string | undefined {
  if (provider === "anthropic") return "ANTHROPIC_BASE_URL";
  if (provider === "openai" || provider === "openai-compatible") {
    return "OPENAI_BASE_URL";
  }
  return undefined;
}

export interface BuildProvidersOptions {
  /** Forwarded to {@link resolveAnthropicCredential} — set `false` to skip
   *  the `ant auth print-credentials` fallback entirely. */
  readonly allowProfile?: boolean;
  /**
   * A pre-resolved Anthropic credential, so callers that already resolved
   * one (e.g. {@link listModels}, which also needs it for display) don't
   * pay for a second `ant` subprocess call.
   */
  readonly anthropicCredential?: AnthropicCredential;
}

/**
 * Builds one `ModelProvider` per credential present in `env`. Anthropic
 * credential resolution follows {@link resolveAnthropicCredential}'s
 * precedence (env vars, then an `ant auth login` OAuth profile).
 *
 * Note: an OAuth access token from `ant` is short-lived and is resolved
 * once, up front, for the lifetime of the constructed `AnthropicProvider`.
 * A very long-running invocation could in principle outlive that token and
 * start getting 401s partway through; we accept that rather than
 * re-resolving mid-run, since re-authenticating mid-stream would be far
 * more invasive to plumb through.
 */
export async function buildProviders(
  env: EnvLike,
  opts?: BuildProvidersOptions,
): Promise<readonly ModelProvider[]> {
  const providers: ModelProvider[] = [];

  const anthropicCredential =
    opts?.anthropicCredential ??
    (await resolveAnthropicCredential(env, {
      ...(opts?.allowProfile === undefined
        ? {}
        : { allowProfile: opts.allowProfile }),
    }));

  if (anthropicCredential !== undefined) {
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const credentialOptions =
      anthropicCredential.kind === "api-key"
        ? { apiKey: anthropicCredential.apiKey }
        : { authToken: anthropicCredential.authToken };
    providers.push(
      new AnthropicProvider({
        ...credentialOptions,
        ...(baseUrl !== undefined && baseUrl !== "" ? { baseUrl } : {}),
      }),
    );
  }

  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey !== undefined && openaiKey !== "") {
    const baseUrl = env.OPENAI_BASE_URL;
    providers.push(
      new OpenAIProvider({
        apiKey: openaiKey,
        ...(baseUrl !== undefined && baseUrl !== "" ? { baseUrl } : {}),
      }),
    );
  }

  return providers;
}

/** Registry over the built-in model catalog, backed by whichever providers `env` authenticates. */
export async function buildRegistry(
  env: EnvLike,
  opts?: BuildProvidersOptions,
): Promise<StaticModelRegistry> {
  return new StaticModelRegistry(
    defaultModelCatalog(),
    await buildProviders(env, opts),
  );
}

/** Whether `env` has an API key for the given provider id. */
export function hasApiKey(env: EnvLike, provider: string): boolean {
  const envVar = envVarForProvider(provider);
  if (envVar === undefined) return false;
  const value = env[envVar];
  return value !== undefined && value !== "";
}

/**
 * A human-readable hint for how to configure credentials for `provider`,
 * used both in the `kapel models` listing's help text and in the
 * missing-credential error `run` raises. Anthropic gets a richer message
 * than the generic "set THIS_ENV_VAR" hint, since it has three valid
 * credential sources.
 */
export function credentialHintForProvider(provider: string): string {
  if (provider === "anthropic") {
    return (
      "set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in your shell " +
      "environment or in a .env file in the workspace, or log in with " +
      "the Anthropic CLI: `ant auth login`"
    );
  }
  const envVar = envVarForProvider(provider);
  return envVar === undefined
    ? `no provider is configured for "${provider}"`
    : `set ${envVar} in your shell environment or in a .env file in the workspace`;
}

/**
 * Formats how `kapel models` should display the Anthropic credential (or
 * lack of one) for an anthropic-provider row: the credential's source when
 * present, `"✗"` when absent. Factored out as a pure function so the
 * formatting logic is testable without shelling out to `ant`.
 */
export function formatAnthropicCredentialStatus(
  credential: AnthropicCredential | undefined,
): string {
  if (credential === undefined) return "✗";
  if (credential.kind === "api-key") return "api key";
  return credential.source === "env" ? "auth token" : "oauth (ant)";
}

export interface ModelListEntry {
  readonly alias: string;
  readonly provider: string;
  /** True when a credential is available for this model's provider. */
  readonly hasKey: boolean;
  /**
   * The text `kapel models` prints for this row's credential status: for
   * anthropic, the credential source ("api key" / "auth token" /
   * "oauth (ant)") or "✗"; for every other provider, plain "✓" / "✗".
   */
  readonly credentialStatus: string;
}

/** Every catalog alias, its provider, and its credential status. */
export async function listModels(
  env: EnvLike,
  opts?: { readonly allowProfile?: boolean },
): Promise<readonly ModelListEntry[]> {
  const anthropicCredential = await resolveAnthropicCredential(env, opts);
  const registry = await buildRegistry(env, {
    ...(anthropicCredential === undefined ? {} : { anthropicCredential }),
  });

  return registry
    .aliases()
    .slice()
    .sort()
    .map((alias) => {
      const model = registry.get(alias);
      if (model.provider === "anthropic") {
        return {
          alias,
          provider: model.provider,
          hasKey: anthropicCredential !== undefined,
          credentialStatus:
            formatAnthropicCredentialStatus(anthropicCredential),
        };
      }
      const hasKey = hasApiKey(env, model.provider);
      return {
        alias,
        provider: model.provider,
        hasKey,
        credentialStatus: hasKey ? "✓" : "✗",
      };
    });
}
