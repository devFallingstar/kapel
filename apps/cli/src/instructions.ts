import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { kapelConfigDir } from "./config.js";

/**
 * Project/user instruction files (`AGENTS.md`), loaded and merged into the
 * system prompt.
 *
 * kapel is not the only agent a repository talks to, and `AGENTS.md` is
 * already the file Codex and opencode read for project rules — Claude Code
 * picks it up too, via `@AGENTS.md` imports in its own memory system. Reading
 * the same file means a repository only has to write its rules once.
 *
 * Three locations are merged, machine-level first so a project's own
 * `AGENTS.md` can add to (never silently lose to) a user's personal rules:
 *
 * 1. `<kapel config dir>/AGENTS.md` — machine/user level (`~/.kapel` by
 *    default, `$KAPEL_CONFIG_DIR`-aware).
 * 2. `<workspace root>/AGENTS.md` — project level, shared with other agents.
 * 3. `<workspace root>/.agent/AGENTS.md` — kapel-specific overrides.
 */

/** Result of loading whichever `AGENTS.md` files exist. */
export interface LoadedInstructions {
  /** The merged, header-annotated text — empty when nothing was found. */
  readonly text: string;
  /** Display-friendly paths of the files that contributed, in load order. */
  readonly sources: readonly string[];
}

/** Combined instruction text is capped at 32 KiB so one huge file can't blow out every prompt. */
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

const TRUNCATION_MARKER = "[instructions truncated]";

const PREAMBLE = "Project instructions (from AGENTS.md files):";

interface Source {
  /** Absolute path to read. */
  readonly absPath: string;
  /** How it is named in `sources` and in its own header line. */
  readonly display: string;
}

/**
 * Renders `absPath` relative to `home` as `~/...` when it lives under the
 * home directory, unchanged otherwise. Matches how paths are normally shown
 * to a person in a terminal.
 */
function abbreviateHome(absPath: string, home: string): string {
  if (absPath === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (!absPath.startsWith(prefix)) return absPath;
  return `~${path.sep}${absPath.slice(prefix.length)}`;
}

/** The three candidate files, in precedence order (machine-level first). */
function sourcesFor(
  workspacePath: string,
  env: NodeJS.ProcessEnv | undefined,
): readonly Source[] {
  const configPath = path.join(kapelConfigDir(env), "AGENTS.md");
  const projectPath = path.join(workspacePath, "AGENTS.md");
  const agentPath = path.join(workspacePath, ".agent", "AGENTS.md");
  return [
    { absPath: configPath, display: abbreviateHome(configPath, homedir()) },
    {
      absPath: projectPath,
      display: path.relative(workspacePath, projectPath),
    },
    { absPath: agentPath, display: path.relative(workspacePath, agentPath) },
  ];
}

/**
 * Truncates `text` to fit within {@link MAX_INSTRUCTIONS_BYTES} (measured in
 * UTF-8 bytes, since that is what actually crosses to a model), replacing
 * whatever fell off the end with a single marker line. Text already inside
 * the limit is returned unchanged.
 */
function capSize(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_INSTRUCTIONS_BYTES) return text;

  const markerLine = `\n${TRUNCATION_MARKER}`;
  const budget = Math.max(
    0,
    MAX_INSTRUCTIONS_BYTES - Buffer.byteLength(markerLine, "utf8"),
  );
  // Slice by bytes, then decode back — `Buffer#toString` folds any partial
  // multi-byte sequence left dangling at the cut into a single replacement
  // character rather than throwing, which is fine for a size cap.
  const truncated = Buffer.from(text, "utf8")
    .subarray(0, budget)
    .toString("utf8");
  return `${truncated}${markerLine}`;
}

/**
 * Loads and merges the `AGENTS.md` files that exist for `workspacePath`.
 *
 * Missing files are skipped silently (most repos have none of the three);
 * files that exist but can't be read (permissions, a directory named
 * `AGENTS.md`, ...) are skipped the same way rather than failing the run over
 * an instructions file. Whitespace-only files are treated as absent.
 */
export function loadInstructions(
  workspacePath: string,
  env?: NodeJS.ProcessEnv,
): LoadedInstructions {
  const blocks: string[] = [];
  const sources: string[] = [];

  for (const source of sourcesFor(workspacePath, env)) {
    let raw: string;
    try {
      raw = readFileSync(source.absPath, "utf8");
    } catch {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    sources.push(source.display);
    blocks.push(`# From ${source.display}\n\n${trimmed}`);
  }

  return { text: capSize(blocks.join("\n\n")), sources };
}

/**
 * Appends loaded instructions to a base system prompt. Returns `base`
 * unchanged when nothing was loaded, so callers never have to special-case
 * "no AGENTS.md files".
 */
export function composeSystemPrompt(
  base: string,
  instructions: LoadedInstructions,
): string {
  if (instructions.text === "") return base;
  return `${base}\n\n${PREAMBLE}\n\n${instructions.text}`;
}
