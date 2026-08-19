import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@agent/core";

// Session-provided scratch dir when set (keeps CI and local machines on
// the OS temp dir).
const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

/** Creates a fresh temp directory under the session scratchpad to use as a workspace root. */
export async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(SCRATCHPAD, "tools-test-"));
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

export function makeContext(
  workspacePath: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    runId: "test-run",
    workspacePath,
    signal: new AbortController().signal,
    ...overrides,
  };
}
