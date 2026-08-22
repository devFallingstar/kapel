import { z } from "zod";

/**
 * The `mcp:` configuration block, and the merge of the two layers that may
 * carry one.
 *
 * The shape is the one users already know from Claude Code's `mcpServers` and
 * opencode's `mcp`: a map of server name to `{command, args, env, enabled}`.
 * Deliberately nothing more — no transport selector, no URL — because this
 * change ships the stdio transport only, and a key that names a transport
 * kapel cannot open would be a promise the runtime does not keep.
 *
 * Two layers, no more (kapel's config philosophy is two layers everywhere):
 *
 *     .agent/config.yaml   the project's servers, committed, shared
 *     .agent/config.local.json   this checkout's override, gitignored
 *
 * The override merges *per field*, not per server, which is what makes the two
 * useful together: the project commits `command`/`args`, and a checkout adds
 * the token in `env` or turns one server off with a bare `{"enabled": false}`
 * without restating the command it is disabling.
 */

/**
 * One entry as written in either file. Every field is optional here — including
 * `command` — because the override layer is allowed to mention a server it did
 * not define. A merged entry that still has no command is dropped and reported;
 * see {@link mergeMcpServers}.
 */
export const McpServerInputSchema = z
  .object({
    command: z.string().min(1, "must not be empty").optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export const McpServersInputSchema = z.record(
  z.string().min(1, "must not be empty"),
  McpServerInputSchema,
);

export type McpServersInput = z.infer<typeof McpServersInputSchema>;

/** One server, after both layers have been merged and defaults filled in. */
export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Overlaid on the parent process environment, never replacing it. */
  readonly env: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}

export interface MergedMcpServers {
  /** Every configured server, in `config.yaml` order then override-only names. */
  readonly servers: readonly McpServerConfig[];
  /** Entries that could not be used, one printable line each. */
  readonly problems: readonly string[];
}

/**
 * Layers `override` (`.agent/config.local.json`) on top of `base`
 * (`.agent/config.yaml`).
 *
 * Field by field: `command` and `args` are replaced wholesale by whichever
 * layer names them last, `enabled` likewise, and `env` merges key by key so an
 * override adding one variable keeps the ones the project declared. A server
 * named only by the override is a server the override defines outright, and
 * needs its own `command` like any other.
 *
 * Never throws: a server that cannot be used is left out of `servers` and named
 * in `problems`, because one broken entry is not a reason to lose the rest of
 * someone's configuration.
 */
export function mergeMcpServers(
  base: McpServersInput | undefined,
  override: McpServersInput | undefined,
): MergedMcpServers {
  const baseEntries = base ?? {};
  const overrideEntries = override ?? {};

  const names: string[] = Object.keys(baseEntries);
  for (const name of Object.keys(overrideEntries)) {
    if (!names.includes(name)) names.push(name);
  }

  const servers: McpServerConfig[] = [];
  const problems: string[] = [];

  for (const name of names) {
    const from = baseEntries[name];
    const onTop = overrideEntries[name];

    const command = onTop?.command ?? from?.command;
    if (command === undefined) {
      problems.push(
        `mcp.${name}: no "command" in either config layer — ignoring this server.`,
      );
      continue;
    }

    servers.push({
      name,
      command,
      args: onTop?.args ?? from?.args ?? [],
      env: { ...(from?.env ?? {}), ...(onTop?.env ?? {}) },
      enabled: onTop?.enabled ?? from?.enabled ?? true,
    });
  }

  return { servers, problems };
}

/** The subset a session actually spawns: everything not turned off. */
export function enabledMcpServers(
  servers: readonly McpServerConfig[],
): readonly McpServerConfig[] {
  return servers.filter((server) => server.enabled);
}
