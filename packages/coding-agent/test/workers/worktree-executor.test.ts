import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  RuntimeTask,
  TaskResult,
  WorkerExecutionContext,
  WorkerExecutor,
} from "@agent/orchestration";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceExecutorFactory } from "../../src/workers/worktree-executor.js";
import { WorktreeIsolatedExecutor } from "../../src/workers/worktree-executor.js";
import {
  cleanup,
  initGitRepo,
  makeRuntimeTask,
  makeTempDir,
  RecordingSink,
} from "./test-helpers.js";

const execFileAsync = promisify(execFile);

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => cleanup(dir)));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await tempDir("worktree-exec-repo-");
  await initGitRepo(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function branches(repo: string): Promise<string[]> {
  const listed = await git(repo, "for-each-ref", "--format=%(refname:short)");
  return listed.split("\n").filter((line) => line !== "");
}

/** A barrier that releases once `count` callers have reached it. */
class Barrier {
  #arrived = 0;
  #release!: () => void;
  readonly #open: Promise<void>;

  constructor(private readonly count: number) {
    this.#open = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  async arrive(): Promise<void> {
    this.#arrived += 1;
    if (this.#arrived >= this.count) this.#release();
    await this.#open;
  }
}

interface InnerCall {
  readonly workspacePath: string;
  readonly taskId: string;
  readonly context: WorkerExecutionContext | undefined;
  readonly signal: AbortSignal | undefined;
}

interface InnerSpec {
  /** Files written into whatever workspace the executor is handed, per task id. */
  readonly writes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly status?: TaskResult["status"];
  readonly barrier?: Barrier;
  readonly throws?: boolean;
  /** What `describeAgent` reports for every agent name, when set. */
  readonly model?: string;
}

interface Inner {
  readonly factory: WorkspaceExecutorFactory;
  readonly calls: InnerCall[];
}

/**
 * An inner executor that edits whichever workspace it was built for.
 *
 * That is the whole point of the fake: the decorator decides where the task
 * runs, so the only way to see isolation working is to write files relative to
 * the path the factory received and then look for them elsewhere.
 */
function makeInner(spec: InnerSpec = {}): Inner {
  const calls: InnerCall[] = [];

  const factory: WorkspaceExecutorFactory = (workspacePath) => {
    const executor: WorkerExecutor = {
      describeAgent(_agent) {
        return spec.model === undefined ? undefined : { model: spec.model };
      },
      async execute(task, _agent, signal, context) {
        const taskId = task.spec.id;
        calls.push({ workspacePath, taskId, context, signal });
        if (spec.barrier !== undefined) await spec.barrier.arrive();
        if (spec.throws === true) throw new Error("inner executor exploded");

        for (const [file, content] of Object.entries(
          spec.writes?.[taskId] ?? {},
        )) {
          const target = join(workspacePath, file);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
        }

        return {
          taskId,
          status: spec.status ?? "success",
          summary: `${taskId} ran in ${workspacePath}`,
          decisions: [],
          changedFiles: ["reported-by-inner.txt"],
          commit: "inner-commit",
          tests: { passed: 0, failed: 0, commands: [] },
          unresolvedIssues: [],
          confidence: 0.8,
        };
      },
    };
    return executor;
  };

  return { factory, calls };
}

function taskOf(id: string, type: RuntimeTask["spec"]["type"]): RuntimeTask {
  return makeRuntimeTask({ id, type, title: `Task ${id}` });
}

function makeExecutor(
  repoRoot: string,
  inner: Inner,
  events?: RecordingSink,
): WorktreeIsolatedExecutor {
  return new WorktreeIsolatedExecutor({
    repoRoot,
    createExecutor: inner.factory,
    runId: "run-1",
    ...(events === undefined ? {} : { events }),
  });
}

describe("WorktreeIsolatedExecutor / mutating tasks", () => {
  it("runs the task in its own checkout and merges the result into the base", async () => {
    const repo = await makeRepo();
    const inner = makeInner({ writes: { T01: { "feature.txt": "added\n" } } });
    const events = new RecordingSink();

    const result = await makeExecutor(repo, inner, events).execute(
      taskOf("T01", "implementation"),
      "coder",
    );

    // The worker never saw the repository itself.
    const workspacePath = inner.calls[0]?.workspacePath ?? "";
    expect(workspacePath).not.toBe(repo);
    expect(workspacePath).toContain(
      join(".agent", "worktrees", "run-1", "T01"),
    );

    // ...and yet the change landed on the base branch.
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("added\n");
    expect(result.status).toBe("success");
    expect(result.changedFiles).toEqual(["feature.txt"]);
    expect(result.commit).toBe(await git(repo, "rev-parse", "HEAD"));
    expect(result.unresolvedIssues).toEqual([]);

    // Nothing is left behind: no checkout, no task branch.
    expect(await exists(join(workspacePath, "feature.txt"))).toBe(false);
    expect(await branches(repo)).toEqual(["main"]);
    expect(await git(repo, "status", "--porcelain")).toBe("");

    expect(events.types()).toEqual([
      "worktree.created",
      "worktree.integrated",
      "worktree.removed",
    ]);
    expect(events.events[0]?.data).toMatchObject({
      taskId: "T01",
      branch: "agent-task/run-1/T01",
      path: workspacePath,
    });
    expect(events.events[1]?.data).toMatchObject({
      merged: true,
      commit: result.commit,
    });
    expect(events.events[2]?.data).toMatchObject({ keptBranch: false });
  });

  it("merges two concurrent tasks that touch different files", async () => {
    const repo = await makeRepo();
    // Both workers are held until the other has started, so the two checkouts
    // provably exist at the same time and both branch off the same base.
    const barrier = new Barrier(2);
    const inner = makeInner({
      barrier,
      writes: { T01: { "one.txt": "one\n" }, T02: { "two.txt": "two\n" } },
    });
    const executor = makeExecutor(repo, inner);

    const [first, second] = await Promise.all([
      executor.execute(taskOf("T01", "implementation"), "coder"),
      executor.execute(taskOf("T02", "testing"), "tester"),
    ]);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(new Set(inner.calls.map((call) => call.workspacePath)).size).toBe(2);
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(repo, "two.txt"), "utf8")).toBe("two\n");
    expect(await branches(repo)).toEqual(["main"]);
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("reports a conflicting task as partial and preserves its branch", async () => {
    const repo = await makeRepo();
    const barrier = new Barrier(2);
    const inner = makeInner({
      barrier,
      writes: {
        T01: { "shared.txt": "from T01\n" },
        T02: { "shared.txt": "from T02\n" },
      },
    });
    const executor = makeExecutor(repo, inner);

    const results = await Promise.all([
      executor.execute(taskOf("T01", "implementation"), "coder"),
      executor.execute(taskOf("T02", "implementation"), "coder"),
    ]);

    // One task wins the merge race; the other cannot be merged on top of it.
    const merged = results.filter((result) => result.status === "success");
    const conflicted = results.filter((result) => result.status === "partial");
    expect(merged).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const loser = conflicted[0];
    const branch = `agent-task/run-1/${loser?.taskId}`;
    expect(loser?.unresolvedIssues.join("\n")).toContain(
      "merge conflict with base in: shared.txt",
    );
    expect(loser?.unresolvedIssues.join("\n")).toContain(branch);
    expect(loser?.changedFiles).toEqual(["shared.txt"]);

    // The branch survives for a human to resolve, and the base is left clean —
    // no merge in progress, no conflict markers.
    expect(await branches(repo)).toContain(branch);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    const content = await readFile(join(repo, "shared.txt"), "utf8");
    expect(content).toBe(`from ${merged[0]?.taskId}\n`);
    expect(content).not.toContain("<<<<<<<");
  });

  it("merges even though kapel's own .agent state is untracked in the base", async () => {
    const repo = await makeRepo();
    // What `kapel init` plus a REPL session leave behind before any task runs.
    await mkdir(join(repo, ".agent"), { recursive: true });
    await writeFile(join(repo, ".agent", "sessions.db"), "sqlite\n");
    await writeFile(join(repo, ".agent", "sessions.db-wal"), "wal\n");
    const inner = makeInner({ writes: { T01: { "feature.txt": "added\n" } } });
    const events = new RecordingSink();

    const result = await makeExecutor(repo, inner, events).execute(
      taskOf("T01", "implementation"),
      "coder",
    );

    expect(result.status).toBe("success");
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("added\n");
    expect(events.events[1]?.data).toMatchObject({ merged: true });
  });

  it("names the dirty paths on the not-merged event so the REPL can show them", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "half-finished.ts"), "wip\n");
    const inner = makeInner({ writes: { T01: { "feature.txt": "added\n" } } });
    const events = new RecordingSink();

    const result = await makeExecutor(repo, inner, events).execute(
      taskOf("T01", "implementation"),
      "coder",
    );

    expect(result.status).toBe("partial");
    expect(events.events[1]?.data).toMatchObject({
      merged: false,
      reason: "dirty-base",
    });
    const notMerged = events.events[1]?.data as { detail?: string } | undefined;
    expect(notMerged?.detail).toContain("half-finished.ts");
  });

  it("keeps a failed task's edits on its branch instead of merging them", async () => {
    const repo = await makeRepo();
    const inner = makeInner({
      status: "failed",
      writes: { T01: { "half-done.txt": "wip\n" } },
    });
    const events = new RecordingSink();

    const result = await makeExecutor(repo, inner, events).execute(
      taskOf("T01", "implementation"),
      "coder",
    );

    expect(result.status).toBe("failed");
    expect(result.changedFiles).toEqual(["half-done.txt"]);
    expect(result.commit).toBeDefined();
    expect(result.unresolvedIssues.join("\n")).toContain(
      "agent-task/run-1/T01",
    );

    expect(await exists(join(repo, "half-done.txt"))).toBe(false);
    expect(await branches(repo)).toContain("agent-task/run-1/T01");
    expect(events.types()).toEqual(["worktree.created", "worktree.removed"]);
    expect(events.events[1]?.data).toMatchObject({ keptBranch: true });
  });

  it("removes the checkout and the branch when the task changed nothing", async () => {
    const repo = await makeRepo();
    const inner = makeInner();

    const result = await makeExecutor(repo, inner).execute(
      taskOf("T01", "documentation"),
      "writer",
    );

    expect(result.status).toBe("success");
    expect(result.changedFiles).toEqual([]);
    expect("commit" in result).toBe(false);
    expect(await branches(repo)).toEqual(["main"]);
  });

  it("reports an unusable repository as a failed result, not a rejection", async () => {
    const notARepo = await tempDir("worktree-exec-bare-");
    const inner = makeInner({ writes: { T01: { "a.txt": "a\n" } } });
    const events = new RecordingSink();

    const result = await makeExecutor(notARepo, inner, events).execute(
      taskOf("T01", "implementation"),
      "coder",
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Could not create an isolated worktree");
    expect(result.summary).toContain("not a git repository");
    expect(inner.calls).toEqual([]);
    expect(events.types()).toEqual([]);
  });

  it("turns an inner executor that throws into a failed result", async () => {
    const repo = await makeRepo();
    const inner = makeInner({ throws: true });

    const result = await makeExecutor(repo, inner).execute(
      taskOf("T01", "implementation"),
      "coder",
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("inner executor exploded");
    // The failed attempt still cleaned up after itself.
    expect(await branches(repo)).toEqual(["main"]);
  });
});

describe("WorktreeIsolatedExecutor / read-only tasks", () => {
  it("runs exploration and review in the repository itself, with no worktree", async () => {
    const repo = await makeRepo();
    const inner = makeInner();
    const events = new RecordingSink();
    const executor = makeExecutor(repo, inner, events);

    const explored = await executor.execute(
      taskOf("T01", "exploration"),
      "explorer",
    );
    await executor.execute(taskOf("T02", "review"), "reviewer");

    expect(inner.calls.map((call) => call.workspacePath)).toEqual([repo, repo]);
    expect(events.types()).toEqual([]);
    // The inner result is passed through untouched.
    expect(explored.changedFiles).toEqual(["reported-by-inner.txt"]);
    expect(explored.commit).toBe("inner-commit");
    expect(await branches(repo)).toEqual(["main"]);
  });

  it("passes the signal and dependency context through both paths", async () => {
    const repo = await makeRepo();
    const inner = makeInner();
    const executor = makeExecutor(repo, inner);
    const controller = new AbortController();
    const context: WorkerExecutionContext = {
      dependencyResults: [
        {
          taskId: "T00",
          status: "success",
          summary: "did the groundwork",
          decisions: [],
          changedFiles: ["src/a.ts"],
          tests: { passed: 0, failed: 0, commands: [] },
          unresolvedIssues: [],
          confidence: 0.8,
        },
      ],
    };

    await executor.execute(
      taskOf("T01", "exploration"),
      "explorer",
      controller.signal,
      context,
    );
    await executor.execute(
      taskOf("T02", "implementation"),
      "coder",
      controller.signal,
      context,
    );

    for (const call of inner.calls) {
      expect(call.signal).toBe(controller.signal);
      expect(call.context).toBe(context);
    }
  });
});

describe("WorktreeIsolatedExecutor / describeAgent", () => {
  it("forwards to a throwaway inner executor rooted at repoRoot", async () => {
    const repo = await makeRepo();
    const inner = makeInner({ model: "claude-haiku-4-5" });
    const executor = makeExecutor(repo, inner);

    expect(executor.describeAgent("coder")).toEqual({
      model: "claude-haiku-4-5",
    });
    // Asking does not run anything.
    expect(inner.calls).toEqual([]);
  });

  it("reports nothing when the inner executor has nothing to say", async () => {
    const repo = await makeRepo();
    const executor = makeExecutor(repo, makeInner());
    expect(executor.describeAgent("coder")).toBeUndefined();
  });
});
