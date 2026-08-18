import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext } from "@agent/core";

const SCRATCHPAD =
  "/tmp/claude-0/-home-user-multi-model-orchestration-agent/475a4108-ea0d-56a1-9770-14d838a0e5f8/scratchpad";

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
