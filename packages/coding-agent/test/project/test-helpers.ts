import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCRATCHPAD =
  "/tmp/claude-0/-home-user-multi-model-orchestration-agent/475a4108-ea0d-56a1-9770-14d838a0e5f8/scratchpad";

const TEMPLATE_AGENT_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "templates",
  "default",
  ".agent",
);

/** Creates a fresh temp directory under the session scratchpad to use as a workspace root. */
export async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(SCRATCHPAD, "project-test-"));
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

/** Copies the repo's `templates/default/.agent` fixture into `<workspacePath>/.agent`. */
export async function copyTemplateAgentDir(
  workspacePath: string,
): Promise<string> {
  const dest = join(workspacePath, ".agent");
  await cp(TEMPLATE_AGENT_DIR, dest, { recursive: true });
  return dest;
}

/** Writes `<workspacePath>/.agent/<relativePath>`, creating parent directories as needed. */
export async function writeAgentFile(
  workspacePath: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = join(workspacePath, ".agent", relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}
