import type { PermissionRuleSet } from "@agent/coding-agent";
import { findAgentDir, loadProjectConfig } from "@agent/coding-agent";
import type { PermissionDecision } from "@agent/core";

/**
 * Default per-tool permission decisions for the CLI: read-only tools are
 * pre-approved, anything that mutates the workspace or shells out asks first.
 *
 * `mcp__*` is in the second group. What an MCP tool does is decided by
 * somebody else's server — it may open a pull request, post a message or
 * delete a row — and kapel cannot tell which from the outside, so the honest
 * default is the one `bash` and `write_file` get: ask. The rule is written as
 * a wildcard because the tool names are the servers' to choose (see
 * `ruleFor` in `packages/coding-agent/src/permissions.ts`); a specific
 * `mcp__github__search_code: allow` in either config file is an exact key and
 * outranks it.
 */
export const DEFAULT_PERMISSIONS: Readonly<Record<string, PermissionDecision>> =
  {
    read_file: "allow",
    glob: "allow",
    grep: "allow",
    git_diff: "allow",
    write_file: "ask",
    edit_file: "ask",
    bash: "ask",
    "mcp__*": "ask",
  };

export const DEFAULT_PERMISSION_DECISION: PermissionDecision = "ask";

// --- P1-5: permission rules as configuration --------------------------------

function isPatternMap(
  rule: PermissionRuleSet[string] | undefined,
): rule is Readonly<Record<string, PermissionDecision>> {
  return typeof rule === "object" && rule !== null;
}

/**
 * Merges one config layer's `permission` block on top of the rules accrued
 * so far. For a plain tool the layer's verdict simply replaces whatever came
 * before it. `bash` is the exception: when *both* sides give it a pattern
 * map (opencode's `{"*": "ask", "git *": "allow"}` syntax), the maps are
 * merged key by key — a pattern with the same text in the new layer
 * overwrites the old one, but every other pattern from either layer stays,
 * to be resolved by specificity at request time (see
 * `packages/coding-agent/src/permissions.ts`'s `matchBashPermission`). A
 * layer that gives `bash` a flat verdict instead — as `DEFAULT_PERMISSIONS`
 * does — simply replaces the whole map, same as any other tool.
 */
function mergePermissionLayer(
  base: PermissionRuleSet,
  layer: PermissionRuleSet,
): PermissionRuleSet {
  const merged: Record<string, PermissionRuleSet[string]> = { ...base };
  for (const [tool, rule] of Object.entries(layer)) {
    const existing = merged[tool];
    merged[tool] =
      isPatternMap(existing) && isPatternMap(rule)
        ? { ...existing, ...rule }
        : rule;
  }
  return merged;
}

/**
 * Merges permission rule layers into the rule set `PermissionEngine`
 * consumes, in increasing precedence:
 *
 *     defaults < machine config (~/.kapel/config.json) < repo config (.agent/config.yaml)
 *
 * Layers are applied left to right; `undefined` layers (no config loaded, or
 * no `permission` block in it) are skipped. See {@link mergePermissionLayer}
 * for exactly how one layer combines with what came before it.
 *
 * An explicit `deny` produced by any layer is never masked by the P0-4
 * session allowlist: `PermissionEngine.authorize` resolves a verdict from
 * these rules first, returns immediately on `"deny"`, and only *then*
 * consults the overlay — so that guarantee holds for whatever this function
 * produces without any extra plumbing here.
 */
export function resolvePermissionRules(
  defaults: PermissionRuleSet,
  ...layers: ReadonlyArray<PermissionRuleSet | undefined>
): PermissionRuleSet {
  let merged: PermissionRuleSet = defaults;
  for (const layer of layers) {
    if (layer === undefined) continue;
    merged = mergePermissionLayer(merged, layer);
  }
  return merged;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The repo-level permission layer: `<workspacePath>/.agent/config.yaml`'s
 * `permission:` block, when the file and directory exist.
 *
 * Tolerant by design — unlike the rest of `.agent/config.yaml`'s consumers
 * (`orchestrate`, `plan`, ...), which surface a malformed file loudly because
 * it is central to what they do, a one-shot or interactive run's permission
 * lookup is a small extra on top of a flow that has never required `.agent/`
 * to be valid. A parse or schema problem elsewhere in the file (an unrelated
 * bad validator entry, say) is reported to stderr once and the repo layer is
 * simply left out, rather than failing the run.
 */
export async function loadRepoPermissionRules(
  workspacePath: string,
): Promise<PermissionRuleSet | undefined> {
  let agentDir: string | undefined;
  try {
    agentDir = await findAgentDir(workspacePath);
  } catch {
    return undefined;
  }
  if (agentDir === undefined) return undefined;

  try {
    const config = await loadProjectConfig(agentDir);
    return Object.keys(config.permission).length > 0
      ? config.permission
      : undefined;
  } catch (error) {
    console.error(
      `warning: ignoring .agent/config.yaml permission rules: ${errorMessage(error)}`,
    );
    return undefined;
  }
}
