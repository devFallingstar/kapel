import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelMessage, UsageTotals } from "@agent/ai";
import type {
  BackendTurnRequest,
  BackendTurnRunner,
  ClaudeCodeBackendOptions,
  DelegatingBackendLike,
} from "@agent/coding-agent";
import { SqliteSessionStore } from "@agent/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KapelConfig } from "../src/config.js";
import { KAPEL_CONFIG_VERSION } from "../src/config.js";
import {
  claudeCodeTurnRunner,
  createDelegatedChatSession,
  DelegatedUsage,
} from "../src/delegated-chat.js";
import type {
  ChatLike,
  InteractiveController,
  InteractiveControllerDeps,
  InteractiveStart,
  SessionFactoryArgs,
} from "../src/interactive.js";
import {
  approvalsLine,
  bannerModel,
  createInteractiveController,
  sumTotals,
} from "../src/interactive.js";
import type { ResolvedModel } from "../src/run.js";

// --- fixtures ---------------------------------------------------------------

/** A backend stand-in that records how it was built and what it was asked. */
interface RecordedBackend {
  readonly options: ClaudeCodeBackendOptions;
  readonly prompts: { instruction: string; context?: readonly string[] }[];
}

function fakeClaudeCodeBackends(sessionIds: readonly string[]): {
  readonly built: RecordedBackend[];
  readonly create: (options: ClaudeCodeBackendOptions) => DelegatingBackendLike;
} {
  const built: RecordedBackend[] = [];
  return {
    built,
    create: (options) => {
      const record: RecordedBackend = { options, prompts: [] };
      built.push(record);
      return {
        run: async (input) => {
          record.prompts.push(input);
          const sessionId = sessionIds[built.length - 1];
          return {
            status: "success" as const,
            summary: `handled ${input.instruction}`,
            output: `reply to ${input.instruction}`,
            ...(sessionId === undefined ? {} : { sessionId }),
            usage: { inputTokens: 10, outputTokens: 4 },
            costUsd: 0.001,
          };
        },
      };
    },
  };
}

/** A runner that records every request and answers with a canned reply. */
function recordingRunner(requests: BackendTurnRequest[]): BackendTurnRunner {
  return async (request) => {
    requests.push(request);
    return {
      status: "success",
      summary: `handled ${request.instruction}`,
      output: `reply to ${request.instruction}`,
      sessionRef: "backend-session-1",
      usage: { inputTokens: 7, outputTokens: 3 },
      costUsd: 0.002,
    };
  };
}

let tempDir: string;
let openStores: SqliteSessionStore[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "kapel-delegated-"));
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

// --- the Claude Code continuation helper ------------------------------------

describe("claudeCodeTurnRunner", () => {
  it("runs the first turn plain and later turns with --resume and no transcript", async () => {
    const { built, create } = fakeClaudeCodeBackends(["sess-abc"]);
    const chat = createDelegatedChatSession({
      backend: "claude-code",
      workspacePath: "/repo",
      runId: "run-1",
      createClaudeCodeBackend: create,
    });

    await chat.send("first");
    await chat.send("second");

    expect(built).toHaveLength(2);
    // First turn: no --resume, and the (empty) transcript carried nothing.
    expect(built[0]?.options.extraArgs).toBeUndefined();
    expect(built[0]?.prompts[0]?.context).toBeUndefined();
    // Second turn: the backend's own session id, and nothing re-sent.
    expect(built[1]?.options.extraArgs).toEqual(["--resume", "sess-abc"]);
    expect(built[1]?.prompts[0]?.context).toBeUndefined();
    expect(built[1]?.prompts[0]?.instruction).toBe("second");
    expect(chat.sessionRef()).toBe("sess-abc");
  });

  it("replays the stored transcript on the first turn of a resumed conversation", async () => {
    const { built, create } = fakeClaudeCodeBackends(["sess-xyz"]);
    const chat = createDelegatedChatSession({
      backend: "claude-code",
      workspacePath: "/repo",
      runId: "run-1",
      messages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
      createClaudeCodeBackend: create,
    });

    await chat.send("follow up");

    const context = built[0]?.prompts[0]?.context ?? [];
    expect(context.join("\n")).toContain("earlier question");
    expect(context.join("\n")).toContain("earlier answer");
    expect(built[0]?.options.extraArgs).toBeUndefined();
  });

  it("forwards the model and keeps it across a resumed turn", async () => {
    const { built, create } = fakeClaudeCodeBackends(["s1"]);
    const runner = claudeCodeTurnRunner({
      model: "opus",
      createBackend: create,
    });

    await runner({
      instruction: "one",
      transcript: [],
      context: { runId: "r", workspacePath: "/repo" },
    });
    await runner({
      instruction: "two",
      transcript: [],
      sessionRef: "s1",
      context: { runId: "r", workspacePath: "/repo" },
    });

    expect(built[0]?.options.model).toBe("opus");
    expect(built[1]?.options.model).toBe("opus");
    expect(built[1]?.options.extraArgs).toEqual(["--resume", "s1"]);
  });
});

