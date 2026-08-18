import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface Workspace {
  readonly root: string;
  exec(
    command: string,
    args?: readonly string[],
    signal?: AbortSignal,
  ): Promise<ExecResult>;
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
  dispose(): Promise<void>;
}

export class LocalWorkspace implements Workspace {
  constructor(readonly root: string) {}

  async exec(
    command: string,
    args: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd: this.root,
        signal,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const value = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      return {
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? String(error),
        exitCode: value.code ?? 1,
      };
    }
  }

  async read(relativePath: string): Promise<string> {
    return readFile(resolve(this.root, relativePath), "utf8");
  }

  async write(relativePath: string, content: string): Promise<void> {
    const path = resolve(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async dispose(): Promise<void> {}
}

export class GitWorktreeWorkspace extends LocalWorkspace {
  private constructor(
    root: string,
    private readonly repositoryRoot: string,
  ) {
    super(root);
  }

  static async create(
    repositoryRoot: string,
    worktreeRoot: string,
    branch: string,
  ): Promise<GitWorktreeWorkspace> {
    await mkdir(dirname(worktreeRoot), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", worktreeRoot, "-b", branch],
      { cwd: repositoryRoot },
    );
    return new GitWorktreeWorkspace(worktreeRoot, repositoryRoot);
  }

  override async dispose(): Promise<void> {
    await execFileAsync("git", ["worktree", "remove", "--force", this.root], {
      cwd: this.repositoryRoot,
    });
    await rm(this.root, { recursive: true, force: true });
  }
}
