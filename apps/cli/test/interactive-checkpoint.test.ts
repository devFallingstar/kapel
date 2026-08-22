import type { ModelMessage } from "@agent/ai";
import type { ChatTurnResult } from "@agent/coding-agent";
import { describe, expect, it } from "vitest";
import type {
  CheckpointEntry,
  CheckpointStore,
  DiffResult,
  ShortStat,
  UndoOutcome,
} from "../src/checkpoint.js";
import type {
  InteractiveController,
  InteractiveControllerDeps,
  InteractiveSession,
} from "../src/interactive.js";
import {
  createInteractiveController,
  slashCompleter,
} from "../src/interactive.js";
import type { Styles } from "../src/styles.js";
import { createStyles } from "../src/styles.js";

/**
 * The interactive half of `/undo`, driven with a stand-in checkpoint store.
 *
 * `checkpoint.test.ts` owns the git plumbing against real repositories; what
 * is worth proving here is only the wiring — that a checkpoint is taken for
 * exactly the lines that start a turn, and that `/undo` reports whatever the
 * store hands back.
 */

class FakeSession implements InteractiveSession {
  readonly sends: string[] = [];
  readonly #messages: ModelMessage[] = [];

  async send(instruction: string): Promise<ChatTurnResult> {
    this.sends.push(instruction);
    this.#messages.push({ role: "user", content: instruction });
    this.#messages.push({ role: "assistant", content: `ok: ${instruction}` });
    return {
      status: "success",
      summary: `handled ${instruction}`,
      iterations: 1,
      toolCalls: 0,
    };
  }

  messages(): readonly ModelMessage[] {
    return this.#messages.slice();
  }
}

class FakeCheckpoints implements CheckpointStore {
  readonly captured: string[] = [];
  /** What the next `capture` reports back — a warning line, or nothing. */
  warning: string | undefined;
  outcome: UndoOutcome = {
    ok: true,
    restored: 2,
    label: "fix the tests",
    ageMs: 120_000,
  };
  undoCalls = 0;
  /** What `changeStat` reports for whatever tree it is asked about. */
  stat: ShortStat | undefined;
  /** What `diff` reports, regardless of `stepsBack`. */
  diffResult: DiffResult = {
    ok: false,
    reason:
      "nothing to diff — no checkpoint has been taken in this session yet.",
  };
  diffCalls: Array<{ stepsBack: number; color: boolean | undefined }> = [];

  readonly #stack: CheckpointEntry[] = [];
  #nextId = 0;

  async capture(prompt: string): Promise<string | undefined> {
    this.captured.push(prompt);
    // A warned capture mirrors the real store: nothing was actually
    // snapshotted, so nothing is pushed onto the stack either — which is
    // exactly what keeps `capturedTreeFor` from crediting this turn with a
    // baseline it never got.
    if (this.warning !== undefined) return this.warning;
    this.#nextId += 1;
    this.#stack.push({
      commit: `commit-${this.#nextId}`,
      tree: `tree-${this.#nextId}`,
      createdAt: 0,
      label: prompt,
    });
    return undefined;
  }

  async undo(): Promise<UndoOutcome> {
    this.undoCalls += 1;
    return this.outcome;
  }

  entries(): readonly CheckpointEntry[] {
    return this.#stack.slice();
  }

  async changeStat(_tree: string): Promise<ShortStat | undefined> {
    return this.stat;
  }

  async diff(
    stepsBack: number,
    options?: { readonly color?: boolean },
  ): Promise<DiffResult> {
    this.diffCalls.push({ stepsBack, color: options?.color });
    return this.diffResult;
  }
}

async function harness(
  checkpoints?: CheckpointStore,
  styles?: Styles,
): Promise<InteractiveController> {
  const deps: InteractiveControllerDeps = {
    workspacePath: "/workspace",
    createSession: () => new FakeSession(),
    write: () => {},
    modelAlias: "claude-sonnet-5",
    start: {
      sessionId: "11111111-aaaa-4aaa-8aaa-000000000001",
      title: "",
      persisted: false,
      messages: [],
    },
    usage: {
      totals: () => ({
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
      }),
    },
    ...(checkpoints === undefined ? {} : { checkpoints }),
    ...(styles === undefined ? {} : { styles }),
  };
  return await createInteractiveController(deps);
}

describe("interactive controller — checkpoints", () => {
  it("checkpoints the working tree before a prompt reaches the agent", async () => {
    const checkpoints = new FakeCheckpoints();
    const controller = await harness(checkpoints);

    await controller.handleLine("fix the failing test");
    await controller.handleLine("now run them");

    expect(checkpoints.captured).toEqual([
      "fix the failing test",
      "now run them",
    ]);
  });

  it("takes no checkpoint for a slash command or a blank line", async () => {
    const checkpoints = new FakeCheckpoints();
    const controller = await harness(checkpoints);

    await controller.handleLine("/help");
    await controller.handleLine("/usage");
    await controller.handleLine("   ");
    await controller.handleLine("/undo");

    expect(checkpoints.captured).toEqual([]);
  });

  it("reports a failed capture once, without stopping the turn", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.warning = "(checkpoint failed, /undo will not cover this turn)";
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("go");

    expect(result.output[0]).toBe(
      "(checkpoint failed, /undo will not cover this turn)",
    );
    expect((controller.session() as FakeSession).sends).toEqual(["go"]);
  });

  it("/undo prints what was restored and warns how wide the restore is", async () => {
    const checkpoints = new FakeCheckpoints();
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("/undo");

    expect(checkpoints.undoCalls).toBe(1);
    expect(result.output).toEqual([
      '↩ restored 2 files to before "fix the tests" (2 min ago)',
      expect.stringContaining("undo is one-way"),
    ]);
    expect(result.effect).toBeUndefined();
  });

  it("/undo passes a refusal through verbatim", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.outcome = {
      ok: false,
      reason: "nothing to undo — no checkpoint.",
    };
    const controller = await harness(checkpoints);

    expect((await controller.handleLine("/undo")).output).toEqual([
      "nothing to undo — no checkpoint.",
    ]);
  });

  it("/undo says it is unavailable when nothing can checkpoint", async () => {
    const controller = await harness();
    expect((await controller.handleLine("/undo")).output).toEqual([
      "/undo is not available here.",
    ]);
  });

  it("lists /undo in the help and completes it", async () => {
    const controller = await harness(new FakeCheckpoints());
    const help = await controller.handleLine("/help");
    expect(help.output.join("\n")).toContain("/undo");
    expect(slashCompleter("/un")).toEqual([["/undo"], "/un"]);
  });
});

