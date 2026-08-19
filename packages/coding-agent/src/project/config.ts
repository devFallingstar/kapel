import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodIssues, isNotFound } from "./internal.js";
import type {
  AgentProjectConfig,
  ProjectModelRef,
  ProjectValidator,
} from "./types.js";
import {
  DEFAULT_VALIDATOR_TIMEOUT_SECONDS,
  ProjectConfigError,
} from "./types.js";

const ModelRefSchema = z
  .object({
    provider: z.string().min(1, "must not be empty"),
    model: z.string().min(1, "must not be empty"),
  })
  .strict();

const ValidatorSchema = z
  .object({
    name: z.string().min(1, "must not be empty"),
    command: z.string().min(1, "must not be empty"),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();

// opencode's permission syntax (P1-5): a flat verdict per tool, or, for
// `bash`, a map of command-prefix patterns to verdicts —
// `{"bash": {"*": "ask", "git *": "allow"}}`. See
// `packages/coding-agent/src/permissions.ts` for how a pattern matches.
const PermissionDecisionSchema = z.enum(["allow", "ask", "deny"]);
const BashPermissionRulesSchema = z.record(
  z.string(),
  PermissionDecisionSchema,
);
const ToolPermissionRuleSchema = z.union([
  PermissionDecisionSchema,
  BashPermissionRulesSchema,
]);
const PermissionSchema = z.record(z.string(), ToolPermissionRuleSchema);

const ConfigFileSchema = z
  .object({
    models: z.record(z.string(), ModelRefSchema).optional(),
    agents: z
      .record(z.string(), z.string().min(1, "must not be empty"))
      .optional(),
    validation: z.array(ValidatorSchema).optional(),
    permission: PermissionSchema.optional(),
  })
  .strict();

const EMPTY_CONFIG: AgentProjectConfig = {
  models: {},
  agentSlots: {},
  validators: [],
  permission: {},
};

/**
 * Loads `<agentDir>/config.yaml`. A missing file yields the empty config
 * (`{ models: {}, agentSlots: {}, validators: [], permission: {} }`);
 * malformed YAML or a shape mismatch throws {@link ProjectConfigError} with
 * every problem found.
 */
export async function loadProjectConfig(
  agentDir: string,
): Promise<AgentProjectConfig> {
  const filePath = join(agentDir, "config.yaml");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return EMPTY_CONFIG;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ProjectConfigError(filePath, [
      `YAML parse error: ${(err as Error).message}`,
    ]);
  }

  if (parsed === null || parsed === undefined) return EMPTY_CONFIG;

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectConfigError(filePath, formatZodIssues(result.error));
  }

  const models: Record<string, ProjectModelRef> = {};
  for (const [alias, ref] of Object.entries(result.data.models ?? {})) {
    models[alias] = { provider: ref.provider, model: ref.model };
  }

  // The default is resolved here rather than at run time so that everything
  // downstream — the runner, the reporting, a future `kapel config` dump —
  // agrees on how long a validator is allowed to take.
  const validators: ProjectValidator[] = (result.data.validation ?? []).map(
    (entry) => ({
      name: entry.name,
      command: entry.command,
      timeoutSeconds: entry.timeoutSeconds ?? DEFAULT_VALIDATOR_TIMEOUT_SECONDS,
    }),
  );

  return {
    models,
    agentSlots: { ...(result.data.agents ?? {}) },
    validators,
    permission: { ...(result.data.permission ?? {}) },
  };
}
