import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ModelDefinition,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  UsageBreakdown,
  UsageTotals,
} from "@agent/ai";
import { UNATTRIBUTED } from "@agent/ai";
import type { ChatTurnResult } from "@agent/coding-agent";
import type { AgentImageAttachment } from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import { defaultSessionDbPath, SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CustomCommand,
  LoadCustomCommandsResult,
} from "../src/commands.js";
import type { InputManager } from "../src/input.js";
import { filterCommandMenu, INPUT_SIGINT } from "../src/input.js";
import type {
  InteractiveController,
  InteractiveControllerDeps,
  InteractiveSession,
  InteractiveStart,
  LineSource,
  SessionFactoryArgs,
} from "../src/interactive.js";
import {
  chatUsageBreakdown,
  createInteractiveController,
  createReplCompleter,
  inputManagerLineSource,
  instructionsBannerLine,
  invalidSessionName,
  openChatStore,
  replCommandMenuEntries,
  resolveStartSession,
  SIGINT_LINE,
  shortId,
  slashCompleter,
  usageDeltaLine,
  usageTotalsLine,
  withDeadline,
} from "../src/interactive.js";
import type { FileLister, MentionImageReader } from "../src/mention.js";
import type { ProjectSetupState, SetupOutput } from "../src/onboard.js";
import { createProjectSetup, setupAnnounceLine } from "../src/onboard.js";
import { TextRenderer } from "../src/render.js";
import type { ResolvedModel } from "../src/run.js";
import { runSessionsListCommand } from "../src/sessions.js";

// --- fixtures ---------------------------------------------------------------

function model(id: string, provider = "anthropic"): ModelDefinition {
  return {
    provider,
    id,
    capabilities: {
      tools: true,
      reasoning: false,
      vision: false,
      structuredOutput: true,
    },
  };
}

function provider(id: string): ModelProvider {
  return {
    id,
    supports: () => true,
    // biome-ignore lint/correctness/useYield: never called — no send reaches a provider here.
    stream: async function* (
      _request: ModelRequest,
    ): AsyncIterable<ModelEvent> {
      throw new Error("the fake session never reaches a provider");
    },
  };
}

/**
 * A stand-in for `AgentChatSession`: it records what was sent and grows a
 * plausible transcript (user turn, then an assistant reply) so snapshot
 * persistence has something real to write.
 */
class FakeSession implements InteractiveSession {
  readonly sends: { instruction: string; runId: string }[] = [];
  /** What each send was handed to attach, in send order. */
  readonly attachments: (readonly AgentImageAttachment[])[] = [];
  readonly compactCalls: { runId: string }[] = [];
  readonly #messages: ModelMessage[] = [];
  status: ChatTurnResult["status"] = "success";
  failWith: Error | undefined;
  /** Runs inside `send`, so a test can make a turn consume tokens. */
  onSend: (() => void) | undefined;
  /** What `/compact` reports back; overridable per test. */
  compactResult: { elided: number; savedChars: number } = {
    elided: 2,
    savedChars: 900,
  };

  constructor(seed: readonly ModelMessage[] = []) {
    this.#messages.push(...seed);
  }

  async send(
    instruction: string,
    context: { runId: string },
    images?: readonly AgentImageAttachment[],
  ): Promise<ChatTurnResult> {
    this.sends.push({ instruction, runId: context.runId });
    this.attachments.push(images ?? []);
    this.onSend?.();
    if (this.#messages.length === 0) {
      this.#messages.push({ role: "system", content: "system prompt" });
    }
    this.#messages.push({ role: "user", content: instruction });
    if (this.failWith !== undefined) throw this.failWith;
    this.#messages.push({ role: "assistant", content: `ok: ${instruction}` });
    return {
      status: this.status,
      summary: `handled ${instruction}`,
      iterations: 1,
      toolCalls: 0,
    };
  }

  messages(): readonly ModelMessage[] {
    return this.#messages.slice();
  }

  async compactNow(context: {
    runId: string;
  }): Promise<{ elided: number; savedChars: number }> {
    this.compactCalls.push({ runId: context.runId });
    return this.compactResult;
  }
}

/** A usage source the controller can diff, advanced by hand between turns. */
class FakeUsage {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  /** Per-model attribution, empty unless a test sets one. */
  breakdown = new Map<string, UsageBreakdown>();

  totals(): UsageTotals {
    return {
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      costUsd: this.costUsd,
    };
  }

  breakdownBy(): ReadonlyMap<string, UsageBreakdown> {
    return this.breakdown;
  }
}

interface Harness {
  readonly controller: InteractiveController;
  readonly store: SqliteSessionStore;
  readonly workspacePath: string;
  readonly written: string[];
  readonly usage: FakeUsage;
  /** Every session the factory built, oldest first. */
  readonly built: FakeSession[];
  /** The `messages` each factory call was asked to rebuild from. */
  readonly restored: (readonly ModelMessage[])[];
  readonly session: () => FakeSession;
}

let tempDir: string;
let openStores: SqliteSessionStore[] = [];

function newStore(name = "sessions.db"): SqliteSessionStore {
  const store = new SqliteSessionStore({ path: path.join(tempDir, name) });
  openStores.push(store);
  return store;
}

function freshStart(id: string): InteractiveStart {
  return { sessionId: id, title: "", persisted: false, messages: [] };
}

async function harness(
  overrides: Partial<InteractiveControllerDeps> = {},
  start: InteractiveStart = freshStart("11111111-aaaa-4aaa-8aaa-000000000001"),
): Promise<Harness> {
  const store =
    "store" in overrides
      ? (overrides.store as SqliteSessionStore | undefined)
      : newStore();
  const workspacePath = overrides.workspacePath ?? path.join(tempDir, "repo");
  const written: string[] = [];
  const usage = new FakeUsage();
  const built: FakeSession[] = [];
  const restored: (readonly ModelMessage[])[] = [];

  const createSession = (args: SessionFactoryArgs): FakeSession => {
    restored.push(args.messages);
    const session = new FakeSession(args.messages);
    built.push(session);
    return session;
  };

  const deps: InteractiveControllerDeps = {
    workspacePath,
    ...(store === undefined ? {} : { store }),
    createSession,
    write: (line) => written.push(line),
    modelAlias: "claude-sonnet-5",
    model: model("claude-sonnet-5-x"),
    provider: provider("anthropic"),
    start,
    usage,
    resolveModel: async (alias): Promise<ResolvedModel> =>
      alias === "gpt-mini"
        ? { model: model("gpt-mini-x", "openai"), provider: provider("openai") }
        : { error: `Unknown model alias "${alias}".` },
    ...overrides,
  };

  const controller = await createInteractiveController(deps);
  return {
    controller,
    store: store as SqliteSessionStore,
    workspacePath,
    written,
    usage,
    built,
    restored,
    session: () => {
      const last = built[built.length - 1];
      if (last === undefined) throw new Error("no session was built");
      return last;
    },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "kapel-interactive-"));
});

afterEach(async () => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  openStores = [];
  await rm(tempDir, { recursive: true, force: true });
});

// --- messages ---------------------------------------------------------------

describe("interactive controller — messages", () => {
  it("sends a typed line to the session under the session id as run id", async () => {
    const h = await harness();
    const result = await h.controller.handleLine("fix the failing test");

    expect(h.session().sends).toEqual([
      {
        instruction: "fix the failing test",
        runId: h.controller.sessionId(),
      },
    ]);
    expect(result.effect).toBeUndefined();
    expect(h.written).toEqual(result.output);
  });

  it("persists the full snapshot and titles the session from the first message", async () => {
    const h = await harness();
    await h.controller.handleLine("fix the failing test");

    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.record.title).toBe("fix the failing test");
    expect(loaded?.record.workspacePath).toBe(h.workspacePath);
    expect(loaded?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);

    // A second turn rewrites the same rows plus the new ones.
    await h.controller.handleLine("now run the tests");
    const again = await h.store.loadChatSession(h.controller.sessionId());
    expect(again?.messages).toHaveLength(5);
    expect(again?.record.messageCount).toBe(5);
    expect(again?.record.title).toBe("fix the failing test");
  });

  it("prints a usage delta after each turn", async () => {
    const h = await harness();
    h.session().onSend = () => {
      h.usage.inputTokens = 120;
      h.usage.outputTokens = 34;
      h.usage.costUsd = 0.0021;
    };

    const result = await h.controller.handleLine("hello");
    expect(result.output.at(-1)).toBe("tokens +120 in, +34 out  (~$0.0021)");

    // A turn that costs nothing new still reports its (zero) delta.
    h.session().onSend = () => {
      h.usage.inputTokens = 200;
      h.usage.outputTokens = 40;
    };
    const second = await h.controller.handleLine("again");
    expect(second.output.at(-1)).toBe("tokens +80 in, +6 out");
  });

  it("reports a non-success turn without ending the session", async () => {
    const h = await harness();
    h.session().status = "failed";
    const result = await h.controller.handleLine("do the thing");
    expect(result.output).toContain("(failed) handled do the thing");
    expect(result.effect).toBeUndefined();
  });

  it("keeps the conversation and still persists when a send throws", async () => {
    const h = await harness();
    h.session().failWith = new Error("provider exploded");
    const result = await h.controller.handleLine("boom");

    expect(result.output[0]).toBe("error: provider exploded");
    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      "system prompt",
      "boom",
    ]);
  });

  it("ignores blank lines", async () => {
    const h = await harness();
    const result = await h.controller.handleLine("   ");
    expect(result).toEqual({ output: [] });
    expect(h.session().sends).toEqual([]);
  });

  it("persists nothing when there is no store (--no-save)", async () => {
    const h = await harness({ store: undefined });
    await h.controller.handleLine("fix the failing test");

    const probe = newStore("probe.db");
    expect(await probe.listChatSessions()).toEqual([]);
    expect(h.session().sends).toHaveLength(1);
  });
});

