import type { ModelMessage } from "@agent/ai";
import type { ChatTurnResult } from "@agent/coding-agent";
import { describe, expect, it } from "vitest";
import type { CheckpointStore, UndoOutcome } from "../src/checkpoint.js";
import type {
  InteractiveController,
  InteractiveControllerDeps,
  InteractiveSession,
} from "../src/interactive.js";
import {
  createInteractiveController,
  slashCompleter,
} from "../src/interactive.js";

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

  async capture(prompt: string): Promise<string | undefined> {
    this.captured.push(prompt);
    return this.warning;
  }

  async undo(): Promise<UndoOutcome> {
    this.undoCalls += 1;
    return this.outcome;
  }

  entries(): [] {
    return [];
  }
}

async function harness(
  checkpoints?: CheckpointStore,
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
