import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Tool, ToolContext } from "@agent/core";
import { z } from "zod";
import { globToRegExp } from "./glob-pattern.js";
import { toInputSchema } from "./json-schema.js";
import {
  checkAbort,
  resolveInWorkspace,
  toWorkspaceRelative,
} from "./paths.js";

const DEFAULT_MAX_MATCHES = 200;
const MAX_LINE_CHARS = 500;
const BINARY_SNIFF_BYTES = 8000;
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git"]);

const InputSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe("JavaScript regular expression source to search for."),
    path: z
      .string()
      .optional()
      .describe(
        "Workspace-relative file or directory to search. Defaults to the workspace root.",
      ),
    glob: z
      .string()
      .optional()
      .describe(
        "Optional glob (e.g. `**/*.ts`) to restrict which files are searched.",
      ),
    ignoreCase: z.boolean().optional().describe("Case-insensitive matching."),
    maxMatches: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of matches to return. Defaults to 200."),
  })
  .strict();

export type GrepInput = z.infer<typeof InputSchema>;

export interface GrepMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface GrepOutput {
  readonly matches: readonly GrepMatch[];
  readonly truncated: boolean;
}

function looksBinary(buf: Buffer): boolean {
  const sniffLen = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export class GrepTool implements Tool<GrepInput, GrepOutput> {
  readonly name = "grep";
  readonly description =
    "Recursively searches text files in the workspace for lines matching a JavaScript regular " +
    "expression. `path` scopes the search to a workspace-relative file or directory; `glob` " +
    "further filters filenames (matched against the full relative path or just the basename, " +
    "e.g. `*.ts` or `src/**/*.ts`). Skips `node_modules`, `.git`, and binary-looking files. " +
    "Returns up to `maxMatches` (default 200) matches, each line capped at 500 characters.";
  readonly inputSchema = toInputSchema(InputSchema);

  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  async execute(rawInput: unknown, context: ToolContext): Promise<GrepOutput> {
    const input = InputSchema.parse(rawInput);

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
    } catch (err) {
      throw new Error(`invalid regex pattern: ${(err as Error).message}`);
    }

    const root = resolveInWorkspace(context.workspacePath, input.path ?? ".");
    checkAbort(context.signal);

    const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
    const globRegex =
      input.glob !== undefined ? globToRegExp(input.glob) : undefined;

    const matches: GrepMatch[] = [];
    let truncated = false;

    const searchFile = async (absoluteFile: string): Promise<void> => {
      const relFromWorkspace = toWorkspaceRelative(
        context.workspacePath,
        absoluteFile,
      );
      if (globRegex !== undefined) {
        const relFromRoot = toWorkspaceRelative(root, absoluteFile);
        const base = basename(absoluteFile);
        const isMatch =
          globRegex.test(relFromRoot) ||
          globRegex.test(relFromWorkspace) ||
          globRegex.test(base);
        if (!isMatch) return;
      }

      let buf: Buffer;
      try {
        buf = await readFile(absoluteFile);
      } catch {
        return;
      }
      if (looksBinary(buf)) return;

      const text = buf.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }
        const line = lines[i] as string;
        if (regex.test(line)) {
          const capped =
            line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line;
          matches.push({ file: relFromWorkspace, line: i + 1, text: capped });
        }
      }
    };

    const safeReaddir = async (dir: string): Promise<Dirent[]> => {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };

    const walk = async (dir: string): Promise<void> => {
      checkAbort(context.signal);
      if (matches.length >= maxMatches) {
        truncated = true;
        return;
      }
      const entries = await safeReaddir(dir);
      for (const entry of entries) {
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }
        checkAbort(context.signal);
        if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          await searchFile(full);
        }
      }
    };

    const rootStat = await stat(root);
    if (rootStat.isDirectory()) {
      await walk(root);
    } else {
      await searchFile(root);
    }

    return { matches, truncated };
  }
}
