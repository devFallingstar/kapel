import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolContext, ToolDefinition } from "@agent/core";
import { toInputSchema } from "./json-schema.js";
import { checkAbort, resolveInWorkspace } from "./paths.js";

const InputSchema = z
  .object({
    path: z.string().min(1).describe("Workspace-relative path of the file to edit."),
    oldText: z.string().min(1).describe("Exact, non-empty text to find in the file."),
    newText: z.string().describe("Text to replace `oldText` with. Must differ from oldText."),
    replaceAll: z
      .boolean()
      .optional()
      .describe(
        "If true, replace every occurrence of oldText. If false/omitted, oldText must occur " +
          "exactly once in the file.",
      ),
  })
  .strict();

export type EditFileInput = z.infer<typeof InputSchema>;

export interface EditFileOutput {
  readonly path: string;
  readonly replacements: number;
}

export class EditFileTool implements Tool<EditFileInput, EditFileOutput> {
  readonly name = "edit_file";
  readonly description =
    "Performs an exact text replacement within a workspace file. `oldText` must match exactly " +
    "and, unless `replaceAll` is set, must occur exactly once in the file; otherwise the tool " +
    "throws an error describing how many occurrences were found.";
  readonly inputSchema = toInputSchema(InputSchema);

  definition(): ToolDefinition {
    return { name: this.name, description: this.description, inputSchema: this.inputSchema };
  }

  async execute(rawInput: unknown, context: ToolContext): Promise<EditFileOutput> {
    const input = InputSchema.parse(rawInput);
    if (input.oldText === input.newText) {
      throw new Error("oldText and newText must differ");
    }

    const target = resolveInWorkspace(context.workspacePath, input.path);
    checkAbort(context.signal);

    let raw: string;
    try {
      raw = await readFile(target, "utf8");
    } catch (err) {
      throw new Error(`failed to read file "${input.path}": ${(err as Error).message}`);
    }

    const occurrences = raw.split(input.oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldText not found in "${input.path}"`);
    }
    if (!input.replaceAll && occurrences > 1) {
      throw new Error(
        `oldText occurs ${occurrences} times in "${input.path}"; pass replaceAll: true to ` +
          "replace all occurrences, or provide more surrounding context to make oldText unique",
      );
    }

    const replacements = input.replaceAll ? occurrences : 1;
    const newContent = input.replaceAll
      ? raw.split(input.oldText).join(input.newText)
      : raw.replace(input.oldText, input.newText);

    checkAbort(context.signal);
    await writeFile(target, newContent, "utf8");

    return { path: input.path, replacements };
  }
}
