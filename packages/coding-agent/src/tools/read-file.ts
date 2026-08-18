import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolDefinition } from "@agent/core";
import { toInputSchema } from "./json-schema.js";
import { checkAbort, resolveInWorkspace } from "./paths.js";

const MAX_CONTENT_CHARS = 200_000;

const InputSchema = z
  .object({
    path: z.string().min(1).describe("Workspace-relative path of the file to read."),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line number to start reading from. Defaults to the first line."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
  })
  .strict();

export type ReadFileInput = z.infer<typeof InputSchema>;

export interface ReadFileOutput {
  readonly path: string;
  readonly content: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export class ReadFileTool implements Tool<ReadFileInput, ReadFileOutput> {
  readonly name = "read_file";
  readonly description =
    "Reads a UTF-8 text file from the workspace. The path must be workspace-relative. " +
    "Optionally supply a 1-based `offset` line and a `limit` on the number of lines returned. " +
    "Content is capped at 200,000 characters; if the result is cut short, `truncated` is true.";
  readonly inputSchema = toInputSchema(InputSchema);

  definition(): ToolDefinition {
    return { name: this.name, description: this.description, inputSchema: this.inputSchema };
  }

  async execute(rawInput: unknown, context: ToolContext): Promise<ReadFileOutput> {
    const input = InputSchema.parse(rawInput);
    const target = resolveInWorkspace(context.workspacePath, input.path);
    checkAbort(context.signal);

    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (err) {
      throw new Error(`failed to read file "${input.path}": ${(err as Error).message}`);
    }
    checkAbort(context.signal);

    const lines = raw.length === 0 ? [] : raw.split("\n");
    if (lines.length > 0 && raw.endsWith("\n")) {
      lines.pop();
    }
    const totalLines = lines.length;

    const startIndex = input.offset !== undefined ? Math.max(0, input.offset - 1) : 0;
    const endIndex = input.limit !== undefined ? startIndex + input.limit : lines.length;
    const selected = lines.slice(startIndex, endIndex);

    let content = selected.join("\n");
    let truncated = false;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }

    return { path: input.path, content, totalLines, truncated };
  }
}