describe("interactive controller — turn-end change summary", () => {
  it("prints a dim Δ line after a successful turn that changed files", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.stat = { filesChanged: 4, insertions: 52, deletions: 11 };
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("fix the failing test");

    expect(result.output).toContain("Δ 4 files +52 −11");
  });

  it("says nothing when the turn changed no files", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.stat = { filesChanged: 0, insertions: 0, deletions: 0 };
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("just a question");

    expect(result.output.some((line) => line.startsWith("Δ"))).toBe(false);
  });

  it("says nothing when checkpointing found no repository to diff", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.stat = undefined;
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("do something");

    expect(result.output.some((line) => line.startsWith("Δ"))).toBe(false);
  });

  it("says nothing when this turn's own checkpoint failed to capture", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.warning = "(checkpoint failed, /undo will not cover this turn)";
    checkpoints.stat = { filesChanged: 9, insertions: 9, deletions: 9 };
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("go");

    // The warning is printed, and nothing is falsely attributed to a
    // baseline this turn never actually got.
    expect(result.output).toContain(
      "(checkpoint failed, /undo will not cover this turn)",
    );
    expect(result.output.some((line) => line.startsWith("Δ"))).toBe(false);
  });

  it("says nothing when there is nothing to checkpoint at all", async () => {
    const controller = await harness();
    const result = await controller.handleLine("go");
    expect(result.output.some((line) => line.startsWith("Δ"))).toBe(false);
  });

  it("prints the change summary ahead of the usage line", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.stat = { filesChanged: 1, insertions: 3, deletions: 0 };
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("one more");

    const changeIndex = result.output.indexOf("Δ 1 file +3 −0");
    const usageIndex = result.output.findIndex((line) =>
      line.includes("tokens"),
    );
    expect(changeIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeGreaterThan(changeIndex);
  });
});

describe("interactive controller — /diff", () => {
  it("prints the checkpoint header and the diff itself", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.diffResult = {
      ok: true,
      label: "fix the tests",
      ageMs: 120_000,
      diff: "diff --git a/f.txt b/f.txt\n+added\n",
    };
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("/diff");

    expect(result.output).toEqual([
      'diff since "fix the tests" (2 min ago):',
      "diff --git a/f.txt b/f.txt",
      "+added",
    ]);
    expect(checkpoints.diffCalls).toEqual([{ stepsBack: 1, color: false }]);
  });

  it("passes n through as how many checkpoints back to diff", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.diffResult = {
      ok: true,
      label: "second to last",
      ageMs: 0,
      diff: "",
    };
    const controller = await harness(checkpoints);

    await controller.handleLine("/diff 2");

    expect(checkpoints.diffCalls).toEqual([{ stepsBack: 2, color: false }]);
  });

  it("forces color on when the REPL is styled", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.diffResult = {
      ok: true,
      label: "styled",
      ageMs: 0,
      diff: "",
    };
    const controller = await harness(checkpoints, createStyles(true));

    await controller.handleLine("/diff");

    expect(checkpoints.diffCalls).toEqual([{ stepsBack: 1, color: true }]);
  });

  it("prints the store's reason, not an error, when there is nothing to diff", async () => {
    const checkpoints = new FakeCheckpoints();
    checkpoints.diffResult = {
      ok: false,
      reason:
        "nothing to diff — no checkpoint has been taken in this session yet.",
    };
    const controller = await harness(checkpoints);

    const result = await controller.handleLine("/diff");

    expect(result.output).toEqual([
      "nothing to diff — no checkpoint has been taken in this session yet.",
    ]);
  });

  it("rejects a non-numeric or non-positive argument with a usage notice", async () => {
    const checkpoints = new FakeCheckpoints();
    const controller = await harness(checkpoints);

    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const result = await controller.handleLine(`/diff ${bad}`);
      expect(result.output).toEqual([
        "usage: /diff [n]  — n counts back from the last checkpoint",
      ]);
    }
    expect(checkpoints.diffCalls).toEqual([]);
  });

  it("says it is unavailable when nothing can checkpoint", async () => {
    const controller = await harness();
    expect((await controller.handleLine("/diff")).output).toEqual([
      "/diff is not available here.",
    ]);
  });

  it("lists /diff in the help and completes it", async () => {
    const controller = await harness(new FakeCheckpoints());
    const help = await controller.handleLine("/help");
    expect(help.output.join("\n")).toContain("/diff [n]");
    expect(slashCompleter("/di")).toEqual([["/diff"], "/di"]);
  });
});