describe("createDelegatedChatSession — codex", () => {
  it("stays stateless: every turn carries the transcript, never a session id", async () => {
    const requests: BackendTurnRequest[] = [];
    const chat = createDelegatedChatSession({
      backend: "codex",
      workspacePath: "/repo",
      runId: "run-1",
      runner: recordingRunner(requests),
    });

    await chat.send("first");
    await chat.send("second");

    expect(requests[0]?.transcript).toEqual([]);
    expect(requests[1]?.sessionRef).toBeUndefined();
    expect(requests[1]?.transcript.map((entry) => entry.content)).toEqual([
      "first",
      "reply to first",
    ]);
  });
});

// --- the controller over a delegated session --------------------------------

interface DelegatedHarness {
  readonly controller: InteractiveController;
  readonly store: SqliteSessionStore;
  readonly written: string[];
  readonly requests: BackendTurnRequest[];
  readonly built: SessionFactoryArgs[];
  readonly usage: DelegatedUsage;
}

function freshStart(id: string): InteractiveStart {
  return { sessionId: id, title: "", persisted: false, messages: [] };
}

async function delegatedHarness(
  overrides: Partial<InteractiveControllerDeps> = {},
): Promise<DelegatedHarness> {
  const store = new SqliteSessionStore({
    path: path.join(tempDir, "sessions.db"),
  });
  openStores.push(store);

  const written: string[] = [];
  const requests: BackendTurnRequest[] = [];
  const built: SessionFactoryArgs[] = [];
  const usage = new DelegatedUsage();

  const createSession = (args: SessionFactoryArgs): ChatLike => {
    built.push(args);
    const chat = createDelegatedChatSession({
      backend: args.backend === "native" ? "codex" : args.backend,
      workspacePath: "/repo",
      runId: args.sessionId,
      messages: args.messages,
      runner: recordingRunner(requests),
      ...(args.sessionRef === undefined ? {} : { sessionRef: args.sessionRef }),
    });
    return {
      send: async (instruction) => {
        const result = await chat.send(instruction);
        usage.add(result);
        return result;
      },
      toModelMessages: () => chat.toModelMessages(),
      sessionRef: () => chat.sessionRef(),
    };
  };

  const controller = await createInteractiveController({
    workspacePath: path.join(tempDir, "repo"),
    store,
    createSession,
    write: (line) => written.push(line),
    backend: "claude-code",
    modelAlias: "opus",
    start: freshStart("22222222-bbbb-4bbb-8bbb-000000000002"),
    usage,
    resolveModel: async (alias): Promise<ResolvedModel> =>
      alias === "claude-sonnet-5"
        ? {
            model: {
              provider: "anthropic",
              id: "claude-sonnet-5-x",
              capabilities: {
                tools: true,
                reasoning: false,
                vision: false,
                structuredOutput: true,
              },
            },
            provider: {
              id: "anthropic",
              supports: () => true,
              // biome-ignore lint/correctness/useYield: never called in these tests.
              stream: async function* () {
                throw new Error("unreachable");
              },
            },
          }
        : { error: `Unknown model alias "${alias}".` },
    ...overrides,
  });

  return { controller, store, written, requests, built, usage };
}

