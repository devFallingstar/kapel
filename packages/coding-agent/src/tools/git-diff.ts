import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext } from "@agent/core";
import { z } from "zod";
import { toInputSchema } from "./json-schema.js";
import { resolveInWorkspace } from "./paths.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 200_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const InputSchema = z
  .object({
    staged: z
      .boolean()
      .optional()
      .describe(
        "If true, diff the staged (index) changes via `git diff --cached`.",
      ),
    path: z
      .string()
      .optional()
      .describe("Optional workspace-relative path to restrict the diff to."),
  })
  .strict();

export type GitDiffInput = z.infer<typeof InputSchema>;

export interface GitDiffOutput {
  readonly diff: string;
  readonly truncated: boolean;
}

export class GitDiffTool implements Tool<GitDiffInput, GitDiffOutput> {
  readonly name = "git_diff";
  readonly description =
    "Runs `git diff` in the workspace and returns the unified diff text. Set `staged` to diff " +
    "the index (`--cached`) instead of the working tree, and `path` (workspace-relative) to " +
    "restrict the diff to one file or directory. Output is capped at 200,000 characters.";
  readonly inputSchema = toInputSchema(InputSchema);

  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  async execute(
    rawInput: unknown,
    context: ToolContext,
  ): Promise<GitDiffOutput> {
    const input = InputSchema.parse(rawInput);

    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("aborted");
    }

    const args = ["diff"];
    if (input.staged) args.push("--cached");
    if (input.path !== undefined) {
      resolveInWorkspace(context.workspacePath, input.path);
      args.push("--", input.path);
    }

    let stdout: string;
    try {
      const result = await execFileAsync("git", args, {
        cwd: context.workspacePath,
        signal: context.signal,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
      });
      stdout = result.stdout;
    } catch (err) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("aborted");
      }
      throw new Error(`git diff failed: ${(err as Error).message}`);
    }

    let diff = stdout;
    let truncated = false;
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS);
      truncated = true;
    }

    return { diff, truncated };
  }
}
