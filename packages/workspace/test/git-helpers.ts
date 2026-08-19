import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Root for throwaway repositories. `AGENT_TEST_TMPDIR` lets sandboxed runs point
 * the fixtures at a writable scratch directory.
 */
const TEST_TMP_ROOT = process.env.AGENT_TEST_TMPDIR || tmpdir();

const created: string[] = [];

/** Git env with all user/system configuration disabled, plus a fixed identity. */
export function fixtureEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
  };
}

/** Runs git in `cwd` with fixture configuration; throws on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: fixtureEnv(cwd),
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

/** Runs git in `cwd` and returns the exit code instead of throwing. */
export async function gitStatus(
  cwd: string,
  ...args: string[]
): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd, env: fixtureEnv(cwd) });
    return 0;
  } catch (error) {
    const code = (error as { code?: number }).code;
    return typeof code === "number" ? code : 1;
  }
}

/** Creates a temp directory registered for cleanup by {@link cleanupTempDirs}. */
export async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`));
  created.push(dir);
  return dir;
}

/** Creates a temp git repo on `main` with one commit and no user config. */
export async function makeRepo(prefix = "wt-repo"): Promise<string> {
  const dir = await makeTempDir(prefix);
  await git(dir, "init", "-b", "main");
  await writeFile(join(dir, "README.md"), "base\n", "utf8");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "initial");
  return dir;
}

export async function writeIn(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