describe("interactive controller — delegated backend", () => {
  it("runs a turn through the backend runner and persists it like a native one", async () => {
    const h = await delegatedHarness();
    await h.controller.handleLine("fix the failing test");

    expect(h.requests.map((request) => request.instruction)).toEqual([
      "fix the failing test",
    ]);

    const loaded = await h.store.loadChatSession(h.controller.sessionId());
    expect(loaded?.record.title).toBe("fix the failing test");
    expect(loaded?.messages).toEqual([
      { role: "user", content: "fix the failing test" },
      { role: "assistant", content: "reply to fix the failing test" },
    ]);
    // The backend's own usage is what the per-turn line reports.
    expect(h.written.at(-1)).toBe("tokens +7 in, +3 out  (~$0.0020)");
  });

  it("builds every session with the conversation id as its run id", async () => {
    const h = await delegatedHarness();
    await h.controller.handleLine("hello");
    expect(h.built[0]?.sessionId).toBe(h.controller.sessionId());
    expect(h.built[0]?.backend).toBe("claude-code");
  });

  it("/model switches without consulting the native registry", async () => {
    const h = await delegatedHarness();
    await h.controller.handleLine("hello");

    const switched = await h.controller.handleLine("/model haiku");
    expect(switched.effect).toBe("model-changed");
    expect(switched.output).toEqual([
      "model switched to haiku — future turns use it.",
    ]);
    expect(h.controller.modelAlias()).toBe("haiku");

    // The rebuild kept both the transcript and the backend's own session.
    const rebuilt = h.built.at(-1);
    expect(rebuilt?.modelAlias).toBe("haiku");
    expect(rebuilt?.sessionRef).toBe("backend-session-1");
    expect(rebuilt?.messages).toHaveLength(2);

    expect((await h.controller.handleLine("/model")).output).toEqual([
      "model: haiku (claude-code)",
    ]);
  });

  it("/new drops the backend's session so the next turn starts a fresh one", async () => {
    const h = await delegatedHarness();
    await h.controller.handleLine("hello");
    await h.controller.handleLine("/new");
    expect(h.built.at(-1)?.sessionRef).toBeUndefined();
    expect(h.built.at(-1)?.messages).toEqual([]);
  });

  it("says the delegating CLI owns approvals in the banner", async () => {
    const h = await delegatedHarness();
    const banner = h.controller.banner("/repo").join("\n");
    expect(banner).toContain("claude-code · opus");
    expect(banner).toContain("approvals are enforced by the Claude Code CLI");
  });

  it("/compact reports itself unsupported instead of erroring", async () => {
    const h = await delegatedHarness();
    await h.controller.handleLine("hello");

    const result = await h.controller.handleLine("/compact");
    expect(result.output).toEqual([
      "/compact is not supported with the Claude Code backend.",
    ]);
  });

  it("/compact names Codex when that is the live backend", async () => {
    const h = await delegatedHarness({ backend: "codex" });
    await h.controller.handleLine("hello");

    const result = await h.controller.handleLine("/compact");
    expect(result.output).toEqual([
      "/compact is not supported with the Codex backend.",
    ]);
  });
});

// --- /config ----------------------------------------------------------------

