import type { Tool } from "@agent/core";
import { BashTool } from "./bash.js";
import { EditFileTool } from "./edit-file.js";
import { GitDiffTool } from "./git-diff.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { ReadFileTool } from "./read-file.js";
import { WriteFileTool } from "./write-file.js";

export type { BashInput, BashOutput } from "./bash.js";
export { BashTool } from "./bash.js";
export type { EditFileInput, EditFileOutput } from "./edit-file.js";
export { EditFileTool } from "./edit-file.js";
export type { GitDiffInput, GitDiffOutput } from "./git-diff.js";
export { GitDiffTool } from "./git-diff.js";
export type { GlobInput, GlobOutput } from "./glob.js";
export { GlobTool } from "./glob.js";
export type { GrepInput, GrepMatch, GrepOutput } from "./grep.js";
export { GrepTool } from "./grep.js";
export {
  checkAbort,
  resolveInWorkspace,
  toWorkspaceRelative,
} from "./paths.js";
export type { ReadFileInput, ReadFileOutput } from "./read-file.js";
export { ReadFileTool } from "./read-file.js";
export type { WriteFileInput, WriteFileOutput } from "./write-file.js";
export { WriteFileTool } from "./write-file.js";

/**
 * Returns a fresh instance of every M1 built-in tool.
 */
export function builtinTools(): readonly Tool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new GlobTool(),
    new GrepTool(),
    new BashTool(),
    new GitDiffTool(),
  ];
}
