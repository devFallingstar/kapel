import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_RELATIVE = ["templates", "default", ".agent"];
const MAX_WALK_LEVELS = 6;

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
  return 0;
}