// --- @ mentions -------------------------------------------------------------

describe("interactive controller — @ mentions", () => {
  const fileExists = (relativePath: string): boolean =>
    relativePath === "apps/cli/src/input.ts" || relativePath === "README.md";

  it("appends the mentioned-files line to what the agent is sent", async () => {
    const h = await harness({ fileExists });
    await h.controller.handleLine("look at @apps/cli/src/input.ts please");

    expect(h.session().sends[0]?.instruction).toBe(
      "look at @apps/cli/src/input.ts please\n\n[mentioned files: apps/cli/src/input.ts]",
    );
  });

  it("lists several mentions on the one line, and never their contents", async () => {
    const h = await harness({ fileExists });
    await h.controller.handleLine(
      "compare @README.md and @apps/cli/src/input.ts",
    );

    expect(h.session().sends[0]?.instruction).toContain(
      "[mentioned files: README.md, apps/cli/src/input.ts]",
    );
  });

  it("leaves a message with no resolvable mention exactly as typed", async () => {
    const h = await harness({ fileExists });
    await h.controller.handleLine("ping @here about @nothing.ts");

    expect(h.session().sends[0]?.instruction).toBe(
      "ping @here about @nothing.ts",
    );
  });

  it("titles the session from the text as typed, not from the annotation", async () => {
    const h = await harness({ fileExists });
    await h.controller.handleLine("look at @README.md");

    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.record.title).toBe("look at @README.md");
  });

  it("resolves mentions against the real workspace by default", async () => {
    const workspacePath = path.join(tempDir, "mention-workspace");
    await mkdir(path.join(workspacePath, "src"), { recursive: true });
    await writeFile(path.join(workspacePath, "src", "a.ts"), "const a = 1;\n");

    const h = await harness({ workspacePath });
    await h.controller.handleLine("read @src/a.ts and @src/missing.ts");

    expect(h.session().sends[0]?.instruction).toBe(
      "read @src/a.ts and @src/missing.ts\n\n[mentioned files: src/a.ts]",
    );
  });
});

// --- @ mentions that are images ---------------------------------------------

describe("interactive controller — image mentions", () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("pixels", "utf8"),
  ]);
  const fileExists = (relativePath: string): boolean =>
    ["shot.png", "notes.md", "huge.png"].includes(relativePath);
  const readImage: MentionImageReader = async (relativePath) =>
    relativePath === "huge.png"
      ? { error: "it is 9.0 MiB, over the 5.0 MiB per-image limit" }
      : { bytes: PNG, path: `/repo/${relativePath}` };

  it("attaches an image mention to the turn and names it in the message", async () => {
    const h = await harness({ fileExists, readImage });
    const result = await h.controller.handleLine(
      "what is wrong with @shot.png?",
    );

    expect(h.session().attachments[0]).toEqual([
      {
        mediaType: "image/png",
        base64: PNG.toString("base64"),
        path: "/repo/shot.png",
      },
    ]);
    expect(h.session().sends[0]?.instruction).toBe(
      "what is wrong with @shot.png?\n\n[attached images: shot.png]",
    );
    // Nothing to report: the only line is the usage delta.
    expect(result.output).toEqual(["tokens +0 in, +0 out"]);
  });

  it("says why an image did not make it, and sends the turn anyway", async () => {
    const h = await harness({ fileExists, readImage });
    const result = await h.controller.handleLine("look at @huge.png");

    expect(result.output[0]).toBe(
      "note: @huge.png was not attached — it is 9.0 MiB, over the 5.0 MiB per-image limit.",
    );
    expect(h.session().attachments[0]).toEqual([]);
    expect(h.session().sends[0]?.instruction).toBe(
      "look at @huge.png\n\n[mentioned files: huge.png]",
    );
  });

  it("leaves non-image mentions on the paths line", async () => {
    const h = await harness({ fileExists, readImage });
    await h.controller.handleLine("compare @notes.md with @shot.png");

    expect(h.session().sends[0]?.instruction).toBe(
      "compare @notes.md with @shot.png\n\n" +
        "[mentioned files: notes.md]\n[attached images: shot.png]",
    );
  });

  it("attaches by path on a delegated backend, with no bytes and no notice", async () => {
    const readImagePath: MentionImageReader = async (relativePath) => ({
      path: `/repo/${relativePath}`,
    });
    const h = await harness({
      backend: "codex",
      fileExists,
      readImage,
      readImagePath,
    });
    const result = await h.controller.handleLine("look at @shot.png");

    // Same `[attached images: …]` treatment as the native path, and nothing
    // scary printed: the difference is only in how the file reaches the CLI.
    expect(h.session().sends[0]?.instruction).toBe(
      "look at @shot.png\n\n[attached images: shot.png]",
    );
    expect(h.session().attachments[0]).toEqual([]);
    expect(result.output).toEqual(["tokens +0 in, +0 out"]);
  });

  it("still refuses an over-limit image on a delegated backend", async () => {
    const readImagePath: MentionImageReader = async (relativePath) =>
      relativePath === "huge.png"
        ? { error: "it is 9.0 MiB, over the 5.0 MiB per-image limit" }
        : { path: `/repo/${relativePath}` };
    const h = await harness({
      backend: "codex",
      fileExists,
      readImage,
      readImagePath,
    });
    const result = await h.controller.handleLine("look at @huge.png");

    expect(result.output[0]).toBe(
      "note: @huge.png was not attached — it is 9.0 MiB, over the 5.0 MiB per-image limit.",
    );
    expect(h.session().sends[0]?.instruction).toBe(
      "look at @huge.png\n\n[mentioned files: huge.png]",
    );
  });

  it("reads a real workspace image when no reader is injected", async () => {
    const workspacePath = path.join(tempDir, "image-workspace");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "shot.png"), PNG);

    const h = await harness({ workspacePath });
    await h.controller.handleLine("look at @shot.png");

    expect(h.session().attachments[0]).toEqual([
      {
        mediaType: "image/png",
        base64: PNG.toString("base64"),
        path: path.join(workspacePath, "shot.png"),
      },
    ]);
  });
});

// --- slash commands ---------------------------------------------------------

