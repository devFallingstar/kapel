import type { ModelProvider } from "@agent/ai";
import {
  AnthropicProvider,
  defaultModelCatalog,
  OpenAIProvider,
  StaticModelRegistry,
} from "@agent/ai";

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

/** Builds one `ModelProvider` per API key present in `env`. */
export function buildProviders(env: EnvLike): readonly ModelProvider[] {
  const providers: ModelProvider[] = [];

  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey !== undefined && anthropicKey !== "") {
    const baseUrl = env.ANTHROPIC_BASE_URL;
    providers.push(
      new AnthropicProvider({
        apiKey: anthropicKey,
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
export function buildRegistry(env: EnvLike): StaticModelRegistry {
  return new StaticModelRegistry(defaultModelCatalog(), buildProviders(env));
}

/** Whether `env` has an API key for the given provider id. */
export function hasApiKey(env: EnvLike, provider: string): boolean {
  const envVar = envVarForProvider(provider);
  if (envVar === undefined) return false;
  const value = env[envVar];
  return value !== undefined && value !== "";
}

export interface ModelListEntry {
  readonly alias: string;
  readonly provider: string;
  readonly hasKey: boolean;
}

/** Every catalog alias, its provider, and whether that provider's API key is present. */
export function listModels(env: EnvLike): readonly ModelListEntry[] {
  const registry = buildRegistry(env);
  return registry
    .aliases()
    .slice()
    .sort()
    .map((alias) => {
      const model = registry.get(alias);
      return {
        alias,
        provider: model.provider,
        hasKey: hasApiKey(env, model.provider),
      };
    });
}
