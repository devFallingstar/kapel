import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext } from "@agent/core";
import { z } from "zod";
import { toInputSchema } from "./json-schema.js";
import { checkAbort, resolveInWorkspace } from "./paths.js";

const InputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Workspace-relative path of the file to write."),
    content: z
      .string()
      .describe("The full UTF-8 text content to write to the file."),
  })
  .strict();

export type WriteFileInput = z.infer<typeof InputSchema>;

export interface WriteFileOutput {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
}

export class WriteFileTool implements Tool<WriteFileInput, WriteFileOutput> {
  readonly name = "write_file";
  readonly description =
    "Writes UTF-8 text content to a file in the workspace, overwriting it if it already exists. " +
    "The path must be workspace-relative; parent directories are created automatically.";
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
  ): Promise<WriteFileOutput> {
    const input = InputSchema.parse(rawInput);
    const target = resolveInWorkspace(context.workspacePath, input.path);
    checkAbort(context.signal);

    let created = true;
    try {
      await stat(target);
      created = false;
    } catch {
      created = true;
    }

    await mkdir(dirname(target), { recursive: true });
    checkAbort(context.signal);
    await writeFile(target, input.content, "utf8");

    const bytesWritten = Buffer.byteLength(input.content, "utf8");
    return { path: input.path, bytesWritten, created };
  }
}