describe("interactive controller — slash commands", () => {
  it("/help lists every command and /exit asks the shell to leave", async () => {
    const h = await harness();
    const help = await h.controller.handleLine("/HELP");
    const text = help.output.join("\n");
    for (const command of [
      "/help",
      "/exit",
      "/new",
      "/sessions",
      "/resume",
      "/model",
      "/login",
      "/usage",
      "/compact",
      "/plan",
      "/orchestrate",
      "/runs",
      "/resume-run",
    ]) {
      expect(text).toContain(command);
    }

    expect((await h.controller.handleLine("/exit")).effect).toBe("exit");
    expect((await h.controller.handleLine("/quit")).effect).toBe("exit");
  });

  it("hints at /help for an unknown command", async () => {
    const h = await harness();
    const result = await h.controller.handleLine("/nope please");
    expect(result.output).toEqual([
      'Unknown command "/nope". Type /help for the list.',
    ]);
    expect(h.session().sends).toEqual([]);
  });

  it("/usage prints the cumulative totals", async () => {
    const h = await harness();
    h.usage.inputTokens = 1500;
    h.usage.outputTokens = 250;
    h.usage.costUsd = 0.0125;
    expect((await h.controller.handleLine("/usage")).output).toEqual([
      "tokens — input: 1500, output: 250  (~$0.0125)",
    ]);
  });

  it("/usage breaks the total down by model", async () => {
    const h = await harness();
    h.usage.inputTokens = 42_345;
    h.usage.outputTokens = 8_100;
    h.usage.costUsd = 0.1742;
    h.usage.breakdown = new Map<string, UsageBreakdown>([
      [
        "claude-sonnet-5",
        {
          key: "claude-sonnet-5",
          usage: { inputTokens: 12_345, outputTokens: 2_100 },
          costUsd: 0.1142,
          pricing: "known",
          models: ["claude-sonnet-5"],
          agents: ["agent"],
          tasks: [UNATTRIBUTED],
          samples: 2,
        },
      ],
      [
        "claude-code",
        {
          key: "claude-code",
          usage: { inputTokens: 30_000, outputTokens: 6_000 },
          costUsd: 0,
          // A subscription-billed CLI: real tokens, no price to report.
          pricing: "unknown",
          models: ["claude-code"],
          agents: [UNATTRIBUTED],
          tasks: [UNATTRIBUTED],
          samples: 1,
        },
      ],
    ]);

    expect((await h.controller.handleLine("/usage")).output).toEqual([
      "tokens — input: 42345, output: 8100  (~$0.1742)",
      "  claude-sonnet-5: 12.3k in / 2.1k out · $0.11",
      "  claude-code: 30.0k in / 6.0k out · n/a",
    ]);
  });

  it("/compact forces compaction on the native session and reports what was elided", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    h.session().compactResult = { elided: 3, savedChars: 1200 };

    const result = await h.controller.handleLine("/compact");
    expect(result.output).toEqual([
      "compacted: elided 3 tool results, saved ~1200 chars",
    ]);
    expect(h.session().compactCalls).toEqual([
      { runId: h.controller.sessionId() },
    ]);
  });

  it("/compact says so in singular for exactly one elided result", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    h.session().compactResult = { elided: 1, savedChars: 400 };

    expect((await h.controller.handleLine("/compact")).output).toEqual([
      "compacted: elided 1 tool result, saved ~400 chars",
    ]);
  });

  it("/compact says there was nothing to compact", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    h.session().compactResult = { elided: 0, savedChars: 0 };

    expect((await h.controller.handleLine("/compact")).output).toEqual([
      "nothing to compact.",
    ]);
  });

  it("/sessions lists this directory's conversations, newest first", async () => {
    const h = await harness();
    await h.controller.handleLine("first objective");
    const firstId = h.controller.sessionId();
    await h.controller.handleLine("/new");
    await h.controller.handleLine("second objective");

    const listing = await h.controller.handleLine("/sessions");
    const text = listing.output.join("\n");
    expect(listing.output[0]).toContain("ID");
    expect(text).toContain("second objective");
    expect(text).toContain("first objective");
    expect(text).toContain(shortId(firstId));
    // The current session is flagged.
    expect(text).toMatch(
      new RegExp(`\\*\\s+${shortId(h.controller.sessionId())}`),
    );
  });

  it("/sessions says so when nothing has been recorded", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/sessions")).output).toEqual([
      `No chat sessions recorded for ${h.workspacePath} yet.`,
    ]);
  });

  it("/new switches to a fresh session id with no history", async () => {
    const h = await harness();
    await h.controller.handleLine("first objective");
    const firstId = h.controller.sessionId();

    const result = await h.controller.handleLine("/new");
    expect(result.effect).toBe("new-session");
    expect(h.controller.sessionId()).not.toBe(firstId);
    expect(h.controller.title()).toBe("");
    expect(h.restored.at(-1)).toEqual([]);

    // The old conversation is still on disk, untouched.
    const old = await h.store.loadChatSession(firstId);
    expect(old?.messages).toHaveLength(3);
  });

  it("/new records nothing for a session nobody said anything in", async () => {
    const h = await harness();
    await h.controller.handleLine("/new");
    expect(await h.store.listChatSessions(h.workspacePath)).toEqual([]);
  });

  it("/resume switches to a session matched by unique prefix", async () => {
    const h = await harness();
    await h.controller.handleLine("first objective");
    const firstId = h.controller.sessionId();
    await h.controller.handleLine("/new");
    await h.controller.handleLine("second objective");

    const result = await h.controller.handleLine(
      `/resume ${firstId.slice(0, 8)}`,
    );
    expect(result.effect).toBe("resumed");
    expect(result.output).toEqual(["resumed first objective (3 messages)"]);
    expect(h.controller.sessionId()).toBe(firstId);
    expect(h.controller.title()).toBe("first objective");
    expect(h.restored.at(-1)).toHaveLength(3);
  });

  it("/resume refuses an ambiguous prefix and an unknown one", async () => {
    const ids = [
      "abcd1111-0000-4000-8000-000000000001",
      "abcd2222-0000-4000-8000-000000000002",
    ];
    let next = 0;
    const h = await harness(
      {
        newId: () => {
          const id = ids[next] ?? "unused";
          next += 1;
          return id;
        },
      },
      { ...freshStart(ids[0] ?? ""), sessionId: ids[0] ?? "" },
    );
    next = 1;
    await h.controller.handleLine("first objective");
    await h.controller.handleLine("/new");
    await h.controller.handleLine("second objective");

    const ambiguous = await h.controller.handleLine("/resume abcd");
    expect(ambiguous.effect).toBeUndefined();
    expect(ambiguous.output[0]).toContain("matches 2 sessions");

    const unknown = await h.controller.handleLine("/resume zzzz");
    expect(unknown.output[0]).toContain('No chat session matches "zzzz"');
    expect(unknown.output[0]).toContain("Available:");
    // Neither error moved the conversation.
    expect(h.controller.sessionId()).toBe(ids[1]);
  });

  it("/model prints the current model and switches for future turns", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/model")).output).toEqual([
      "model: claude-sonnet-5 (anthropic/claude-sonnet-5-x)",
    ]);

    await h.controller.handleLine("first objective");
    const before = h.session().messages();

    const switched = await h.controller.handleLine("/model gpt-mini");
    expect(switched.effect).toBe("model-changed");
    expect(switched.output).toEqual([
      "model switched to gpt-mini — future turns use it.",
    ]);
    expect(h.controller.modelAlias()).toBe("gpt-mini");
    // The rebuilt session inherited the whole transcript.
    expect(h.restored.at(-1)).toEqual(before);
    expect((await h.controller.handleLine("/model")).output).toEqual([
      "model: gpt-mini (openai/gpt-mini-x)",
    ]);
  });

  it("/model reports an unresolvable alias without changing anything", async () => {
    const h = await harness();
    const built = h.built.length;
    const result = await h.controller.handleLine("/model nonsense");
    expect(result.effect).toBeUndefined();
    expect(result.output).toEqual(['Unknown model alias "nonsense".']);
    expect(h.controller.modelAlias()).toBe("claude-sonnet-5");
    expect(h.built).toHaveLength(built);
  });

  it("/orchestrate runs the pipeline and surfaces its errors in-REPL", async () => {
    const objectives: string[] = [];
    let failure: Error | undefined;
    const h = await harness({
      orchestrate: async (objective) => {
        objectives.push(objective);
        if (failure !== undefined) throw failure;
        return 0;
      },
    });

    expect(
      (await h.controller.handleLine("/orchestrate add a route")).output,
    ).toEqual([]);
    expect(objectives).toEqual(["add a route"]);

    failure = new Error("policy lock is stale — run `kapel policy compile`");
    const failed = await h.controller.handleLine("/orchestrate add a route");
    expect(failed.output).toEqual([
      "policy lock is stale — run `kapel policy compile`",
    ]);
    expect(failed.effect).toBeUndefined();
  });

  it("/orchestrate without an objective prints its usage", async () => {
    const h = await harness({ orchestrate: async () => 0 });
    expect((await h.controller.handleLine("/orchestrate")).output).toEqual([
      'usage: /orchestrate "<objective>"',
    ]);
  });

  it("/plan renders the plan through the REPL's own lines", async () => {
    const objectives: string[] = [];
    const h = await harness({
      plan: async (objective, output) => {
        objectives.push(objective);
        output.log("Objective: add a route");
        output.log("T01  implementation  medium  coder  -  Add the route");
        output.log("Routing rationale:");
        return 0;
      },
    });

    const result = await h.controller.handleLine("/plan add a route");
    expect(objectives).toEqual(["add a route"]);
    expect(result.output).toEqual([
      "Objective: add a route",
      "T01  implementation  medium  coder  -  Add the route",
      "Routing rationale:",
    ]);
    expect(result.effect).toBeUndefined();
    // The plan is a preview: nothing was sent to the model, so no turn ran.
    expect(h.written).toEqual(result.output);
  });

  it("/plan reports a failed pipeline without ending the conversation", async () => {
    const h = await harness({
      plan: async (_objective, output) => {
        output.error("No policy lock found. Run `kapel policy compile`.");
        return 1;
      },
    });
    const result = await h.controller.handleLine("/plan add a route");
    expect(result.output).toEqual([
      "No policy lock found. Run `kapel policy compile`.",
    ]);
    expect(result.effect).toBeUndefined();
  });

  it("/plan surfaces a thrown failure as one line", async () => {
    const h = await harness({
      plan: async () => {
        throw new Error("planner model is not configured");
      },
    });
    expect((await h.controller.handleLine("/plan x")).output).toEqual([
      "planner model is not configured",
    ]);
  });

  it("/plan without an objective prints its usage", async () => {
    const h = await harness({ plan: async () => 0 });
    expect((await h.controller.handleLine("/plan")).output).toEqual([
      'usage: /plan "<objective>"',
    ]);
  });

  it("/plan says so when there is no pipeline to run", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/plan x")).output).toEqual([
      "/plan is not available here.",
    ]);
  });

  it("/runs lists the recorded runs, so /resume-run has an id to take", async () => {
    let called = 0;
    const h = await harness({
      runs: async (output) => {
        called += 1;
        output.log("ID    STATUS   STARTED  TASKS  OBJECTIVE");
        output.log("0f3c  failed   …        1/3    add a health endpoint");
        return 0;
      },
    });
    const result = await h.controller.handleLine("/runs");
    expect(called).toBe(1);
    expect(result.output).toEqual([
      "ID    STATUS   STARTED  TASKS  OBJECTIVE",
      "0f3c  failed   …        1/3    add a health endpoint",
    ]);
  });

  it("/runs says so when runs are not being recorded", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/runs")).output).toEqual([
      "/runs is not available here.",
    ]);
  });

  it("/resume-run re-executes one recorded run by id", async () => {
    const ids: string[] = [];
    const h = await harness({
      resumeRun: async (runId, output) => {
        ids.push(runId);
        output.log(`Resuming run ${runId} — 2 of 3 tasks left`);
        return 0;
      },
    });
    const result = await h.controller.handleLine("/resume-run 0f3c9a2b");
    expect(ids).toEqual(["0f3c9a2b"]);
    expect(result.output).toEqual([
      "Resuming run 0f3c9a2b — 2 of 3 tasks left",
    ]);
  });

  it("/resume-run is distinct from /resume, which still switches conversations", async () => {
    const ids: string[] = [];
    const h = await harness({
      resumeRun: async (runId) => {
        ids.push(runId);
        return 0;
      },
    });
    // `/resume` with an id nothing matches is the session switcher answering,
    // not the run resumer: the two never see each other's arguments.
    const switched = await h.controller.handleLine("/resume 0f3c9a2b");
    expect(ids).toEqual([]);
    expect(switched.output.join("\n")).not.toContain("Resuming run");
  });

  it("/resume-run without an id points at /runs", async () => {
    const h = await harness({ resumeRun: async () => 0 });
    expect((await h.controller.handleLine("/resume-run")).output).toEqual([
      "usage: /resume-run <runId>  — see /runs",
    ]);
  });

  it("/resume-run reports a failure without ending the conversation", async () => {
    const h = await harness({
      resumeRun: async () => {
        throw new Error("Unknown run zzz.");
      },
    });
    const result = await h.controller.handleLine("/resume-run zzz");
    expect(result.output).toEqual(["Unknown run zzz."]);
    expect(result.effect).toBeUndefined();
  });

  it("/resume-run says so when there is nothing to resume into", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/resume-run 0f3c")).output).toEqual([
      "/resume-run is not available here.",
    ]);
  });
});

