import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import type { AgentEvent, EventSink } from "@agent/protocol";
import { defaultSessionDbPath, SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputManager } from "../src/input.js";
import { INPUT_SIGINT } from "../src/input.js";
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
  inputManagerLineSource,
  instructionsBannerLine,
  matchChatSession,
  openChatStore,
  resolveStartSession,
  runInteractive,
  SIGINT_LINE,
  shortId,
  slashCompleter,
  usageDeltaLine,
  usageTotalsLine,
} from "../src/interactive.js";
import { TextRenderer } from "../src/render.js";
import type { ResolvedModel } from "../src/run.js";

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
  ): Promise<ChatTurnResult> {
    this.sends.push({ instruction, runId: context.runId });
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
      "/usage",
      "/compact",
      "/orchestrate",
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
});

// --- small pure helpers -----------------------------------------------------

describe("interactive helpers", () => {
  it("matchChatSession prefers an exact id over a prefix", () => {
    const records = [
      {
        id: "ab",
        workspacePath: "/r",
        title: "short",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      },
      {
        id: "abc",
        workspacePath: "/r",
        title: "long",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      },
    ];
    const matched = matchChatSession(records, "ab");
    expect("record" in matched && matched.record.title).toBe("short");
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
  it("refuses --json and points at the one-shot form", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    try {
      const code = await runInteractive({
        cwd: tempDir,
        maxIterations: 4,
        yes: false,
        json: true,
      });
      expect(code).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toContain(
      "--json is not supported in interactive mode",
    );
  });

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