function savedConfig(overrides: Partial<KapelConfig> = {}): KapelConfig {
  return {
    version: KAPEL_CONFIG_VERSION,
    backend: "native",
    models: {
      orchestrator: "claude-sonnet-5",
      complex: "claude-sonnet-5",
      middle: "claude-sonnet-5",
      low: "claude-sonnet-5",
    },
    updatedAt: 3,
    ...overrides,
  };
}

describe("interactive controller — /config", () => {
  it("applies a new backend and model to the live conversation", async () => {
    const h = await delegatedHarness({
      configure: async () => savedConfig(),
    });
    await h.controller.handleLine("hello");

    const result = await h.controller.handleLine("/config");
    expect(result.effect).toBe("config-changed");
    expect(result.output).toEqual([
      "backend claude-code → native, model opus → claude-sonnet-5 — future turns use it.",
    ]);
    expect(h.controller.backend()).toBe("native");
    expect(h.controller.modelAlias()).toBe("claude-sonnet-5");

    // The conversation survived the switch; the backend's session id did not.
    const rebuilt = h.built.at(-1);
    expect(rebuilt?.backend).toBe("native");
    expect(rebuilt?.messages).toHaveLength(2);
    expect(rebuilt?.sessionRef).toBeUndefined();
  });

  it("says nothing changed when the answers match the live session", async () => {
    const h = await delegatedHarness({
      configure: async () =>
        savedConfig({
          backend: "claude-code",
          models: {
            orchestrator: "opus",
            complex: "opus",
            middle: "sonnet",
            low: "haiku",
          },
        }),
    });
    const built = h.built.length;
    const result = await h.controller.handleLine("/config");
    expect(result.output).toEqual(["config unchanged."]);
    expect(result.effect).toBeUndefined();
    expect(h.built).toHaveLength(built);
  });

  it("keeps the current backend when the new native model cannot be resolved", async () => {
    const h = await delegatedHarness({
      configure: async () =>
        savedConfig({
          models: {
            orchestrator: "nonsense",
            complex: "nonsense",
            middle: "nonsense",
            low: "nonsense",
          },
        }),
    });
    const result = await h.controller.handleLine("/config");
    expect(result.output[0]).toBe('Unknown model alias "nonsense".');
    expect(h.controller.backend()).toBe("claude-code");
  });

  it("needs a terminal", async () => {
    const h = await delegatedHarness();
    expect((await h.controller.handleLine("/config")).output).toEqual([
      "/config needs a terminal — run `kapel config` from one.",
    ]);
  });

  it("is listed in /help", async () => {
    const h = await delegatedHarness();
    expect(
      (await h.controller.handleLine("/help")).output.join("\n"),
    ).toContain("/config");
  });
});

// --- small helpers ----------------------------------------------------------

describe("delegated helpers", () => {
  it("sums usage across both engines", () => {
    const delegated = new DelegatedUsage();
    delegated.add({ usage: { inputTokens: 5, outputTokens: 2 }, costUsd: 0.5 });
    const native = {
      totals: (): UsageTotals => ({
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 3 },
        costUsd: 0.25,
      }),
    };
    expect(sumTotals(native, delegated)).toEqual({
      usage: { inputTokens: 6, outputTokens: 3, cachedInputTokens: 3 },
      costUsd: 0.75,
    });
  });

  it("names the delegating CLI in the banner and the approvals line", () => {
    expect(bannerModel("native", "claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(bannerModel("codex", "default")).toBe("codex · default");
    expect(approvalsLine("codex")).toContain("Codex CLI");
    expect(approvalsLine("claude-code")).toContain("Claude Code CLI");
  });

  it("keeps a delegated transcript in the shape the store persists", () => {
    const chat = createDelegatedChatSession({
      backend: "codex",
      workspacePath: "/repo",
      runId: "r",
      messages: [{ role: "user", content: "hi" }] as readonly ModelMessage[],
      runner: async () => ({ status: "success", summary: "ok" }),
    });
    expect(chat.toModelMessages()).toEqual([{ role: "user", content: "hi" }]);
  });
});