// --- /login -------------------------------------------------------------

describe("withDeadline", () => {
  it("resolves with the value when it arrives in time", async () => {
    await expect(
      withDeadline(Promise.resolve("fast"), 50, "late"),
    ).resolves.toBe("fast");
  });

  it("resolves with the fallback when it does not", async () => {
    const slow = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("slow"), 500);
      timer.unref?.();
    });
    await expect(withDeadline(slow, 5, "late")).resolves.toBe("late");
  });

  it("treats a rejection as the fallback rather than a failure", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("nope")), 50, "late"),
    ).resolves.toBe("late");
  });
});

describe("interactive controller — /stats", () => {
  it("says so when nothing is wired, like /config with no configure", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/stats")).output).toEqual([
      "/stats is not available here.",
    ]);
  });

  it("prints whatever the dashboard renders", async () => {
    const h = await harness({
      dashboard: async () => ["╭──╮", "│  │", "╰──╯"],
    });
    expect((await h.controller.handleLine("/stats")).output).toEqual([
      "╭──╮",
      "│  │",
      "╰──╯",
    ]);
  });

  it("re-renders on every call rather than replaying the first one", async () => {
    let calls = 0;
    const h = await harness({
      dashboard: async () => {
        calls += 1;
        return [`render ${calls}`];
      },
    });
    expect((await h.controller.handleLine("/stats")).output).toEqual([
      "render 1",
    ]);
    expect((await h.controller.handleLine("/stats")).output).toEqual([
      "render 2",
    ]);
  });

  it("tells the dashboard which session, backend and model are current", async () => {
    const seen: unknown[] = [];
    const h = await harness({
      dashboard: async (context) => {
        seen.push(context);
        return [];
      },
    });
    await h.controller.handleLine("/stats");
    expect(seen).toEqual([
      {
        sessionId: h.controller.sessionId(),
        backend: "native",
        modelAlias: "claude-sonnet-5",
      },
    ]);

    await h.controller.handleLine("/model gpt-mini");
    await h.controller.handleLine("/stats");
    expect(seen[1]).toMatchObject({ modelAlias: "gpt-mini" });
  });

  it("is offered by /help and by tab completion", async () => {
    const h = await harness();
    const help = (await h.controller.handleLine("/help")).output.join("\n");
    expect(help).toContain("/stats");
    expect(slashCompleter("/sta")[0]).toEqual(["/stats"]);
  });
});

describe("interactive controller — recorded usage", () => {
  it("files each turn's spend, as a delta, against the session", async () => {
    const h = await harness();
    const spend = (input: number, output: number, cost: number): void => {
      h.usage.inputTokens += input;
      h.usage.outputTokens += output;
      h.usage.costUsd += cost;
    };

    h.session().onSend = () => spend(100, 20, 0.5);
    await h.controller.handleLine("first");
    h.session().onSend = () => spend(80, 5, 0.4);
    await h.controller.handleLine("second");

    const totals = await h.store.activityTotals({ since: 0 });
    // The rows are per-turn deltas, so they sum back to the running total.
    expect(totals.inputTokens).toBe(180);
    expect(totals.outputTokens).toBe(25);
    expect(totals.costUsd).toBeCloseTo(0.9, 10);

    const byBackend = await h.store.usageByBackend({ since: 0 });
    expect(byBackend).toEqual([
      {
        backend: "native",
        inputTokens: 180,
        outputTokens: 25,
        costUsd: 0.9,
      },
    ]);
  });

  it("records nothing for a turn that spent nothing", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    expect((await h.store.activityTotals({ since: 0 })).inputTokens).toBe(0);
    expect(await h.store.usageByBackend({ since: 0 })).toEqual([]);
  });

  it("still answers the turn when there is no store to record into", async () => {
    const h = await harness({ store: undefined });
    h.session().onSend = () => {
      h.usage.inputTokens += 10;
    };
    const result = await h.controller.handleLine("hello");
    expect(result.output.at(-1)).toContain("tokens +10 in");
  });
});

