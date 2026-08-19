import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Large enough to hold full unified diffs of sizeable task changes. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Longest sanitized run/task segment kept in a branch name. */
const MAX_SEGMENT_LENGTH = 100;

export interface WorktreeErrorInit {
  readonly operation: string;
  readonly message: string;
  readonly stderr?: string | undefined;
  readonly cause?: unknown;
}

/** Raised when a git invocation (or an input to one) fails during worktree management. */
export class WorktreeError extends Error {
  readonly operation: string;
  readonly stderr?: string | undefined;

  constructor(init: WorktreeErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "WorktreeError";
    this.operation = init.operation;
    this.stderr = init.stderr;
  }
}

export interface GitExecOptions {
  readonly cwd: string;
  /** Label used in {@link WorktreeError.operation} when the command fails. */
  readonly operation: string;
  readonly signal?: AbortSignal | undefined;
  /** Full environment for the child process; defaults to the parent environment. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return error.name === "AbortError" || code === "ABORT_ERR";
}

/**
 * Runs `git` with `execFile` (never a shell) and returns the result even when the
 * command exits non-zero. Aborts propagate as the original `AbortError`.
 */
export async function tryGit(
  args: readonly string[],
  options: GitExecOptions,
): Promise<GitExecResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      signal: options.signal,
      env: options.env,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const value = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    if (typeof value.code !== "number") {
      // Spawn-level failure (git missing, cwd gone, ...) — no exit status at all.
      throw new WorktreeError({
        operation: options.operation,
        message: `git ${args.join(" ")} could not be executed: ${String(error)}`,
        stderr: value.stderr ?? undefined,
        cause: error,
      });
    }
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      exitCode: value.code,
    };
  }
}

/** Like {@link tryGit} but throws a {@link WorktreeError} when git exits non-zero. */
export async function runGit(
  args: readonly string[],
  options: GitExecOptions,
): Promise<GitExecResult> {
  const result = await tryGit(args, options);
  if (result.exitCode !== 0) {
    throw new WorktreeError({
      operation: options.operation,
      message: `git ${args.join(" ")} failed with exit code ${result.exitCode}`,
      stderr: result.stderr.trim() || undefined,
    });
  }
  return result;
}

/**
 * Reduces an arbitrary identifier to a git-ref-safe path segment: only
 * `[A-Za-z0-9._-]` survives, runs of replacements collapse, and leading/trailing
 * separators plus a trailing `.lock` are trimmed. Throws when nothing is left.
 */
export function sanitizeWorktreeSegment(raw: string, label: string): string {
  let value = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  while (value.toLowerCase().endsWith(".lock")) {
    value = value.slice(0, -".lock".length).replace(/[-.]+$/, "");
  }
  if (value.length === 0) {
    throw new WorktreeError({
      operation: "sanitize",
      message: `cannot derive a branch-safe ${label} from ${JSON.stringify(raw)}`,
    });
  }
  return value;
}

/** Splits NUL-terminated git output into non-empty records. */
export function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** Splits newline-separated git output into trimmed, non-empty lines. */
export function splitLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface WorktreeListEntry {
  readonly path: string;
  readonly branch?: string | undefined;
}

/** Parses `git worktree list --porcelain` output. */
export function parseWorktreeList(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (path !== undefined) {
      entries.push({ path, branch });
    }
    path = undefined;
    branch = undefined;
  };
  for (const line of stdout.split("\n")) {
    const value = line.trimEnd();
    if (value.startsWith("worktree ")) {
      flush();
      path = value.slice("worktree ".length);
    } else if (value.startsWith("branch refs/heads/")) {
      branch = value.slice("branch refs/heads/".length);
    }
  }
  flush();
  return entries;
}

/** Resolves symlinks when the path exists, otherwise returns the absolute path. */
export async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}
