import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a user-supplied, workspace-relative path against the tool's workspace root and
 * guarantees the result stays inside that workspace. Throws if the path would escape the
 * workspace (via "../" segments or by being absolute to another location).
 */
export function resolveInWorkspace(
  workspacePath: string,
  userPath: string,
): string {
  const resolved = resolve(workspacePath, userPath);
  const rel = relative(workspacePath, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new Error(`path escapes workspace: ${userPath}`);
  }
  return resolved;
}

/**
 * Converts an absolute path known to live inside the workspace back into a workspace-relative,
 * forward-slash-separated path suitable for returning to callers.
 */
export function toWorkspaceRelative(
  workspacePath: string,
  absolutePath: string,
): string {
  const rel = relative(workspacePath, absolutePath);
  return rel.split(sep).join("/");
}

/**
 * Throws the abort signal's reason (or a generic error) if the signal has already fired.
 * Call periodically inside loops that walk the filesystem so long-running tool calls can be
 * cancelled promptly.
 */
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
}