describe("interactive controller — /login", () => {
  it("says so when nothing is wired, like /config with no configure", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/login")).output).toEqual([
      "/login is not available here.",
    ]);
  });

  it("prints one line per backend in the effective config", async () => {
    const h = await harness({
      login: {
        backends: ["claude-code", "codex", "native"],
        check: async (backend) =>
          backend === "claude-code"
            ? { ok: true, installed: true }
            : { ok: false, installed: false, detail: "not on PATH" },
        env: {},
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(result.output).toEqual([
      "claude-code: logged in",
      "codex: not installed (not on PATH)",
      "native: credential missing — set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or OPENAI_API_KEY",
    ]);
  });

  it("says the native credential is present when one is set", async () => {
    const h = await harness({
      login: {
        backends: ["native"],
        check: async () => ({ ok: true }),
        env: { ANTHROPIC_API_KEY: "sk-x" },
      },
    });
    expect((await h.controller.handleLine("/login")).output).toEqual([
      "native: credential present",
    ]);
  });

  it("reports claude-code as not logged in and stops there on non-interactive stdin (no confirm wired)", async () => {
    const h = await harness({
      login: {
        backends: ["claude-code"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        // No `confirm`/`runClaudeCodeLogin` — mirrors a piped, non-interactive REPL.
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(result.output).toEqual(["claude-code: not logged in"]);
  });

  it("offers to run claude auth login, and reports success after a clean re-probe", async () => {
    const questions: string[] = [];
    let loginCalls = 0;
    const h = await harness({
      login: {
        backends: ["claude-code"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        runClaudeCodeLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(questions).toEqual([
      "Claude Code is installed but not logged in — run `claude auth login` now?",
    ]);
    expect(loginCalls).toBe(1);
    expect(result.output).toEqual([
      "claude-code: not logged in",
      "running `claude auth login` — follow the prompts in your terminal…",
      "claude-code: now logged in.",
    ]);
  });

  it("does not spawn claude auth login when the user declines", async () => {
    let loginCalls = 0;
    const h = await harness({
      login: {
        backends: ["claude-code"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        confirm: async () => false,
        runClaudeCodeLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(loginCalls).toBe(0);
    expect(result.output).toEqual(["claude-code: not logged in"]);
  });

  it("reports a claude auth login attempt that still isn't logged in", async () => {
    const h = await harness({
      login: {
        backends: ["claude-code"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        confirm: async () => true,
        runClaudeCodeLogin: async () => ({
          ok: false,
          detail: "still no token",
        }),
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(result.output).toEqual([
      "claude-code: not logged in",
      "running `claude auth login` — follow the prompts in your terminal…",
      "claude-code: still not logged in: still no token",
    ]);
  });

  it("reports codex as not logged in and stops there on non-interactive stdin (no confirm wired)", async () => {
    const h = await harness({
      login: {
        backends: ["codex"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        // No `confirm`/`runCodexLogin` — mirrors a piped, non-interactive REPL.
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(result.output).toEqual(["codex: not logged in"]);
  });

  it("offers to run codex login, and reports success after a clean re-probe", async () => {
    const questions: string[] = [];
    let loginCalls = 0;
    const h = await harness({
      login: {
        backends: ["codex"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        runCodexLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(questions).toEqual([
      "Codex is installed but not logged in — run `codex login` now?",
    ]);
    expect(loginCalls).toBe(1);
    expect(result.output).toEqual([
      "codex: not logged in",
      "running `codex login` — follow the prompts in your terminal…",
      "codex: now logged in.",
    ]);
  });

  it("does not spawn codex login when the user declines", async () => {
    let loginCalls = 0;
    const h = await harness({
      login: {
        backends: ["codex"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        confirm: async () => false,
        runCodexLogin: async () => {
          loginCalls += 1;
          return { ok: true };
        },
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(loginCalls).toBe(0);
    expect(result.output).toEqual(["codex: not logged in"]);
  });

  it("reports a codex login attempt that still isn't logged in", async () => {
    const h = await harness({
      login: {
        backends: ["codex"],
        check: async () => ({ ok: false, installed: true }),
        env: {},
        confirm: async () => true,
        runCodexLogin: async () => ({ ok: false, detail: "still no token" }),
      },
    });
    const result = await h.controller.handleLine("/login");
    expect(result.output).toEqual([
      "codex: not logged in",
      "running `codex login` — follow the prompts in your terminal…",
      "codex: still not logged in: still no token",
    ]);
  });
});

// --- automatic project setup, re-run by /plan and /orchestrate -------------

describe("interactive controller — automatic project setup", () => {
  /**
   * The real setup (session memory and all), with its filesystem probe and
   * its two commands faked — the same wiring `runInteractive` builds, minus
   * the terminal and the model call.
   */
  function offer(
    state: ProjectSetupState = "needs-init",
    options: { interactive?: boolean; initOk?: boolean } = {},
  ): {
    ensureProjectSetup: (output: SetupOutput) => Promise<boolean>;
    ran: string[];
  } {
    const ran: string[] = [];
    const setup = createProjectSetup({
      workspacePath: "/nowhere",
      detect: async () => state,
      interactive: options.interactive ?? true,
      init: async (output) => {
        ran.push("init");
        output.log("Created /nowhere/.agent");
        return options.initOk === false ? 1 : 0;
      },
      compile: async (output) => {
        ran.push("compile");
        output.log("Lock written to /nowhere/.agent/orchestration.lock.json");
        return 0;
      },
    });
    return {
      ensureProjectSetup: (output) => setup.ensure(output),
      ran,
    };
  }

  it("sets up automatically before /plan, and its output lands in the REPL", async () => {
    const { ensureProjectSetup, ran } = offer();
    const h = await harness({
      ensureProjectSetup,
      plan: async (_objective, output) => {
        output.log("T01  implementation  medium  coder  -  Add the route");
        return 0;
      },
    });

    const result = await h.controller.handleLine("/plan add a route");
    expect(ran).toEqual(["init", "compile"]);
    expect(result.output).toEqual([
      setupAnnounceLine("needs-init", false),
      "Created /nowhere/.agent",
      "Lock written to /nowhere/.agent/orchestration.lock.json",
      "T01  implementation  medium  coder  -  Add the route",
    ]);
  });

  it("runs only the compile when just the lock is missing", async () => {
    const { ensureProjectSetup, ran } = offer("needs-policy");
    const h = await harness({ ensureProjectSetup, plan: async () => 0 });

    const result = await h.controller.handleLine("/plan add a route");
    expect(result.output[0]).toBe(setupAnnounceLine("needs-policy", true));
    expect(ran).toEqual(["compile"]);
  });

  it("says nothing when the project is already set up", async () => {
    const { ensureProjectSetup, ran } = offer("ready");
    const h = await harness({ ensureProjectSetup, plan: async () => 0 });

    expect((await h.controller.handleLine("/plan add a route")).output).toEqual(
      [],
    );
    expect(ran).toEqual([]);
  });

  it("does not retry a setup that just failed, and /plan falls to its own error", async () => {
    const { ensureProjectSetup, ran } = offer("needs-init", {
      initOk: false,
    });
    const h = await harness({
      ensureProjectSetup,
      plan: async (_objective, output) => {
        output.error("No .agent directory found — run `kapel init` first");
        return 1;
      },
    });

    const first = await h.controller.handleLine("/plan add a route");
    expect(ran).toEqual(["init"]);
    expect(first.output).toEqual([
      setupAnnounceLine("needs-init", false),
      "Created /nowhere/.agent",
      "`kapel init` did not finish — kapel keeps working without it.",
      "No .agent directory found — run `kapel init` first",
    ]);

    // Failed once is settled for the session: the second command does not
    // retry, and prints only the error it always printed.
    const second = await h.controller.handleLine("/plan add a route");
    expect(ran).toEqual(["init"]);
    expect(second.output).toEqual([
      "No .agent directory found — run `kapel init` first",
    ]);

    // And the conversation itself never needed any of it.
    const chat = await h.controller.handleLine("hello");
    expect(h.session().sends.at(-1)?.instruction).toBe("hello");
    expect(chat.effect).toBeUndefined();
  });

  it("/orchestrate sets up automatically the same way", async () => {
    const { ensureProjectSetup, ran } = offer();
    const h = await harness({ ensureProjectSetup, orchestrate: async () => 0 });

    await h.controller.handleLine("/orchestrate add a route");
    expect(ran).toEqual(["init", "compile"]);
  });

  it("never runs on a line that was not going to run anything", async () => {
    const { ensureProjectSetup, ran } = offer();
    const h = await harness({
      ensureProjectSetup,
      plan: async () => 0,
      orchestrate: async () => 0,
    });

    await h.controller.handleLine("/plan");
    await h.controller.handleLine("/orchestrate");
    await h.controller.handleLine("just talking");
    expect(ran).toEqual([]);
  });

  it("runs /plan unchanged when no auto-setup is wired at all", async () => {
    const h = await harness({
      plan: async (_objective, output) => {
        output.error("No policy lock found. Run `kapel policy compile`.");
        return 1;
      },
    });
    expect((await h.controller.handleLine("/plan x")).output).toEqual([
      "No policy lock found. Run `kapel policy compile`.",
    ]);
  });
});

// --- a slash-only session is still a session ---------------------------------

describe("interactive controller — recording a slash-only session", () => {
  it("/orchestrate records the session, titled after the objective", async () => {
    const h = await harness({ orchestrate: async () => 0 });
    await h.controller.handleLine("/orchestrate add a health endpoint");

    const records = await h.store.listChatSessions(h.workspacePath);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(h.controller.sessionId());
    expect(records[0]?.title).toBe("add a health endpoint");
    expect(records[0]?.messageCount).toBe(0);
    expect(h.controller.title()).toBe("add a health endpoint");
  });

  it("/resume-run records the session too", async () => {
    const h = await harness({ resumeRun: async () => 0 });
    await h.controller.handleLine("/resume-run 0f3c9a2b");

    const records = await h.store.listChatSessions(h.workspacePath);
    expect(records.map((record) => record.title)).toEqual([
      "/resume-run 0f3c9a2b",
    ]);
  });

  it("keeps the transcript's own title once a message is sent", async () => {
    const h = await harness({ orchestrate: async () => 0 });
    await h.controller.handleLine("hello there");
    await h.controller.handleLine("/orchestrate add a health endpoint");

    const records = await h.store.listChatSessions(h.workspacePath);
    expect(records.map((record) => record.title)).toEqual(["hello there"]);
    // The row created by the message keeps taking the transcript.
    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.messages).toHaveLength(3);
  });

  it("records nothing for a command that did not run", async () => {
    const h = await harness({ orchestrate: async () => 0 });
    // No objective: the command prints its usage and does nothing.
    await h.controller.handleLine("/orchestrate");
    // Commands that record nothing anywhere leave no session behind either.
    await h.controller.handleLine("/help");
    await h.controller.handleLine("/usage");
    await h.controller.handleLine("/sessions");

    expect(await h.store.listChatSessions(h.workspacePath)).toEqual([]);
  });

  it("records nothing under --no-save", async () => {
    const h = await harness({ store: undefined, orchestrate: async () => 0 });
    expect(
      (await h.controller.handleLine("/orchestrate add a route")).output,
    ).toEqual([]);

    const probe = newStore("probe.db");
    expect(await probe.listChatSessions()).toEqual([]);
  });

  it("makes `kapel sessions` agree with `kapel runs` after a slash-only session", async () => {
    // The real layout: the database `kapel sessions` reads lives under the
    // workspace's own `.agent/`, and both halves of it — runs and chats —
    // are written by the same REPL.
    const workspacePath = path.join(tempDir, "slash-only");
    await mkdir(path.join(workspacePath, ".agent"), { recursive: true });
    const store = new SqliteSessionStore({
      path: defaultSessionDbPath(path.join(workspacePath, ".agent")),
    });
    openStores.push(store);

    const h = await harness({
      workspacePath,
      store,
      orchestrate: async () => 0,
    });
    await h.controller.handleLine("/orchestrate add a health endpoint");

    const lines: string[] = [];
    const code = await runSessionsListCommand(
      { cwd: workspacePath, json: false },
      { output: { log: (line) => lines.push(line), error: () => undefined } },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("add a health endpoint");
    expect(lines.join("\n")).not.toContain("No chat sessions recorded yet");
  });
});

// --- P1-8 (leftover): /name and /fork ----------------------------------------

describe("interactive controller — /name", () => {
  it("with no argument, reports (unnamed) for a session that has never been named", async () => {
    const h = await harness();
    expect((await h.controller.handleLine("/name")).output).toEqual([
      "(unnamed)",
    ]);
    expect(h.controller.name()).toBeUndefined();
  });

  it("names an unpersisted session immediately, creating its row", async () => {
    const h = await harness();
    const result = await h.controller.handleLine("/name my-project");
    expect(result.effect).toBe("renamed");
    expect(result.output).toEqual(['named "my-project"']);
    expect(h.controller.name()).toBe("my-project");

    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.record.name).toBe("my-project");

    expect((await h.controller.handleLine("/name")).output).toEqual([
      "my-project",
    ]);
  });

  it("renames an already-persisted session", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    await h.controller.handleLine("/name second-try");

    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.record.name).toBe("second-try");
  });

  it("treats a whitespace-only argument as no argument at all", async () => {
    // `handleSlash` already trims the argument before any command sees it,
    // so "/name   " and bare "/name" are indistinguishable by the time
    // `invalidSessionName` would run — both just show the current name.
    const h = await harness();
    expect((await h.controller.handleLine("/name   ")).output).toEqual([
      "(unnamed)",
    ]);
  });

  it("rejects a name starting with /", async () => {
    const h = await harness();
    const slashy = await h.controller.handleLine("/name /resume");
    expect(slashy.output[0]).toContain('cannot start with "/"');
    expect(h.controller.name()).toBeUndefined();
  });

  it("reports the name without persisting when there is no store", async () => {
    const h = await harness({ store: undefined });
    const result = await h.controller.handleLine("/name offline");
    expect(result.output[0]).toContain('named "offline"');
    expect(result.output[0]).toContain("not persisted");
    expect(h.controller.name()).toBe("offline");
  });
});

describe("interactive controller — /fork", () => {
  it("forks the current session and switches the REPL onto it", async () => {
    const h = await harness();
    await h.controller.handleLine("first objective");
    const sourceId = h.controller.sessionId();

    const result = await h.controller.handleLine("/fork");
    expect(result.effect).toBe("forked");
    expect(h.controller.sessionId()).not.toBe(sourceId);
    expect(h.controller.name()).toBeUndefined();
    // The fork carried the whole transcript over as the new session's start.
    expect(h.restored.at(-1)).toHaveLength(3);

    // The source session is untouched, still on disk under its own id.
    const source = await h.store.loadChatSession(sourceId);
    expect(source?.messages).toHaveLength(3);
    const fork = await h.store.loadChatSession(h.controller.sessionId());
    expect(fork?.messages).toHaveLength(3);
  });

  it("names the fork when given a name, independent of the source's own name", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    await h.controller.handleLine("/name source-name");

    const result = await h.controller.handleLine("/fork fork-name");
    expect(result.output[0]).toContain("fork-name");
    expect(h.controller.name()).toBe("fork-name");

    const fork = await h.store.loadChatSession(h.controller.sessionId());
    expect(fork?.record.name).toBe("fork-name");
  });

  it("refuses to fork a session that has never said anything", async () => {
    const h = await harness();
    const result = await h.controller.handleLine("/fork");
    expect(result.output).toEqual([
      "nothing to fork yet — say something first.",
    ]);
    expect(result.effect).toBeUndefined();
  });

  it("rejects an invalid fork name without forking", async () => {
    const h = await harness();
    await h.controller.handleLine("hello");
    const sourceId = h.controller.sessionId();

    const result = await h.controller.handleLine("/fork /nope");
    expect(result.output[0]).toContain('cannot start with "/"');
    expect(h.controller.sessionId()).toBe(sourceId);
  });

  it("says so when sessions are not being recorded", async () => {
    const h = await harness({ store: undefined });
    const result = await h.controller.handleLine("/fork");
    expect(result.output).toEqual([
      "sessions are not being recorded (--no-save), so there is nothing to fork.",
    ]);
  });
});

// --- P1-4: custom slash commands ---------------------------------------------

function customCommandsFixture(result: LoadCustomCommandsResult): {
  load: () => Promise<LoadCustomCommandsResult>;
  calls: number;
} {
  const source = {
    calls: 0,
    load: async (): Promise<LoadCustomCommandsResult> => {
      source.calls += 1;
      return result;
    },
  };
  return source;
}

describe("interactive controller — custom commands", () => {
  const reviewCommand: CustomCommand = {
    name: "review",
    description: "Review the current diff",
    template: "Review the diff.\n\n$ARGUMENTS",
    sourcePath: ".agent/commands/review.md",
  };

  it("expands the template and sends it like a typed message", async () => {
    const source = customCommandsFixture({
      commands: [reviewCommand],
      warnings: [],
    });
    const h = await harness({ customCommands: source.load });

    const result = await h.controller.handleLine("/review focus on auth.js");
    expect(h.session().sends[0]?.instruction).toBe(
      "Review the diff.\n\nfocus on auth.js",
    );
    // Dispatch goes through the normal message path: a usage delta line
    // closes it out, same as any other turn.
    expect(result.output.at(-1)).toMatch(/^tokens /);
    expect(result.effect).toBeUndefined();
  });

  it("scans once at controller start, so a command works before /help", async () => {
    const source = customCommandsFixture({
      commands: [reviewCommand],
      warnings: [],
    });
    await harness({ customCommands: source.load });
    expect(source.calls).toBe(1);
  });

  it("/help lists custom commands in their own section, with descriptions", async () => {
    const source = customCommandsFixture({
      commands: [reviewCommand],
      warnings: [],
    });
    const h = await harness({ customCommands: source.load });

    const help = await h.controller.handleLine("/help");
    const text = help.output.join("\n");
    expect(text).toContain("custom commands (.agent/commands/):");
    expect(text).toContain("/review");
    expect(text).toContain("Review the current diff");
    // /help rescans on top of the one at controller start.
    expect(source.calls).toBe(2);
  });

  it("/help surfaces load warnings (invalid names, YAML errors, collisions)", async () => {
    const source = customCommandsFixture({
      commands: [],
      warnings: [
        'skipping .agent/commands/help.md: "/help" is a built-in command and cannot be overridden',
      ],
    });
    const h = await harness({ customCommands: source.load });

    const help = await h.controller.handleLine("/help");
    expect(help.output).toContain(
      'warning: skipping .agent/commands/help.md: "/help" is a built-in command and cannot be overridden',
    );
  });

  it("says nothing extra in /help when there are no custom commands", async () => {
    const source = customCommandsFixture({ commands: [], warnings: [] });
    const h = await harness({ customCommands: source.load });

    const help = await h.controller.handleLine("/help");
    expect(help.output.join("\n")).not.toContain("custom commands");
  });

  it("a name that matches neither a built-in nor a custom command still errors", async () => {
    const source = customCommandsFixture({
      commands: [reviewCommand],
      warnings: [],
    });
    const h = await harness({ customCommands: source.load });

    const result = await h.controller.handleLine("/nope");
    expect(result.output).toEqual([
      'Unknown command "/nope". Type /help for the list.',
    ]);
  });

  it("appends the arguments when the template has no $ARGUMENTS placeholder", async () => {
    const noPlaceholder: CustomCommand = {
      name: "ping",
      template: "Say pong back.",
      sourcePath: ".agent/commands/ping.md",
    };
    const source = customCommandsFixture({
      commands: [noPlaceholder],
      warnings: [],
    });
    const h = await harness({ customCommands: source.load });

    await h.controller.handleLine("/ping loudly");
    expect(h.session().sends[0]?.instruction).toBe("Say pong back.\n\nloudly");
  });

  it("with no arguments, leaves a placeholder-free template untouched", async () => {
    const noPlaceholder: CustomCommand = {
      name: "ping",
      template: "Say pong back.",
      sourcePath: ".agent/commands/ping.md",
    };
    const source = customCommandsFixture({
      commands: [noPlaceholder],
      warnings: [],
    });
    const h = await harness({ customCommands: source.load });

    await h.controller.handleLine("/ping");
    expect(h.session().sends[0]?.instruction).toBe("Say pong back.");
  });

  describe("model pinning", () => {
    const pinned: CustomCommand = {
      name: "review",
      model: "gpt-mini",
      template: "Review $ARGUMENTS",
      sourcePath: ".agent/commands/review.md",
    };

    it("runs the one turn on the pinned model, then reverts", async () => {
      const source = customCommandsFixture({
        commands: [pinned],
        warnings: [],
      });
      const h = await harness({ customCommands: source.load });
      expect(h.controller.modelAlias()).toBe("claude-sonnet-5");

      const result = await h.controller.handleLine("/review auth.js");
      expect(result.effect).toBeUndefined();
      // Two extra builds around the one turn: switch to the pin, switch back
      // — the turn itself ran on the middle one.
      expect(h.built).toHaveLength(3);
      expect(h.built[1]?.sends[0]?.instruction).toBe("Review auth.js");
      // Reverted for every future turn.
      expect(h.controller.modelAlias()).toBe("claude-sonnet-5");

      await h.controller.handleLine("plain turn");
      expect(h.controller.modelAlias()).toBe("claude-sonnet-5");
    });

    it("warns and runs on the session model when the alias does not resolve", async () => {
      const badModel: CustomCommand = { ...pinned, model: "nonsense" };
      const source = customCommandsFixture({
        commands: [badModel],
        warnings: [],
      });
      const h = await harness({ customCommands: source.load });
      const builtBefore = h.built.length;

      const result = await h.controller.handleLine("/review auth.js");
      expect(result.output[0]).toContain('/review asks for model "nonsense"');
      expect(result.output[0]).toContain('Unknown model alias "nonsense"');
      expect(h.session().sends[0]?.instruction).toBe("Review auth.js");
      expect(h.controller.modelAlias()).toBe("claude-sonnet-5");
      // No rebuild happened at all — the pin never took effect.
      expect(h.built).toHaveLength(builtBefore);
    });

    it("warns and runs on the session model when the backend is delegated", async () => {
      const source = customCommandsFixture({
        commands: [pinned],
        warnings: [],
      });
      const h = await harness({
        customCommands: source.load,
        backend: "claude-code",
      });

      const result = await h.controller.handleLine("/review auth.js");
      expect(result.output[0]).toContain('/review asks for model "gpt-mini"');
      expect(result.output[0]).toContain("claude-code backend");
      expect(h.session().sends[0]?.instruction).toBe("Review auth.js");
    });
  });
});

// --- start selection --------------------------------------------------------

describe("resolveStartSession", () => {
  it("starts a fresh session when nothing is asked for", async () => {
    const store = newStore();
    const resolved = await resolveStartSession(
      store,
      "/repo",
      {},
      () => "fixed-id",
    );
    expect(resolved).toEqual({
      start: {
        sessionId: "fixed-id",
        title: "",
        persisted: false,
        messages: [],
      },
    });
  });

  it("--continue picks the most recently updated session for this cwd", async () => {
    const store = newStore();
    const workspacePath = "/repo";
    // Untouched since creation, an hour ago — and lexicographically *after*
    // the newer one, so a listing ordered by id would pick the wrong session.
    await store.createChatSession({
      id: "older-0000",
      workspacePath,
      title: "older chat",
      createdAt: Date.now() - 3_600_000,
    });
    await store.createChatSession({
      id: "newer-0000",
      workspacePath,
      title: "newer chat",
      createdAt: Date.now() - 3_600_000,
    });
    await store.appendChatMessages("newer-0000", [
      { seq: 0, message: { role: "user", content: "newer chat" } },
    ]);

    // Another directory's newer session must not win.
    await store.createChatSession({
      id: "elsewhere-0",
      workspacePath: "/other",
      title: "other chat",
      createdAt: Date.now(),
    });
    await store.appendChatMessages("elsewhere-0", [
      { seq: 0, message: { role: "user", content: "other" } },
    ]);

    const resolved = await resolveStartSession(store, workspacePath, {
      continue: true,
    });
    expect("start" in resolved && resolved.start.sessionId).toBe("newer-0000");
    expect("start" in resolved && resolved.start.title).toBe("newer chat");
    expect("start" in resolved && resolved.start.persisted).toBe(true);
    expect("start" in resolved && resolved.start.messages).toHaveLength(1);
  });

  it("--continue with nothing recorded is a friendly error", async () => {
    const store = newStore();
    const resolved = await resolveStartSession(store, "/repo", {
      continue: true,
    });
    expect("error" in resolved && resolved.error).toContain(
      "No chat sessions recorded for /repo",
    );
  });

  it("--session accepts a prefix and reports unknown ids", async () => {
    const store = newStore();
    await store.createChatSession({
      id: "cafe1234-0000",
      workspacePath: "/repo",
      title: "stored chat",
      createdAt: Date.now(),
    });

    const found = await resolveStartSession(store, "/repo", {
      session: "cafe",
    });
    expect("start" in found && found.start.sessionId).toBe("cafe1234-0000");

    const missing = await resolveStartSession(store, "/repo", {
      session: "beef",
    });
    expect("error" in missing && missing.error).toContain(
      'No chat session matches "beef"',
    );
  });

  it("refuses to resume when persistence is off", async () => {
    const resolved = await resolveStartSession(undefined, "/repo", {
      continue: true,
    });
    expect("error" in resolved && resolved.error).toContain("--no-save");
  });

  // P1-8: `--session` resolves through `resolveChatSessionReference`
  // (`@agent/session`), so a `/name`d session works as a `--session`
  // argument exactly as an id or an id prefix does.
  it("--session accepts a /name'd session", async () => {
    const store = newStore();
    await store.createChatSession({
      id: "cafe1234-0000",
      workspacePath: "/repo",
      title: "stored chat",
      name: "my-project",
      createdAt: Date.now(),
    });

    const found = await resolveStartSession(store, "/repo", {
      session: "my-project",
    });
    expect("start" in found && found.start.sessionId).toBe("cafe1234-0000");
    expect("start" in found && found.start.name).toBe("my-project");
  });

  it("--session surfaces a note when a name is shared by more than one session", async () => {
    const store = newStore();
    await store.createChatSession({
      id: "older-0000",
      workspacePath: "/repo",
      title: "older",
      name: "dup",
      createdAt: Date.now() - 1000,
    });
    await store.createChatSession({
      id: "newer-0000",
      workspacePath: "/repo",
      title: "newer",
      name: "dup",
      createdAt: Date.now(),
    });

    const found = await resolveStartSession(store, "/repo", {
      session: "dup",
    });
    expect("start" in found && found.start.sessionId).toBe("newer-0000");
    expect("note" in found && found.note).toContain(
      'Multiple sessions are named "dup"',
    );
  });
});

// --- the input-editor wiring (step 2) ----------------------------------------

/** A stand-in `InputManager` that hands back whatever the test primes it with. */
class FakeInputManager implements InputManager {
  readonly promptsSeen: string[] = [];
  nextRead: string | undefined | typeof INPUT_SIGINT = undefined;
  closed = false;

  async readMessage(
    promptText: string,
  ): Promise<string | undefined | typeof INPUT_SIGINT> {
    this.promptsSeen.push(promptText);
    return this.nextRead;
  }

  async question(): Promise<string | undefined | typeof INPUT_SIGINT> {
    return undefined;
  }

  async withSuspended<T>(fn: () => Promise<T>): Promise<T> {
    return await fn();
  }

  close(): void {
    this.closed = true;
  }
}

describe("inputManagerLineSource", () => {
  it("maps INPUT_SIGINT to SIGINT_LINE", async () => {
    const manager = new FakeInputManager();
    manager.nextRead = INPUT_SIGINT;
    const source: LineSource = inputManagerLineSource(manager);

    await expect(source.next("kapel> ")).resolves.toBe(SIGINT_LINE);
    expect(manager.promptsSeen).toEqual(["kapel> "]);
  });

  it("passes a typed message through unchanged", async () => {
    const manager = new FakeInputManager();
    manager.nextRead = "hello";
    const source = inputManagerLineSource(manager);

    await expect(source.next("kapel> ")).resolves.toBe("hello");
  });

  it("passes undefined through unchanged (close/EOF)", async () => {
    const manager = new FakeInputManager();
    manager.nextRead = undefined;
    const source = inputManagerLineSource(manager);

    await expect(source.next("kapel> ")).resolves.toBeUndefined();
  });

  it("close() delegates to the manager", () => {
    const manager = new FakeInputManager();
    inputManagerLineSource(manager).close();
    expect(manager.closed).toBe(true);
  });
});

describe("slashCompleter", () => {
  it("offers no completions for a line that isn't a slash command", () => {
    expect(slashCompleter("hello")).toEqual([[], "hello"]);
    expect(slashCompleter("")).toEqual([[], ""]);
  });

  it("narrows to commands matching the typed prefix", () => {
    const [hits, matched] = slashCompleter("/mo");
    expect(matched).toBe("/mo");
    expect(hits).toEqual(["/model"]);
  });

  it("offers the full command list for a bare slash or an unknown prefix", () => {
    const [bare] = slashCompleter("/");
    expect(bare).toContain("/help");
    expect(bare).toContain("/config");
    expect(bare).toContain("/orchestrate");

    const [unknown] = slashCompleter("/zzz");
    expect(unknown).toEqual(bare);
  });

  it("completes /model's argument against the built-in model catalog", () => {
    const [all, completeOn] = slashCompleter("/model ");
    expect(completeOn).toBe("");
    expect(all).toContain("claude-sonnet-5");
    expect(all).toContain("gpt-5.1");

    const [narrowed, partial] = slashCompleter("/model claude-o");
    expect(partial).toBe("claude-o");
    expect(narrowed.every((alias) => alias.startsWith("claude-o"))).toBe(true);
    expect(narrowed).toContain("claude-opus-5");
    expect(narrowed).not.toContain("claude-sonnet-5");
  });

  it("completes only the word under the cursor, not the whole line", () => {
    const [, completeOn] = slashCompleter("/model foo claude-");
    expect(completeOn).toBe("claude-");
  });

  it("offers nothing for commands with no finite argument vocabulary", () => {
    // `/resume` takes a session id (a property of the store, not of the
    // command) and `/orchestrate` takes free-form English.
    expect(slashCompleter("/resume ab")).toEqual([[], "/resume ab"]);
    expect(slashCompleter("/orchestrate ship it")).toEqual([
      [],
      "/orchestrate ship it",
    ]);
    expect(slashCompleter("/undo ")).toEqual([[], "/undo "]);
  });

  it("falls back to the whole vocabulary when the typed argument matches none", () => {
    const [hits] = slashCompleter("/model zzz");
    expect(hits).toContain("claude-sonnet-5");
  });

  it("appends custom command names after the built-ins", () => {
    const [bare] = slashCompleter("/", ["review", "ship-it"]);
    expect(bare).toEqual([
      "/help",
      "/exit",
      "/new",
      "/sessions",
      "/resume",
      "/name",
      "/fork",
      "/model",
      "/config",
      "/login",
      "/usage",
      "/stats",
      "/compact",
      "/undo",
      "/policy",
      "/plan",
      "/orchestrate",
      "/runs",
      "/resume-run",
      "/review",
      "/ship-it",
    ]);
  });

  it("narrows to a custom command name matching the typed prefix", () => {
    const [hits, matched] = slashCompleter("/rev", ["review"]);
    expect(matched).toBe("/rev");
    expect(hits).toEqual(["/review"]);
  });

  it("offers nothing for a custom command's arguments — free-form text", () => {
    expect(slashCompleter("/review foc", ["review"])).toEqual([
      [],
      "/review foc",
    ]);
  });
});

describe("createReplCompleter", () => {
  const files: FileLister = {
    list: () =>
      Promise.resolve(["apps/cli/src/input.ts", "apps/cli/src/render.ts"]),
    invalidate: () => undefined,
  };

  it("routes a mention token to the file completer, asynchronously", async () => {
    const completer = createReplCompleter(files);
    const result = completer("look at @clisrcinp");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual([
      ["@apps/cli/src/input.ts"],
      "@clisrcinp",
    ]);
  });

  it("routes a slash line to the slash completer, synchronously", () => {
    const completer = createReplCompleter(files);
    expect(completer("/mo")).toEqual([["/model"], "/mo"]);
  });

  it("reads custom command names through the getter, live on every call", () => {
    let names: readonly string[] = [];
    const completer = createReplCompleter(files, () => names);
    const [before] = completer("/rev") as [string[], string];
    expect(before).not.toContain("/review");

    // Names added after the completer was built (e.g. by a `/help` rescan)
    // are picked up on the next call, since the getter is re-read each time.
    names = ["review"];
    expect(completer("/rev")).toEqual([["/review"], "/rev"]);
  });

  it("lets @ win inside a slash command's arguments", async () => {
    const completer = createReplCompleter(files);
    await expect(completer("/orchestrate fix @clisrcren")).resolves.toEqual([
      ["@apps/cli/src/render.ts"],
      "@clisrcren",
    ]);
  });

  it("offers nothing for a plain sentence", () => {
    expect(createReplCompleter(files)("just talking")).toEqual([
      [],
      "just talking",
    ]);
  });

  it("falls back to slash completion when there is no file lister", () => {
    const completer = createReplCompleter();
    expect(completer("look at @clisrc")).toEqual([[], "look at @clisrc"]);
    expect(completer("/mo")).toEqual([["/model"], "/mo"]);
  });
});

describe("replCommandMenuEntries", () => {
  const shipIt: CustomCommand = {
    name: "ship-it",
    description: "cut a release",
    template: "ship it",
    sourcePath: ".agent/commands/ship-it.md",
  };

  it("says about each built-in exactly what /help says", async () => {
    // The menu is a view of the registry `/help` prints, not a second copy:
    // every name and every sentence has to be findable in the table.
    const h = await harness();
    const help = (await h.controller.handleLine("/help")).output.join("\n");
    const entries = replCommandMenuEntries();
    expect(entries.length).toBeGreaterThan(10);
    for (const entry of entries) {
      expect(help).toContain(entry.name);
      expect(help).toContain(entry.description);
    }
  });

  it("narrows to the /re… family, in registration order", () => {
    const names = filterCommandMenu(replCommandMenuEntries(), "/re").map(
      (entry) => entry.name,
    );
    expect(names).toEqual(["/resume", "/resume-run"]);
  });

  it("appends this session's custom commands after the built-ins", () => {
    const entries = replCommandMenuEntries([shipIt]);
    expect(entries.at(-1)).toEqual({
      name: "/ship-it",
      description: "cut a release",
    });
    expect(entries[0]?.name).toBe("/help");
  });

  it("falls back to the same '(no description)' /help prints", async () => {
    const undescribed: CustomCommand = {
      name: "quiet",
      template: "hush",
      sourcePath: ".agent/commands/quiet.md",
    };
    const source = customCommandsFixture({
      commands: [undescribed],
      warnings: [],
    });
    const h = await harness({ customCommands: source.load });
    const help = (await h.controller.handleLine("/help")).output.join("\n");

    const entry = replCommandMenuEntries([undescribed]).at(-1);
    expect(entry?.name).toBe("/quiet");
    expect(help).toContain(`/quiet  ${entry?.description}`);
  });

  it("hands the whole scanned commands to onCustomCommandsChanged", async () => {
    // Names alone would do for Tab; the menu needs the descriptions the scan
    // has already read, and this is the only callback that has them.
    const source = customCommandsFixture({
      commands: [shipIt],
      warnings: [],
    });
    const seen: (readonly CustomCommand[])[] = [];
    await harness({
      customCommands: source.load,
      onCustomCommandsChanged: (commands) => seen.push(commands),
    });
    expect(seen).toEqual([[shipIt]]);
  });
});

// --- small pure helpers -----------------------------------------------------

describe("interactive helpers", () => {
  it("invalidSessionName rejects empty and slash-prefixed names, accepts the rest", () => {
    expect(invalidSessionName("")).toContain("cannot be empty");
    expect(invalidSessionName("/resume")).toContain('cannot start with "/"');
    expect(invalidSessionName("my-project")).toBeUndefined();
  });

  it("formats cumulative and per-turn usage", () => {
    expect(
      usageTotalsLine({
        usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
        costUsd: 0,
      }),
    ).toBe("tokens — input: 10, output: 2, cached: 4");
    expect(
      usageDeltaLine(
        { usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 },
        { usage: { inputTokens: 3, outputTokens: 5 }, costUsd: 0.5 },
      ),
    ).toBe("tokens +2 in, +4 out  (~$0.5000)");
  });

  it("shortens ids to eight characters", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567");
  });

  it("instructionsBannerLine is undefined when nothing was loaded", () => {
    expect(instructionsBannerLine([])).toBeUndefined();
  });

  it("instructionsBannerLine comma-joins the sources that were loaded", () => {
    expect(instructionsBannerLine(["AGENTS.md"])).toBe(
      "instructions: AGENTS.md",
    );
    expect(instructionsBannerLine(["AGENTS.md", ".agent/AGENTS.md"])).toBe(
      "instructions: AGENTS.md, .agent/AGENTS.md",
    );
  });
});

// --- the shell around the controller ----------------------------------------

describe("runInteractive", () => {
  it("openChatStore creates .agent and its database without `kapel init`", async () => {
    const workspace = path.join(tempDir, "unconfigured-repo");
    await mkdir(workspace, { recursive: true });

    const store = await openChatStore(workspace);
    expect(store).toBeDefined();
    if (store !== undefined) openStores.push(store);
    expect(
      existsSync(defaultSessionDbPath(path.join(workspace, ".agent"))),
    ).toBe(true);
  });
});

describe("interactive REPL / streamed turn output", () => {
  /** The terminal `runInteractive` writes to: one stream, everything in order. */
  class Screen {
    readonly chunks: string[] = [];
    readonly isTTY = false;

    write(chunk: string): boolean {
      this.chunks.push(chunk);
      return true;
    }

    asStream(): NodeJS.WritableStream {
      return this as unknown as NodeJS.WritableStream;
    }

    get lines(): string[] {
      return this.chunks
        .join("")
        .split("\n")
        .filter((line) => line !== "");
    }
  }

  /**
   * A session that drives the renderer the way the real one does: the loop's
   * events go to the sink, and only the turn's *result* comes back to the
   * controller. This is exactly `runInteractive`'s wiring — events to the
   * `TextRenderer`, the controller's own lines through `renderer.line` — with
   * the provider replaced by a script.
   */
  class StreamingSession implements InteractiveSession {
    readonly #messages: ModelMessage[] = [];
    readonly #sink: EventSink;
    readonly #chunks: readonly string[];
    readonly #onSend: (() => void) | undefined;

    constructor(
      sink: EventSink,
      chunks: readonly string[],
      onSend?: () => void,
    ) {
      this.#sink = sink;
      this.#chunks = chunks;
      this.#onSend = onSend;
    }

    async send(instruction: string): Promise<ChatTurnResult> {
      this.#onSend?.();
      const text = this.#chunks.join("");
      const event = (type: string, data: unknown): AgentEvent => ({
        id: `evt-${type}`,
        runId: "run-1",
        timestamp: 0,
        type,
        data,
      });

      await this.#sink.emit(event("chat.turn.started", { turn: 1 }));
      await this.#sink.emit(event("loop.started", { agent: "agent" }));
      for (const chunk of this.#chunks) {
        await this.#sink.emit(
          event("model.text.delta", { text: chunk, iteration: 1 }),
        );
      }
      await this.#sink.emit(
        event("model.turn.completed", { text, toolCallCount: 0 }),
      );
      await this.#sink.emit(event("loop.completed", { status: "success" }));
      await this.#sink.emit(
        event("chat.turn.completed", { turn: 1, status: "success" }),
      );

      this.#messages.push({ role: "user", content: instruction });
      this.#messages.push({ role: "assistant", content: text });
      return {
        status: "success",
        summary: text,
        iterations: 1,
        toolCalls: 0,
      };
    }

    messages(): readonly ModelMessage[] {
      return this.#messages.slice();
    }
  }

  it("streams the assistant text and only then prints the turn's own lines", async () => {
    const screen = new Screen();
    const renderer = new TextRenderer(screen.asStream());
    const usage = new FakeUsage();

    const harnessed = await harness({
      store: undefined,
      createSession: () =>
        new StreamingSession(renderer, ["Hello, ", "world", "."], () => {
          usage.inputTokens = 12;
          usage.outputTokens = 4;
        }),
      write: (line) => {
        renderer.line(line);
      },
      usage,
    });

    const result = await harnessed.controller.handleLine("hi");

    // The reply arrived a chunk at a time...
    expect(screen.chunks.slice(0, 3)).toEqual(["Hello, ", "world", "."]);
    // ...on its own line, with the REPL's usage line under it rather than
    // glued to the end of it.
    expect(screen.lines).toEqual(["Hello, world.", "tokens +12 in, +4 out"]);
    expect(result.output).toEqual(["tokens +12 in, +4 out"]);
  });

  it("puts no control characters on a non-TTY screen", async () => {
    const screen = new Screen();
    const renderer = new TextRenderer(screen.asStream());
    const harnessed = await harness({
      store: undefined,
      createSession: () => new StreamingSession(renderer, ["ok"]),
      write: (line) => {
        renderer.line(line);
      },
    });

    await harnessed.controller.handleLine("hi");

    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the assertion.
    expect(/[\u0000-\u0008\u000b-\u001f]/.test(screen.chunks.join(""))).toBe(
      false,
    );
  });
});

describe("chatUsageBreakdown", () => {
  const native = new Map<string, UsageBreakdown>([
    [
      "claude-sonnet-5",
      {
        key: "claude-sonnet-5",
        usage: { inputTokens: 100, outputTokens: 20 },
        costUsd: 0.001,
        pricing: "known",
        models: ["claude-sonnet-5"],
        agents: ["agent"],
        tasks: [UNATTRIBUTED],
        samples: 1,
      },
    ],
  ]);

  function totals(
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): UsageTotals {
    return { usage: { inputTokens, outputTokens }, costUsd };
  }

  it("adds one bucket per delegating backend that spent something", () => {
    const merged = chatUsageBreakdown(native, [
      { label: "claude-code", totals: totals(300, 40, 0) },
      { label: "codex", totals: totals(0, 0, 0) },
    ]);

    expect([...merged.keys()]).toEqual(["claude-sonnet-5", "claude-code"]);
    const delegated = merged.get("claude-code");
    expect(delegated?.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
    // No reported cost means unknown, not free.
    expect(delegated?.pricing).toBe("unknown");
  });

  it("trusts a cost the backend itself reported", () => {
    const merged = chatUsageBreakdown(native, [
      { label: "claude-code", totals: totals(300, 40, 0.25) },
    ]);
    expect(merged.get("claude-code")?.pricing).toBe("known");
    expect(merged.get("claude-code")?.costUsd).toBe(0.25);
  });

  it("leaves the native breakdown untouched", () => {
    const merged = chatUsageBreakdown(native, []);
    expect([...merged.keys()]).toEqual(["claude-sonnet-5"]);
    expect(native.size).toBe(1);
  });
});
