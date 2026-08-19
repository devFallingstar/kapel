import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentRunResult } from "@agent/core";
import type { TaskResult } from "@agent/orchestration";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Confidence attached to a normalized result, keyed by loop status. */
const CONFIDENCE: Readonly<Record<AgentRunResult["status"], number>> = {
  success: 0.8,
  partial: 0.4,
  failed: 0.1,
};

/** What the workspace looked like after a worker finished. */
export interface WorkspaceInspection {
  readonly changedFiles: readonly string[];
  readonly commit?: string;
}

const EMPTY_INSPECTION: WorkspaceInspection = { changedFiles: [] };

function runGit(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  return execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    ...(signal === undefined ? {} : { signal }),
  })
    .then((result) => result.stdout)
    .catch(() => undefined);
}

/**
 * Parses `git status --porcelain=v1 -z` output.
 *
 * Records are NUL-terminated `XY <path>` entries. Rename/copy entries are
 * followed by an extra NUL-terminated field holding the *original* path; we
 * consume it and report only the destination, which is the path that now
 * differs from HEAD.
 */
function parsePorcelain(stdout: string): readonly string[] {
  const records = stdout.split("\0");
  const paths = new Set<string>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;

    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const path = record.slice(3);
    if (path !== "") paths.add(path);
    // A rename/copy carries its source path in the following record.
    if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
  }

  return [...paths].sort();
}

/**
 * Reports the files a worker touched in `workspacePath` and the commit the
 * workspace currently points at.
 *
 * Never throws: a missing `git`, a directory that is not a repository, a
 * repository with no commits, or an aborted signal all degrade to an empty
 * inspection. Untracked files are included (`-uall`) because a worker that
 * creates new files has changed the workspace just as much as one that edits
 * existing ones.
 */
export async function inspectWorkspaceChanges(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceInspection> {
  const status = await runGit(
    ["status", "--porcelain=v1", "-z", "-uall"],
    workspacePath,
    signal,
  );
  if (status === undefined) return EMPTY_INSPECTION;

  const changedFiles = parsePorcelain(status);
  const head = await runGit(["rev-parse", "HEAD"], workspacePath, signal);
  const commit = head?.trim();

  return {
    changedFiles,
    ...(commit === undefined || commit === "" ? {} : { commit }),
  };
}

/** The subset of an agent/backend run result normalization depends on. */
export type NormalizableRun = Pick<
  AgentRunResult,
  "status" | "summary" | "output"
>;

export interface NormalizeTaskResultInput {
  readonly taskId: string;
  readonly loop: NormalizableRun;
  readonly inspection: WorkspaceInspection;
}

/** Prefers the run summary, falling back to its final output text. */
function pickSummary(loop: NormalizableRun): string {
  if (loop.summary.trim() !== "") return loop.summary;
  const output = loop.output;
  if (output !== undefined && output.trim() !== "") return output;
  return "The worker returned no summary.";
}

/**
 * Folds a worker run plus a workspace inspection into the orchestration
 * {@link TaskResult} shape.
 *
 * `decisions`, `unresolvedIssues` and `tests` stay empty: extracting them
 * requires structured worker output, which lands in a later milestone. The
 * confidence score is a fixed per-status heuristic for the same reason.
 */
export function normalizeTaskResult(
  input: NormalizeTaskResultInput,
): TaskResult {
  const { taskId, loop, inspection } = input;

  return {
    taskId,
    status: loop.status,
    summary: pickSummary(loop),
    decisions: [],
    changedFiles: inspection.changedFiles,
    ...(inspection.commit === undefined ? {} : { commit: inspection.commit }),
    tests: { passed: 0, failed: 0, commands: [] },
    unresolvedIssues: [],
    confidence: CONFIDENCE[loop.status],
  };
}

/** Builds a `failed` {@link TaskResult} that reports why a worker never ran. */
export function failedTaskResult(
  taskId: string,
  summary: string,
  inspection: WorkspaceInspection = EMPTY_INSPECTION,
): TaskResult {
  return normalizeTaskResult({
    taskId,
    loop: { status: "failed", summary },
    inspection,
  });
}
