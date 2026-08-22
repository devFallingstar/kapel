import type { McpServerConfig } from "@agent/coding-agent";
import {
  findAgentDir,
  loadProjectConfig as loadAgentYaml,
  mergeMcpServers,
} from "@agent/coding-agent";
import { loadProjectConfig as loadLocalOverride } from "./config-project.js";

/**
 * Reads this workspace's MCP servers out of the two layers that may declare
 * them — `.agent/config.yaml` (committed) and `.agent/config.local.json` (this
 * checkout only) — and merges them.
 *
 * Tolerant for the same reason `loadRepoPermissionRules` is (see
 * `permissions.ts`): a REPL is not an orchestration run, `.agent/` has never
 * had to be valid for one to open, and losing a coding session over a typo in
 * an unrelated part of `config.yaml` would be a worse trade than losing the
 * MCP servers and saying so. Every problem found is returned for the caller to
 * print once; nothing here throws.
 */

export interface WorkspaceMcpServers {
  readonly servers: readonly McpServerConfig[];
  /** Printable lines: a malformed layer, or an entry that cannot be spawned. */
  readonly problems: readonly string[];
}

const NONE: WorkspaceMcpServers = { servers: [], problems: [] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadWorkspaceMcpServers(
  workspacePath: string,
): Promise<WorkspaceMcpServers> {
  let agentDir: string | undefined;
  try {
    agentDir = await findAgentDir(workspacePath);
  } catch {
    return NONE;
  }

  const problems: string[] = [];

  let committed = {};
  if (agentDir !== undefined) {
    try {
      committed = (await loadAgentYaml(agentDir)).mcp;
    } catch (error) {
      problems.push(
        `ignoring .agent/config.yaml mcp servers: ${errorMessage(error)}`,
      );
    }
  }

  // `loadProjectConfig` has already warned on stderr if the local file was
  // unreadable, so a `undefined` here needs no second complaint.
  const local = await loadLocalOverride(workspacePath);

  const merged = mergeMcpServers(committed, local?.mcp);
  return {
    servers: merged.servers,
    problems: [...problems, ...merged.problems],
  };
}
