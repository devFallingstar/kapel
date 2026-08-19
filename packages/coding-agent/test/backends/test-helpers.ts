import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, EventSink } from "@agent/protocol";

// Session-provided scratch dir when set (keeps CI and local machines on
// the OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

/** Creates a fresh temp directory under the session scratchpad. */
export async function makeTempDir(prefix = "codex-test-"): Promise<string> {
  return mkdtemp(join(SCRATCHPAD, prefix));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface FakeCodexSpec {
  /** JSONL (or garbage) lines written verbatim to stdout, in order. */
  readonly stdout?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
  /** Seconds to sleep after writing stdout, to simulate a long run. */
  readonly sleepSeconds?: number;
  /** When set, the fake writes its own pid to this path before sleeping. */
  readonly pidFile?: string;
  /**
   * When set, the fake writes its argv to this path, NUL-separated so that
   * multi-line arguments (the prompt) survive the round trip.
   */
  readonly argvFile?: string;
  /** Fully custom shell body; when set, everything above is ignored. */
  readonly body?: string;
}

/**
 * Writes an executable bash script that impersonates the `codex` CLI.
 * Returns the absolute path to the fake binary.
 */
export async function writeFakeCodex(
  dir: string,
  spec: FakeCodexSpec = {},
  name = "codex",
): Promise<string> {
  const binaryPath = join(dir, name);

  let body = spec.body;
  if (body === undefined) {
    const lines: string[] = [];
    if (spec.argvFile !== undefined) {
      lines.push(`printf '%s\\0' "$@" > ${spec.argvFile}`);
    }
    if (spec.pidFile !== undefined) {
      lines.push(`echo $$ > ${spec.pidFile}`);
    }
    if (spec.stdout !== undefined && spec.stdout.length > 0) {
      const stdoutPath = join(dir, `${name}.stdout.txt`);
      await writeFile(stdoutPath, `${spec.stdout.join("\n")}\n`, "utf8");
      lines.push(`cat ${stdoutPath}`);
    }
    if (spec.stderr !== undefined) {
      const stderrPath = join(dir, `${name}.stderr.txt`);
      await writeFile(stderrPath, spec.stderr, "utf8");
      lines.push(`cat ${stderrPath} >&2`);
    }
    if (spec.sleepSeconds !== undefined) {
      lines.push(`sleep ${String(spec.sleepSeconds)}`);
    }
    lines.push(`exit ${String(spec.exitCode ?? 0)}`);
    body = lines.join("\n");
  }

  await writeFile(binaryPath, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

/** Collects every event the backend forwards, preserving order. */
export class RecordingSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

/** True once the given pid no longer exists. */
export function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function waitForExit(
  pid: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isGone(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
