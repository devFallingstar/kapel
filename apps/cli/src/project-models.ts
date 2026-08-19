import type {
  ModelCapabilities,
  ModelDefinition,
  ModelProvider,
} from "@agent/ai";
import { defaultModelCatalog } from "@agent/ai";
import type {
  AgentProject,
  ProjectModelRef,
  ResolvedWorkerModel,
  WorkerModelResolver,
} from "@agent/coding-agent";
import {
  buildProviders,
  credentialHintForProvider,
  type EnvLike,
} from "./models.js";

/**
 * Capabilities assumed for a `.agent/config.yaml` model the built-in catalog
 * has never heard of.
 *
 * Tool calling and structured output are non-negotiable — a worker that cannot
 * call tools cannot do anything — so they are asserted rather than guessed.
 * `vision` is the one capability nothing in the worker path needs, so it stays
 * off: claiming it for an unknown model would be an unforced lie.
 */
const ASSUMED_CAPABILITIES: ModelCapabilities = {
  tools: true,
  reasoning: true,
  vision: false,
  structuredOutput: true,
};

/**
 * Resolves a project's `{provider, model}` pair to a full
 * {@link ModelDefinition}.
 *
 * A catalog hit brings pricing, context window and real capabilities along with
 * it, which is what makes cost accounting work for project-configured models.
 * The catalog is keyed by model id, but the lookup matches on **both** id and
 * provider: `config.yaml` is free to point an id at a different provider (a
 * gateway, a compatible endpoint), and inheriting Anthropic's prices for an id
 * served by someone else would be wrong.
 */
export function modelDefinitionFor(ref: ProjectModelRef): ModelDefinition {
  for (const definition of Object.values(defaultModelCatalog())) {
    if (definition.id === ref.model && definition.provider === ref.provider) {
      return definition;
    }
  }
  return {
    provider: ref.provider,
    id: ref.model,
    capabilities: ASSUMED_CAPABILITIES,
  };
}

function knownAliases(project: AgentProject): string {
  const aliases = Object.keys(project.config.models).sort();
  return aliases.length === 0 ? "(none defined)" : aliases.join(", ");
}

/**
 * Builds the {@link WorkerModelResolver} that maps an agent's `model:`
 * front-matter alias to the provider and model definition that serve it.
 *
 * Credentials come from the same resolution the rest of the CLI uses
 * ({@link buildProviders}), including the async Anthropic OAuth path — which is
 * why this is async while the resolver it returns is not. The providers are
 * built once, up front, and captured in the returned closure:
 * `WorkerModelResolver` is synchronous by contract, and resolving credentials
 * per task would shell out to `ant` once per task.
 *
 * Both failure modes throw with a message naming the alias, because the
 * executor turns a throw here into a failed task result that a human has to be
 * able to act on.
 */
export async function createProjectModelResolver(
  project: AgentProject,
  env: EnvLike,
): Promise<WorkerModelResolver> {
  const providers: readonly ModelProvider[] = await buildProviders(env);

  return (modelAlias: string): ResolvedWorkerModel => {
    const ref = project.config.models[modelAlias];
    if (ref === undefined) {
      throw new Error(
        `Model alias "${modelAlias}" is not defined in ${project.root}/config.yaml. Known aliases: ${knownAliases(project)}.`,
      );
    }

    const model = modelDefinitionFor(ref);
    const provider = providers.find((candidate) => candidate.supports(model));
    if (provider === undefined) {
      throw new Error(
        `Model alias "${modelAlias}" (${ref.provider}/${ref.model}) requires the "${ref.provider}" provider, which is not configured: ${credentialHintForProvider(ref.provider)}.`,
      );
    }

    return { provider, model };
  };
}
