import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolContext } from "@agent/core";
import { z } from "zod";
import { globToRegExp } from "./glob-pattern.js";
import { toInputSchema } from "./json-schema.js";
import {
  checkAbort,
  resolveInWorkspace,
  toWorkspaceRelative,
} from "./paths.js";

const MAX_MATCHES = 2000;
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git"]);

const InputSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe(
        "Glob pattern to match, e.g. `src/**/*.ts`. Supports `*`, `**`, and `?`.",
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Workspace-relative directory to search from. Defaults to the workspace root.",
      ),
  })
  .strict();

export type GlobInput = z.infer<typeof InputSchema>;

export interface GlobOutput {
  readonly matches: readonly string[];
  readonly truncated: boolean;
}

interface FsPromisesGlob {
  glob(
    pattern: string | readonly string[],
    options: GlobOptions,
  ): AsyncIterable<string>;
}

interface GlobOptions {
  cwd?: string;
  exclude?: (name: string) => boolean;
}

function isPathExcluded(name: string): boolean {
  return name.split("/").some((segment) => SKIPPED_DIR_NAMES.has(segment));
}

async function globViaNodeApi(
  glob: FsPromisesGlob["glob"],
  pattern: string,
  absoluteCwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  const results: string[] = [];
  for await (const match of glob(pattern, {
    cwd: absoluteCwd,
    exclude: isPathExcluded,
  })) {
    checkAbort(signal);
    if (isPathExcluded(match)) continue;
    results.push(match);
    if (results.length >= MAX_MATCHES) break;
  }
  return results;
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walk(
  dir: string,
  signal: AbortSignal,
  out: string[],
): Promise<void> {
  checkAbort(signal);
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, signal, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

async function globViaManualWalk(
  pattern: string,
  absoluteCwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  const regex = globToRegExp(pattern);
  const allFiles: string[] = [];
  await walk(absoluteCwd, signal, allFiles);
  const matches: string[] = [];
  for (const absolute of allFiles) {
    checkAbort(signal);
    const relativePath = toWorkspaceRelative(absoluteCwd, absolute);
    if (regex.test(relativePath)) {
      matches.push(relativePath);
      if (matches.length >= MAX_MATCHES) break;
    }
  }
  return matches;
}

export class GlobTool implements Tool<GlobInput, GlobOutput> {
  readonly name = "glob";
  readonly description =
    "Finds files in the workspace matching a glob pattern (supports `*`, `**`, `?`). " +
    "Returns workspace-relative paths, sorted. `node_modules` and `.git` are always skipped. " +
    "Results are capped at 2000 matches; `truncated` indicates if the cap was hit.";
  readonly inputSchema = toInputSchema(InputSchema);

  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  async execute(rawInput: unknown, context: ToolContext): Promise<GlobOutput> {
    const input = InputSchema.parse(rawInput);
    const absoluteCwd = resolveInWorkspace(
      context.workspacePath,
      input.cwd ?? ".",
    );
    checkAbort(context.signal);

    const fsPromises = await import("node:fs/promises");
    const globFn = (fsPromises as unknown as Partial<FsPromisesGlob>).glob;

    let matches: string[];
    if (typeof globFn === "function") {
      matches = await globViaNodeApi(
        globFn.bind(fsPromises),
        input.pattern,
        absoluteCwd,
        context.signal,
      );
    } else {
      matches = await globViaManualWalk(
        input.pattern,
        absoluteCwd,
        context.signal,
      );
    }

    const truncated = matches.length >= MAX_MATCHES;
    const relativeToWorkspace = matches
      .map((m) =>
        toWorkspaceRelative(context.workspacePath, join(absoluteCwd, m)),
      )
      .sort();

    return { matches: relativeToWorkspace, truncated };
  }
}
