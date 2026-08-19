import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KapelBackend, KapelConfig, KapelRole } from "./config.js";

const TEMPLATE_RELATIVE = ["templates", "default", ".agent"];
const MAX_WALK_LEVELS = 6;

/** The project roles `.agent/config.yaml` names, and where each one's model comes from. */
const PROJECT_ROLE_SOURCES: readonly (readonly [string, KapelRole])[] = [
  ["lead", "orchestrator"],
  ["complex", "complex"],
  ["worker", "middle"],
  ["cheap", "low"],
  // The reviewer reads someone else's work and judges it, which is the
  // orchestrator's kind of job rather than a worker's — so it gets the
  // orchestrator's model rather than another answer nobody was asked for.
  ["reviewer", "orchestrator"],
];

const ANTHROPIC_MODEL = /^(claude-|opus|sonnet|haiku)/;

/**
 * Which provider serves a model named in the global config.
 *
 * The wizard's model lists are per backend, not per provider, so the provider
 * has to be inferred here: Claude Code's aliases and every `claude-*` id are
 * Anthropic, `"default"` means "whatever that CLI picks" (Anthropic under
 * Claude Code, OpenAI under Codex), and everything else is OpenAI.
 */
export function providerForModel(
  model: string,
  backend: KapelBackend,
): "anthropic" | "openai" {
  if (ANTHROPIC_MODEL.test(model)) return "anthropic";
  if (model === "default") {
    return backend === "claude-code" ? "anthropic" : "openai";
  }
  return "openai";
}

/** The `models:` block a config seeds into `.agent/config.yaml`. */
export function renderModelsBlock(config: KapelConfig): readonly string[] {
  const lines = ["models:"];
  for (const [projectRole, role] of PROJECT_ROLE_SOURCES) {
    const model = config.models[role];
    lines.push(
      `  ${projectRole}:`,
      `    provider: ${providerForModel(model, config.backend)}`,
      `    model: ${model}`,
    );
  }
  return lines;
}

/**
 * Replaces the template's `models:` block with one built from the global
 * config, leaving every other line — including the commented `validation:`
 * example — exactly as the template shipped it.
 *
 * Done as a line splice rather than a YAML round-trip on purpose: re-emitting
 * the document would drop the comments that are most of what the template is
 * for. A template that somehow has no `models:` block is returned untouched.
 */
export function seedModelsInto(
  templateYaml: string,
  config: KapelConfig,
): string {
  const lines = templateYaml.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "models:");
  if (start === -1) return templateYaml;

  // The block runs to the next line that starts a new top-level key.
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    end += 1;
  }

  return [
    ...lines.slice(0, start),
    ...renderModelsBlock(config),
    "",
    ...lines.slice(end),
  ].join("\n");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks up from `startDir` (at most `maxLevels` parent directories) looking
 * for `templates/default/.agent`. Throws a descriptive error if it isn't
 * found — this happens when the CLI is run from somewhere the repo's
 * `templates/` directory isn't reachable from (e.g. installed standalone).
 */
export async function locateTemplate(
  startDir: string,
  maxLevels: number = MAX_WALK_LEVELS,
): Promise<string> {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level += 1) {
    const candidate = path.join(dir, ...TEMPLATE_RELATIVE);
    if (await pathExists(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not find ${TEMPLATE_RELATIVE.join("/")} by walking up from ` +
      `${startDir} (searched ${maxLevels} levels up). Is this CLI running ` +
      "from within the multi-model-orchestration-agent repo?",
  );
}

export interface InitOptions {
  readonly cwd: string;
  readonly force?: boolean;
  /** Override for tests: defaults to this module's own `import.meta.url`. */
  readonly entryUrl?: string;
  /**
   * The machine's configuration. When present, the new project's `models:`
   * start from the answers already given to `kapel config` instead of the
   * template's defaults; absent, the template is copied verbatim.
   */
  readonly config?: KapelConfig;
}

/** Implements `kapel init`: copies the repo's `.agent` template into `cwd`. */
export async function runInit(options: InitOptions): Promise<number> {
  const entryDir = path.dirname(
    fileURLToPath(options.entryUrl ?? import.meta.url),
  );

  let templateDir: string;
  try {
    templateDir = await locateTemplate(entryDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const target = path.join(options.cwd, ".agent");
  const exists = await pathExists(target);
  if (exists && options.force !== true) {
    console.error(
      `${target} already exists. Re-run with --force to overwrite it.`,
    );
    return 1;
  }
  // Replace rather than merge on --force, so a stale file that the template
  // no longer ships doesn't linger in the target.
  if (exists) await rm(target, { recursive: true, force: true });

  await cp(templateDir, target, { recursive: true });
  console.log(`Created ${target}`);
  console.log(`  (from ${templateDir})`);

  const config = options.config;
  if (config !== undefined) {
    const configPath = path.join(target, "config.yaml");
    try {
      const template = await readFile(configPath, "utf8");
      await writeFile(configPath, seedModelsInto(template, config), "utf8");
      console.log("  (models seeded from your kapel configuration)");
    } catch {
      // Seeding is a convenience on top of a copy that already succeeded:
      // a template without a readable config.yaml still leaves a usable
      // project behind, so this never fails `kapel init`.
    }
  }
  return 0;
}
