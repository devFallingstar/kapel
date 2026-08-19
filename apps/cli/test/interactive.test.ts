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
  UsageTotals,
} from "@agent/ai";
import type { ChatTurnResult } from "@agent/coding-agent";
import { defaultSessionDbPath, SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InteractiveController,
  InteractiveControllerDeps,
  InteractiveSession,
  InteractiveStart,
  SessionFactoryArgs,
} from "../src/interactive.js";
import {
  createInteractiveController,
  matchChatSession,
  openChatStore,
  resolveStartSession,
  runInteractive,
  shortId,
  usageDeltaLine,
  usageTotalsLine,
} from "../src/interactive.js";
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
  readonly #messages: ModelMessage[] = [];
  status: ChatTurnResult["status"] = "success";
  failWith: Error | undefined;
  /** Runs inside `send`, so a test can make a turn consume tokens. */
  onSend: (() => void) | undefined;

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
}

/** A usage source the controller can diff, advanced by hand between turns. */
class FakeUsage {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;

  totals(): UsageTotals {
    return {
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      costUsd: this.costUsd,
    };
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
