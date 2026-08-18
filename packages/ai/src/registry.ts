import type { ModelDefinition, ModelProvider, ModelRegistry } from "./index.js";

/** A registry backed by a fixed model catalog and a fixed provider list. */
export class StaticModelRegistry implements ModelRegistry {
  readonly #models: Readonly<Record<string, ModelDefinition>>;
  readonly #providers: readonly ModelProvider[];

  constructor(
    models: Readonly<Record<string, ModelDefinition>>,
    providers: readonly ModelProvider[],
  ) {
    this.#models = models;
    this.#providers = providers;
  }

  get(alias: string): ModelDefinition {
    const model = this.#models[alias];
    if (model === undefined) {
      const known = Object.keys(this.#models).sort().join(", ");
      throw new Error(
        `Unknown model alias "${alias}". Known aliases: ${known === "" ? "(none registered)" : known}`,
      );
    }
    return model;
  }

  providerFor(model: ModelDefinition): ModelProvider {
    const provider = this.#providers.find((candidate) => candidate.supports(model));
    if (provider === undefined) {
      const known = this.#providers.map((candidate) => candidate.id).join(", ");
      throw new Error(
        `No provider supports model "${model.provider}/${model.id}". Registered providers: ${known === "" ? "(none registered)" : known}`,
      );
    }
    return provider;
  }

  aliases(): readonly string[] {
    return Object.keys(this.#models);
  }
}
