import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodIssues, isNotFound } from "./internal.js";
import type { AgentProjectConfig, ProjectModelRef } from "./types.js";
import { ProjectConfigError } from "./types.js";

const ModelRefSchema = z
  .object({
    provider: z.string().min(1, "must not be empty"),
    model: z.string().min(1, "must not be empty"),
  })
  .strict();

const ConfigFileSchema = z
  .object({
    models: z.record(z.string(), ModelRefSchema).optional(),
    agents: z
      .record(z.string(), z.string().min(1, "must not be empty"))
      .optional(),
  })
  .strict();

const EMPTY_CONFIG: AgentProjectConfig = { models: {}, agentSlots: {} };

/**
 * Loads `<agentDir>/config.yaml`. A missing file yields the empty config
 * (`{ models: {}, agentSlots: {} }`); malformed YAML or a shape mismatch
 * throws {@link ProjectConfigError} with every problem found.
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

  return {
    models,
    agentSlots: { ...(result.data.agents ?? {}) },
  };
}
