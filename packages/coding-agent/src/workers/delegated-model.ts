import type { AgentProject } from "../project/index.js";

/**
 * The `.agent/config.yaml` sentinel meaning "let the delegating CLI pick its
 * own default model" rather than naming one.
 *
 * Mirrors the wizard's `"default"` value handled by `delegatedModelOverride`
 * in `apps/cli/src/config-runtime.ts`: that function is the precedent for
 * this rule, but it lives in the CLI app and packages must not import from
 * apps, so the rule is duplicated here rather than shared.
 */
const DEFAULT_MODEL_SENTINEL = "default";

/**
 * Resolves the model id a delegating CLI backend (Codex, and — per a
 * follow-up task — Claude Code) should be told to use for a given agent.
 *
 * Lookup path: `agent name -> ProjectAgent.modelAlias -> AgentProjectConfig
 * .models[alias].model`. Any break in that chain — an unknown agent, an
 * alias with no entry in `config.yaml`'s `models:` block, or a configured
 * model equal to {@link DEFAULT_MODEL_SENTINEL} — resolves to `undefined`,
 * which callers treat as "don't pass `-m`, let the CLI use its own default".
 *
 * Deliberately not validated against provider: unlike the in-process
 * `AgentLoopWorkerExecutor`, which resolves a model through this repo's own
 * provider registry and so must find a definition it recognizes, a
 * delegating backend hands the model id straight to a CLI that owns its own
 * account and catalog. Rejecting or filtering an id here on the grounds
 * that "this doesn't look like a Codex model" would be a guess this code has
 * no way to verify — the CLI's own account is the only source of truth for
 * what it can serve. Passing the id through unfiltered means a
 * misconfigured or unsupported model fails loudly inside the CLI, with an
 * error that names the model, instead of this layer silently discarding the
 * project's configuration and running on a default nobody asked for.
 */
export function createDelegatedModelResolver(
  project: AgentProject,
): (agent: string) => string | undefined {
  return (agent) => {
    const projectAgent = project.agent(agent);
    if (projectAgent === undefined) return undefined;

    const ref = project.config.models[projectAgent.modelAlias];
    if (ref === undefined) return undefined;

    if (ref.model === DEFAULT_MODEL_SENTINEL) return undefined;
    return ref.model;
  };
}
