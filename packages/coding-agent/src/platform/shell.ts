import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";

/**
 * Platform-aware process plumbing shared by the bash tool, the validator
 * runner, and the subprocess backends/executors.
 *
 * On POSIX the runtime shells out through `bash -lc` and spawns children
 * detached so each leads its own process group, which lets a timeout or
 * cancellation kill the whole tree with `process.kill(-pid)`. Neither
 * mechanism exists on Windows: commands go through `cmd.exe /d /s /c`,
 * children are spawned attached (a detached console child would flash a
 * window and outlive its group), and tree termination goes through
 * `taskkill /T /F`.
 */

export interface ShellInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/** The argv used to run a user-supplied command string through the platform shell. */
export function shellInvocationFor(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { command: "bash", args: ["-lc", command] };
}

export interface DetachedSpawnOptions {
  readonly detached: boolean;
  readonly windowsHide: boolean;
}

/** Spawn options that make {@link killProcessTree} able to reap the whole tree. */
export function detachedSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): DetachedSpawnOptions {
  if (platform === "win32") {
    return { detached: false, windowsHide: true };
  }
  return { detached: true, windowsHide: true };
}

export type TaskkillRunner = (pid: number) => void;

const defaultTaskkill: TaskkillRunner = (pid) => {
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
    // Best-effort: the process may already be gone.
  });
};

/**
 * Terminates a child process and its descendants.
 *
 * POSIX: signals the child's process group (requires the child to have been
 * spawned with {@link detachedSpawnOptions}), falling back to signalling the
 * child alone when the group is already gone. Callers keep their existing
 * SIGTERM-then-SIGKILL grace dance by calling this twice.
 *
 * Windows: `taskkill /T /F` reaps the tree in one forceful pass (Windows has
 * no graceful console signal), so the second SIGKILL call becomes a no-op
 * against an already-dead pid. Falls back to `child.kill()` if taskkill
 * itself cannot run.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  taskkill: TaskkillRunner = defaultTaskkill,
): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (platform === "win32") {
    try {
      taskkill(pid);
    } catch {
      try {
        child.kill();
      } catch {
        // The process is already gone.
      }
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

/**
 * Candidate executable names to try in order when spawning a binary by bare
 * name. npm-installed CLIs on Windows are `.cmd` shims, which
 * `spawn(..., {shell: false})` cannot execute under their bare name — the
 * spawn fails with ENOENT and the caller should retry the next candidate.
 */
export function executableCandidates(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "win32") return [binary];
  const base = binary.split(/[\\/]/).pop() ?? binary;
  if (base.includes(".")) return [binary];
  return [binary, `${binary}.cmd`, `${binary}.exe`];
}
