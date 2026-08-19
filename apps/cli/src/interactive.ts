import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import type {
  ModelDefinition,
  ModelMessage,
  ModelProvider,
  UsageTotals,
} from "@agent/ai";
import { UsageTracker } from "@agent/ai";
import type { AgentLoopRunContext, ChatTurnResult } from "@agent/coding-agent";
import {
  AgentChatSession,
  builtinTools,
  ClaudeCodeBackend,
  CodexBackend,
  PermissionEngine,
} from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import type {
  ChatSessionRecord,
  ChatSessionTranscript,
  ListChatSessionsOptions,
  NewChatSession,
  PersistedChatMessage,
} from "@agent/session";
import {
  chatTitleFrom,
  defaultSessionDbPath,
  SqliteSessionStore,
} from "@agent/session";
import type { BackendName } from "./backend.js";
import {
  claudeCodeInstallGuidance,
  claudeCodeLoginGuidance,
  codexInstallGuidance,
  codexLoginGuidance,
  isDelegatedBackend,
} from "./backend.js";
import type { KapelConfig } from "./config.js";
import {
  checkBackendAvailability,
  delegatedModelOverride,
  resolveBackendSetting,
  resolveOrchestratorModel,
  ttyWizardPrompt,
} from "./config-runtime.js";
import { runConfigWizard } from "./config-wizard.js";
import {
  createDelegatedChatSession,
  DelegatedUsage,
} from "./delegated-chat.js";
import { loadDotEnvFile } from "./env.js";
import { createHistoryAppender, loadHistory } from "./history.js";
import {
  createInputManager,
  INPUT_SIGINT,
  type InputManager,
} from "./input.js";
import { composeSystemPrompt, loadInstructions } from "./instructions.js";
import type { OrchestrateCommandOptions } from "./orchestrate.js";
import {
  DEFAULT_ISOLATION,
  DEFAULT_WORKER_MODE,
  runOrchestrate,
} from "./orchestrate.js";
import { DEFAULT_PERMISSIONS } from "./permissions.js";
import { formatTable } from "./plan.js";
import type { PromptState } from "./prompter.js";
import { createPrompter, createPromptState } from "./prompter.js";
import { TextRenderer } from "./render.js";
import type { ResolvedModel } from "./run.js";
import {
  agentLoopOptions,
  defaultSystemPrompt,
  resolveModelAndProvider,
} from "./run.js";
import { isoTime } from "./sessions.js";

/**
 * The CLI's version, shown by `--version` and in the interactive banner. Kept
 * here so both spellings of it come from one place.
 */
export const CLI_VERSION = "0.4.0";

/** How many characters of a session id identify it in listings and the banner. */
const SHORT_ID = 8;

/** How many sessions `/sessions` lists at once. */
const SESSIONS_LIMIT = 20;

/** The short id a session is displayed and matched by. */
export function shortId(id: string): string {
  return id.slice(0, SHORT_ID);
}

// --- The conversation the controller drives ---------------------------------

/**
 * The half of {@link AgentChatSession} the controller uses. Narrow on purpose:
 * it is what lets the tests drive the controller with a recording stand-in
 * instead of a live provider.
 */
export interface InteractiveSession {
  send(
    instruction: string,
    context: AgentLoopRunContext,
  ): Promise<ChatTurnResult>;
  messages(): readonly ModelMessage[];
  /**
   * Forces an immediate compaction pass over this session's history, ignoring
   * the auto-compaction threshold. Backs `/compact`; absent (as it is on any
   * fake that doesn't declare it) means `/compact` has nothing to call and
   * reports itself unsupported. See `AgentChatSession.compactNow`.
   */
  compactNow?(
    context: AgentLoopRunContext,
  ): Promise<{ elided: number; savedChars: number }>;
}

/** What one turn reports back, for either kind of conversation. */
export interface ChatTurnLike {
  readonly status: ChatTurnResult["status"];
  readonly summary: string;
  readonly output?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly costUsd?: number;
}

/**
 * The conversation as the controller sees it, whichever engine is behind it.
 *
 * The native `AgentChatSession` keeps `ModelMessage[]` and a provider; a
 * `BackendChatSession` keeps user/assistant entries and an external CLI. Both
 * can answer "run this turn" and "give me the transcript in the shape the
 * store persists", and that is the whole of what `/new`, `/resume`, `/model`,
 * `/config` and the snapshot writer need — so everything below this line is
 * written once and works for both.
 */
export interface ChatLike {
  send(
    instruction: string,
    context: AgentLoopRunContext,
  ): Promise<ChatTurnLike>;
  toModelMessages(): readonly ModelMessage[];
  /** A delegating backend's own session id, when it is holding the thread. */
  sessionRef?(): string | undefined;
  /**
   * Forces an immediate compaction pass; see {@link InteractiveSession.compactNow}.
   * A delegated backend has none — the external CLI owns its own context
   * management — which is exactly how `/compact` tells the two apart.
   */
  compactNow?(
    context: AgentLoopRunContext,
  ): Promise<{ elided: number; savedChars: number }>;
}

/** Either shape a session factory may return. */
export type InteractiveSessionLike = InteractiveSession | ChatLike;

/** Adapts the native session's `messages()` to {@link ChatLike}. */
export function toChatLike(session: InteractiveSessionLike): ChatLike {
  if ("toModelMessages" in session) return session;
  return {
    send: (instruction, context) => session.send(instruction, context),
    toModelMessages: () => session.messages(),
    ...(session.compactNow === undefined
      ? {}
      : {
          compactNow: (context: AgentLoopRunContext) =>
            // biome-ignore lint/style/noNonNullAssertion: narrowed by the check above.
            session.compactNow!(context),
        }),
  };
}

export interface SessionFactoryArgs {
  /** The conversation's id — a delegated turn runs under it as its run id. */
  readonly sessionId: string;
  /** Which engine to build: the native loop, or a delegating CLI. */
  readonly backend: BackendName;
  readonly modelAlias: string;
  /** Absent for a delegated backend, which resolves no catalog model. */
  readonly model?: ModelDefinition;
  readonly provider?: ModelProvider;
  /** History to rebuild from — empty for a brand new conversation. */
  readonly messages: readonly ModelMessage[];
  /** The delegating backend's session id, when one is being carried over. */
  readonly sessionRef?: string;
}

/** Builds (or rebuilds) the conversation. Overridable in tests. */
export type InteractiveSessionFactory = (
  args: SessionFactoryArgs,
) => InteractiveSessionLike | Promise<InteractiveSessionLike>;

// --- The store the controller persists through ------------------------------

/**
 * The chat half of `SqliteSessionStore`, structurally. Tests hand the
 * controller a real store over a temp database; nothing here needs a fake.
 */
export interface ChatStore {
  createChatSession(session: NewChatSession): Promise<void>;
  appendChatMessages(
    sessionId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void>;
  setChatSessionTitle(sessionId: string, title: string): Promise<void>;
  listChatSessions(
    workspacePath?: string,
    options?: ListChatSessionsOptions,
  ): Promise<readonly ChatSessionRecord[]>;
  loadChatSession(
    sessionId: string,
  ): Promise<ChatSessionTranscript | undefined>;
}

// --- Dispatch results -------------------------------------------------------

/**
 * What the shell has to do about a dispatched line, beyond printing its
 * output. Everything other than `exit` is informational — the REPL keeps
 * going — but naming them keeps the tests honest about which branch ran.
 */
export type InteractiveEffect =
  | "exit"
  | "new-session"
  | "resumed"
  | "model-changed"
  | "config-changed";

export interface DispatchResult {
  /** The lines this line produced, in order. Already written via `deps.write`. */
  readonly output: readonly string[];
  readonly effect?: InteractiveEffect;
}

// --- Session selection (--continue / --session / /resume) -------------------

/** Where a REPL starts from: a fresh conversation, or a stored one revived. */
export interface InteractiveStart {
  readonly sessionId: string;
  readonly title: string;
  /** True when a row for this id already exists in the store. */
  readonly persisted: boolean;
  readonly messages: readonly ModelMessage[];
}

export interface StartSelector {
  /** `--continue`: pick the most recently updated session for this workspace. */
  readonly continue?: boolean;
  /** `--session <id>`: pick this one, by full id or unique prefix. */
  readonly session?: string;
}

export type StartResolution =
  | { readonly start: InteractiveStart }
  | { readonly error: string };

function availableSessionsHint(records: readonly ChatSessionRecord[]): string {
  if (records.length === 0) return "";
  const listed = records
    .slice(0, SESSIONS_LIMIT)
    .map((record) => shortId(record.id))
    .join(", ");
  return ` Available: ${listed}.`;
}

/**
 * Resolves a session reference against the stored sessions of one workspace.
 *
 * Prefix matching is deliberate: the ids users see are the short ones, so the
 * ids they type are short too. An ambiguous prefix is an error rather than a
 * "first match wins" guess — resuming the wrong conversation is not something
 * the user would notice until they had already talked to it.
 */
export function matchChatSession(
  records: readonly ChatSessionRecord[],
  reference: string,
): { readonly record: ChatSessionRecord } | { readonly error: string } {
  const exact = records.find((record) => record.id === reference);
  if (exact !== undefined) return { record: exact };

  const matches = records.filter((record) => record.id.startsWith(reference));
  const first = matches[0];
  if (first === undefined) {
    return {
      error: `No chat session matches "${reference}".${availableSessionsHint(records)}`,
    };
  }
  if (matches.length > 1) {
    const ids = matches.map((record) => shortId(record.id)).join(", ");
    return {
      error: `"${reference}" matches ${matches.length} sessions: ${ids}. Use a longer prefix.`,
    };
  }
  return { record: first };
}

function startFrom(transcript: ChatSessionTranscript): InteractiveStart {
  return {
    sessionId: transcript.record.id,
    title: transcript.record.title,
    persisted: true,
    messages: transcript.messages,
  };
}

/**
 * Decides which conversation this invocation opens: a new one, the most
 * recently touched one (`--continue`), or a named one (`--session`).
 *
 * Both resume flags need somewhere to resume *from*, so asking for one
 * without persistence — or in a workspace that has never recorded a chat — is
 * an error the CLI reports instead of silently starting a new conversation.
 */
export async function resolveStartSession(
  store: ChatStore | undefined,
  workspacePath: string,
  selector: StartSelector,
  newId: () => string = () => crypto.randomUUID(),
): Promise<StartResolution> {
  const wantsResume =
    selector.continue === true || selector.session !== undefined;
  if (!wantsResume) {
    return {
      start: { sessionId: newId(), title: "", persisted: false, messages: [] },
    };
  }

  if (store === undefined) {
    return {
      error:
        "--continue and --session need the session database, which --no-save disables. Drop --no-save to resume a conversation.",
    };
  }

  const records = await store.listChatSessions(workspacePath);

  if (selector.session !== undefined) {
    const matched = matchChatSession(records, selector.session);
    if ("error" in matched) return { error: matched.error };
    const transcript = await store.loadChatSession(matched.record.id);
    if (transcript === undefined) {
      return { error: `Chat session ${matched.record.id} could not be read.` };
    }
    return { start: startFrom(transcript) };
  }

  const latest = records[0];
  if (latest === undefined) {
    return {
      error: `No chat sessions recorded for ${workspacePath} yet — run \`kapel\` without --continue to start one.`,
    };
  }
  const transcript = await store.loadChatSession(latest.id);
  if (transcript === undefined) {
    return { error: `Chat session ${latest.id} could not be read.` };
  }
  return { start: startFrom(transcript) };
}

// --- Usage formatting -------------------------------------------------------

/** Adds two usage sources into one total — see the two engines in `runInteractive`. */
export function sumTotals(
  ...sources: readonly { totals(): UsageTotals }[]
): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | undefined;
  let costUsd = 0;
  for (const source of sources) {
    const totals = source.totals();
    inputTokens += totals.usage.inputTokens;
    outputTokens += totals.usage.outputTokens;
    if (totals.usage.cachedInputTokens !== undefined) {
      cachedInputTokens =
        (cachedInputTokens ?? 0) + totals.usage.cachedInputTokens;
    }
    costUsd += totals.costUsd;
  }
  return {
    usage: {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    },
    costUsd,
  };
}

/** `tokens — input: …, output: …[, cached: …][  (~$…)]` — the cumulative view. */
export function usageTotalsLine(totals: UsageTotals): string {
  const parts = [
    `input: ${totals.usage.inputTokens}`,
    `output: ${totals.usage.outputTokens}`,
  ];
  if (totals.usage.cachedInputTokens !== undefined) {
    parts.push(`cached: ${totals.usage.cachedInputTokens}`);
  }
  const line = `tokens — ${parts.join(", ")}`;
  return totals.costUsd > 0
    ? `${line}  (~$${totals.costUsd.toFixed(4)})`
    : line;
}

/** What one turn cost, as a difference between two cumulative snapshots. */
export function usageDeltaLine(
  before: UsageTotals,
  after: UsageTotals,
): string {
  const input = after.usage.inputTokens - before.usage.inputTokens;
  const output = after.usage.outputTokens - before.usage.outputTokens;
  const cost = after.costUsd - before.costUsd;
  const line = `tokens +${input} in, +${output} out`;
  return cost > 0 ? `${line}  (~$${cost.toFixed(4)})` : line;
}

// --- The controller ---------------------------------------------------------

export interface InteractiveControllerDeps {
  readonly workspacePath: string;
  /** Absent under `--no-save`: nothing is recorded and resume is unavailable. */
  readonly store?: ChatStore;
  readonly createSession: InteractiveSessionFactory;
  /** Every produced line goes here, in order. */
  readonly write: (line: string) => void;
  /** Which engine the conversation runs on. Defaults to `native`. */
  readonly backend?: BackendName;
  readonly modelAlias: string;
  /** The resolved catalog model — absent on a delegated backend. */
  readonly model?: ModelDefinition;
  readonly provider?: ModelProvider;
  /** Where the conversation starts; see {@link resolveStartSession}. */
  readonly start: InteractiveStart;
  /** Cumulative usage across every turn of this process. */
  readonly usage: { totals(): UsageTotals };
  /** Resolves a `/model <alias>` switch. Defaults to the real registry. */
  readonly resolveModel?: (alias: string) => Promise<ResolvedModel>;
  /** Runs `/orchestrate <objective>`; absent means the command is unavailable. */
  readonly orchestrate?: (objective: string) => Promise<number>;
  /**
   * Runs `/config` — the setup wizard — and returns the saved configuration,
   * or `undefined` when it was cancelled. Absent means there is no terminal to
   * run it on, and `/config` says so instead.
   */
  readonly configure?: () => Promise<KapelConfig | undefined>;
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** The REPL's brain: everything a typed line can do, with no terminal in sight. */
export interface InteractiveController {
  sessionId(): string;
  title(): string;
  modelAlias(): string;
  /** Which engine the live conversation runs on. */
  backend(): BackendName;
  /** The live conversation — the object `send` is called on. */
  session(): InteractiveSessionLike;
  /** The banner the shell prints before the first prompt. */
  banner(cwd: string): readonly string[];
  handleLine(line: string, signal?: AbortSignal): Promise<DispatchResult>;
}

interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly help: string;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", usage: "/help", help: "show this list" },
  { name: "exit", usage: "/exit", help: "leave the session (alias: /quit)" },
  { name: "new", usage: "/new", help: "start a fresh conversation here" },
  {
    name: "sessions",
    usage: "/sessions",
    help: "list this directory's conversations",
  },
  {
    name: "resume",
    usage: "/resume <id>",
    help: "switch to a stored conversation",
  },
  {
    name: "model",
    usage: "/model [alias]",
    help: "show or switch the model for future turns",
  },
  {
    name: "config",
    usage: "/config",
    help: "re-run setup (backend and models) and apply it here",
  },
  { name: "usage", usage: "/usage", help: "tokens and cost so far" },
  {
    name: "compact",
    usage: "/compact",
    help: "compact the conversation history now",
  },
  {
    name: "orchestrate",
    usage: "/orchestrate <objective>",
    help: "run the multi-agent pipeline on an objective",
  },
];

/**
 * Tab completion for the input editor: `/` plus a prefix of a known command
 * name completes against {@link SLASH_COMMANDS}; anything else offers no
 * completions. Matches `readline`'s synchronous `Completer` shape.
 */
export function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const names = SLASH_COMMANDS.map((command) => `/${command.name}`);
  const hits = names.filter((name) => name.startsWith(line));
  return [hits.length > 0 ? hits : names, line];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The banner's model field: `alias` natively, `backend · alias` when delegated. */
export function bannerModel(backend: BackendName, modelAlias: string): string {
  return isDelegatedBackend(backend)
    ? `${backend} · ${modelAlias}`
    : modelAlias;
}

/**
 * The banner line that replaces kapel's own permission prompting.
 *
 * Nothing here asks before an edit or a command when the work is delegated:
 * the external CLI runs the tools and enforces its own approvals, so saying so
 * up front is the difference between "kapel stopped asking" and "kapel is not
 * the one being asked".
 */
export function approvalsLine(backend: BackendName): string {
  const cli = backend === "codex" ? "Codex" : "Claude Code";
  return `approvals are enforced by the ${cli} CLI — kapel does not prompt here`;
}

/**
 * The banner line naming which `AGENTS.md` files were found, or `undefined`
 * when none were — the shell only prints a line when this returns one.
 */
export function instructionsBannerLine(
  sources: readonly string[],
): string | undefined {
  if (sources.length === 0) return undefined;
  return `instructions: ${sources.join(", ")}`;
}

/**
 * Builds the interactive controller.
 *
 * Async because the first conversation has to exist before any line can be
 * dispatched, and building one may go through a provider-backed factory.
 */
export async function createInteractiveController(
  deps: InteractiveControllerDeps,
): Promise<InteractiveController> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const resolveModel =
    deps.resolveModel ??
    ((alias: string) => resolveModelAndProvider(process.env, alias));

  let backend: BackendName = deps.backend ?? "native";
  let modelAlias = deps.modelAlias;
  let model = deps.model;
  let provider = deps.provider;

  let sessionId = deps.start.sessionId;
  let title = deps.start.title;
  let persisted = deps.start.persisted;
  let titleDirty = false;

  /** The factory arguments for the conversation as it stands right now. */
  const factoryArgs = (
    messages: readonly ModelMessage[],
    sessionRef?: string,
  ): SessionFactoryArgs => ({
    sessionId,
    backend,
    modelAlias,
    messages,
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(sessionRef === undefined ? {} : { sessionRef }),
  });

  let session = await deps.createSession(factoryArgs(deps.start.messages));
  let chat = toChatLike(session);

  const build = async (
    messages: readonly ModelMessage[],
    sessionRef?: string,
  ): Promise<void> => {
    session = await deps.createSession(factoryArgs(messages, sessionRef));
    chat = toChatLike(session);
  };

  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    deps.write(line);
  };
  const drain = (effect?: InteractiveEffect): DispatchResult => {
    const output = lines.slice();
    lines.length = 0;
    return effect === undefined ? { output } : { output, effect };
  };

  /**
   * Writes the whole transcript back, keyed by position.
   *
   * The snapshot is written in full rather than incrementally because the
   * loop rewrites history as it goes (tool calls get sealed, results get
   * elided during compaction); `(sessionId, seq)` is the row's identity, so
   * re-saving overlapping messages updates them instead of duplicating them.
   *
   * The session row itself is created lazily, on the first message: a `kapel`
   * invocation someone opened and closed without saying anything should not
   * leave an empty conversation behind in `/sessions`.
   */
  const persist = async (): Promise<void> => {
    const store = deps.store;
    if (store === undefined) return;
    const snapshot = chat.toModelMessages();
    // Nothing was said: there is no conversation to create a row for, and an
    // already-stored one has nothing new to write.
    if (snapshot.length === 0) return;
    try {
      if (!persisted) {
        await store.createChatSession({
          id: sessionId,
          workspacePath: deps.workspacePath,
          title,
          modelAlias,
          createdAt: now(),
        });
        persisted = true;
        titleDirty = false;
      } else if (titleDirty) {
        await store.setChatSessionTitle(sessionId, title);
        titleDirty = false;
      }
      await store.appendChatMessages(
        sessionId,
        snapshot.map((message, seq) => ({ seq, message })),
      );
    } catch (error) {
      // Recording a conversation is an observer of it, never a participant:
      // a store that has gone away costs history, not the conversation.
      emit(`(not saved: ${errorText(error)})`);
    }
  };

  /**
   * Rebuilds the conversation in place, keeping everything said so far.
   *
   * `keepSessionRef` carries a delegating backend's own session id across the
   * rebuild — right for `/model` and for a `/config` that only changed models,
   * wrong the moment the backend itself changes, since one CLI's session id
   * means nothing to another.
   */
  const rebuildSession = async (keepSessionRef: boolean): Promise<void> => {
    const sessionRef = keepSessionRef ? chat.sessionRef?.() : undefined;
    await build(chat.toModelMessages(), sessionRef);
  };

  const handleMessage = async (
    text: string,
    signal?: AbortSignal,
  ): Promise<DispatchResult> => {
    if (title === "") {
      title = chatTitleFrom(text);
      titleDirty = true;
    }

    const before = deps.usage.totals();
    let result: ChatTurnLike | undefined;
    try {
      result = await chat.send(text, {
        runId: sessionId,
        workspacePath: deps.workspacePath,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      emit(`error: ${errorText(error)}`);
    }

    await persist();

    if (result !== undefined && result.status !== "success") {
      emit(`(${result.status}) ${result.summary}`);
    }
    emit(usageDeltaLine(before, deps.usage.totals()));
    return drain();
  };

  const listRecords = async (): Promise<readonly ChatSessionRecord[]> => {
    const store = deps.store;
    if (store === undefined) return [];
    return await store.listChatSessions(deps.workspacePath, {
      limit: SESSIONS_LIMIT,
    });
  };

  const slashHelp = (): DispatchResult => {
    emit("commands:");
    const width = Math.max(
      ...SLASH_COMMANDS.map((command) => command.usage.length),
    );
    for (const command of SLASH_COMMANDS) {
      emit(`  ${command.usage.padEnd(width)}  ${command.help}`);
    }
    emit("anything else is sent to the agent.");
    return drain();
  };

  const slashNew = async (): Promise<DispatchResult> => {
    await persist();
    sessionId = newId();
    title = "";
    persisted = false;
    titleDirty = false;
    // No `sessionRef`: a new conversation must not continue the last one on
    // the delegating backend's side either.
    await build([]);
    emit(`started a new session ${shortId(sessionId)}`);
    return drain("new-session");
  };

  const slashSessions = async (): Promise<DispatchResult> => {
    if (deps.store === undefined) {
      emit("sessions are not being recorded (--no-save).");
      return drain();
    }
    const records = await listRecords();
    if (records.length === 0) {
      emit(`No chat sessions recorded for ${deps.workspacePath} yet.`);
      return drain();
    }
    const rows = records.map((record) => [
      // The conversation this REPL is on gets a marker of its own column, so
      // the ids stay in one straight line.
      record.id === sessionId ? "*" : "",
      shortId(record.id),
      isoTime(record.updatedAt),
      String(record.messageCount),
      record.title === "" ? "(untitled)" : record.title,
    ]);
    for (const line of formatTable(
      ["", "ID", "UPDATED", "MSGS", "TITLE"],
      rows,
    )) {
      emit(line);
    }
    return drain();
  };

  const slashResume = async (argument: string): Promise<DispatchResult> => {
    if (deps.store === undefined) {
      emit(
        "sessions are not being recorded (--no-save), so there is none to resume.",
      );
      return drain();
    }
    if (argument === "") {
      emit("usage: /resume <id>  — see /sessions");
      return drain();
    }
    const records = await listRecords();
    const matched = matchChatSession(records, argument);
    if ("error" in matched) {
      emit(matched.error);
      return drain();
    }
    if (matched.record.id === sessionId) {
      emit(`already on ${shortId(sessionId)}`);
      return drain();
    }

    const transcript = await deps.store.loadChatSession(matched.record.id);
    if (transcript === undefined) {
      emit(`Chat session ${matched.record.id} could not be read.`);
      return drain();
    }

    await persist();
    sessionId = transcript.record.id;
    title = transcript.record.title;
    persisted = true;
    titleDirty = false;
    await build(transcript.messages);
    emit(
      `resumed ${title === "" ? shortId(sessionId) : title} (${transcript.messages.length} messages)`,
    );
    return drain("resumed");
  };

  /** `alias (provider/id)` natively; `alias (backend)` for a delegated one. */
  const modelLine = (): string => {
    if (provider === undefined || model === undefined) {
      return `model: ${modelAlias} (${backend})`;
    }
    return `model: ${modelAlias} (${provider.id}/${model.id})`;
  };

  const slashModel = async (argument: string): Promise<DispatchResult> => {
    if (argument === "") {
      emit(modelLine());
      return drain();
    }

    if (backend === "native") {
      const resolved = await resolveModel(argument);
      if ("error" in resolved) {
        emit(resolved.error);
        return drain();
      }
      model = resolved.model;
      provider = resolved.provider;
    }
    // A delegated backend has no catalog to check the alias against — the
    // external CLI owns the list of models the account may use, and it is the
    // one that will complain if this is not on it.
    modelAlias = argument;
    // The history moves to the new model as-is; the turns already taken keep
    // whatever model produced them, so only future turns change hands.
    await rebuildSession(true);
    emit(`model switched to ${modelAlias} — future turns use it.`);
    return drain("model-changed");
  };

  /**
   * `/config` — re-run setup, then make this conversation obey the answers.
   *
   * The conversation itself survives: a new backend or model is applied by
   * rebuilding the session around the transcript, exactly the way `/model`
   * does, so switching from Claude Code to a native model mid-thread keeps
   * everything said so far.
   */
  const slashConfig = async (): Promise<DispatchResult> => {
    if (deps.configure === undefined) {
      emit("/config needs a terminal — run `kapel config` from one.");
      return drain();
    }

    const config = await deps.configure();
    if (config === undefined) return drain();

    const nextBackend = config.backend;
    const nextAlias = config.models.orchestrator;
    if (nextBackend === backend && nextAlias === modelAlias) {
      emit("config unchanged.");
      return drain();
    }

    if (nextBackend === "native") {
      const resolved = await resolveModel(nextAlias);
      if ("error" in resolved) {
        // The config is saved either way — it is the machine's setting, not
        // this conversation's — but this REPL keeps what still works.
        emit(resolved.error);
        emit("keeping the current backend for this conversation.");
        return drain();
      }
      model = resolved.model;
      provider = resolved.provider;
    } else {
      model = undefined;
      provider = undefined;
    }

    const changes: string[] = [];
    if (nextBackend !== backend)
      changes.push(`backend ${backend} → ${nextBackend}`);
    if (nextAlias !== modelAlias)
      changes.push(`model ${modelAlias} → ${nextAlias}`);
    const backendChanged = nextBackend !== backend;
    backend = nextBackend;
    modelAlias = nextAlias;

    await rebuildSession(!backendChanged);
    emit(`${changes.join(", ")} — future turns use it.`);
    return drain("config-changed");
  };

  /**
   * `/compact` — force an immediate compaction pass over this conversation's
   * history, regardless of the auto-compaction threshold.
   *
   * A delegated backend (`claude-code`/`codex`) manages its own context on
   * its own side, so there is nothing here for `/compact` to reach into —
   * `chat.compactNow` is simply absent for it (see {@link toChatLike}), and
   * that absence is exactly what tells the two cases apart.
   */
  const slashCompact = async (): Promise<DispatchResult> => {
    if (chat.compactNow === undefined) {
      const cli = backend === "codex" ? "Codex" : "Claude Code";
      emit(`/compact is not supported with the ${cli} backend.`);
      return drain();
    }

    const result = await chat.compactNow({
      runId: sessionId,
      workspacePath: deps.workspacePath,
    });
    emit(
      result.elided === 0
        ? "nothing to compact."
        : `compacted: elided ${result.elided} tool result${result.elided === 1 ? "" : "s"}, saved ~${result.savedChars} chars`,
    );
    return drain();
  };

  const slashOrchestrate = async (
    objective: string,
  ): Promise<DispatchResult> => {
    if (deps.orchestrate === undefined) {
      emit("/orchestrate is not available here.");
      return drain();
    }
    if (objective === "") {
      emit('usage: /orchestrate "<objective>"');
      return drain();
    }
    try {
      const code = await deps.orchestrate(objective);
      if (code !== 0) emit(`orchestrate exited ${code}`);
    } catch (error) {
      // A failed pipeline (stale policy lock, dirty worktree, …) is a thing
      // to fix and retry, not a reason to lose the conversation.
      emit(errorText(error));
    }
    return drain();
  };

  const handleSlash = async (line: string): Promise<DispatchResult> => {
    const space = line.indexOf(" ");
    const name = (space === -1 ? line : line.slice(0, space))
      .slice(1)
      .toLowerCase();
    const argument = space === -1 ? "" : line.slice(space + 1).trim();

    switch (name) {
      case "help":
      case "?":
        return slashHelp();
      case "exit":
      case "quit":
        return drain("exit");
      case "new":
        return await slashNew();
      case "sessions":
        return await slashSessions();
      case "resume":
        return await slashResume(argument);
      case "model":
        return await slashModel(argument);
      case "config":
        return await slashConfig();
      case "usage":
        emit(usageTotalsLine(deps.usage.totals()));
        return drain();
      case "compact":
        return await slashCompact();
      case "orchestrate":
        return await slashOrchestrate(argument);
      default:
        emit(`Unknown command "/${name}". Type /help for the list.`);
        return drain();
    }
  };

  return {
    sessionId: () => sessionId,
    title: () => title,
    modelAlias: () => modelAlias,
    backend: () => backend,
    session: () => session,
    banner: (cwd: string) => [
      `kapel v${CLI_VERSION}  ${bannerModel(backend, modelAlias)}  session ${shortId(sessionId)}`,
      cwd,
      ...(isDelegatedBackend(backend) ? [approvalsLine(backend)] : []),
      "type /help for commands, /exit to quit",
      "\\ + Enter for multiline input, ↑/↓ to recall, tab-complete /commands",
      "",
    ],
    handleLine: async (line, signal) => {
      const trimmed = line.trim();
      if (trimmed === "") return { output: [] };
      if (trimmed.startsWith("/")) return await handleSlash(trimmed);
      return await handleMessage(trimmed, signal);
    },
  };
}

// --- The terminal shell -----------------------------------------------------

export interface InteractiveOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly maxIterations: number;
  readonly timeoutSeconds?: number;
  readonly yes: boolean;
  readonly json: boolean;
  /** `--no-save`: run the conversation without recording it. Defaults to true. */
  readonly save?: boolean;
  readonly continue?: boolean;
  readonly session?: string;
  readonly system?: string;
  /** The raw `--backend` flag, if one was passed. */
  readonly backend?: string;
  /** The machine's configuration, when there is one; see `config-runtime.ts`. */
  readonly config?: KapelConfig;
}

/**
 * Opens (creating if needed) the chat store for a workspace.
 *
 * Unlike an orchestration run, an interactive session does not require a
 * `kapel init`-ed project: creating `<cwd>/.agent` to hold the database is
 * the whole setup, and a conversation is worth keeping even in a directory
 * nobody has configured. A store that still cannot be opened yields
 * `undefined` — the conversation runs unrecorded rather than not at all.
 */
export async function openChatStore(
  workspacePath: string,
): Promise<SqliteSessionStore | undefined> {
  const agentDir = path.join(workspacePath, ".agent");
  try {
    await mkdir(agentDir, { recursive: true });
    return new SqliteSessionStore({ path: defaultSessionDbPath(agentDir) });
  } catch {
    return undefined;
  }
}

/**
 * What a Ctrl-C at the prompt reads as, as opposed to a line or end-of-input.
 * Exported so tests can drive and assert on `LineSource` behavior without a
 * real TTY.
 */
export const SIGINT_LINE = Symbol("sigint");

export type ReadLineResult = string | undefined | typeof SIGINT_LINE;

/** Where the REPL's lines come from: a terminal, or whatever was piped in. */
export interface LineSource {
  next(promptText: string): Promise<ReadLineResult>;
  close(): void;
}

/**
 * A terminal line source backed by one long-lived {@link InputManager}.
 *
 * The manager owns stdin for the whole REPL — that persistence is what makes
 * ↑-history, multiline continuation and paste coalescing possible (see
 * `input.ts`). The permission prompter shares it too (`InputManager.question`,
 * wired in via `createPrompter`'s `ask`), so there is never a second readline
 * opening on top of this one, and mid-turn Ctrl-C is driven through the
 * manager's `onIdleSigint` instead of a real `SIGINT` — raw mode never lets
 * go of stdin long enough for the terminal to deliver one directly. See
 * `runInteractive` for how the two are threaded together.
 */
export function inputManagerLineSource(manager: InputManager): LineSource {
  return {
    next: async (promptText) => {
      const result = await manager.readMessage(promptText);
      return result === INPUT_SIGINT ? SIGINT_LINE : result;
    },
    close: () => manager.close(),
  };
}

/**
 * A piped line source, for `kapel chat < script.txt` and the like.
 *
 * One interface reads stdin to the end and queues every line, because a pipe
 * delivers many lines in a single chunk: a reader that closed itself after
 * the first line would throw the rest of the script away. There is no Ctrl-C
 * and no permission prompter on this path, so nothing competes for stdin.
 */
function pipedLineSource(): LineSource {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  const queued: string[] = [];
  let waiting: ((line: ReadLineResult) => void) | undefined;
  let ended = false;

  const deliver = (line: ReadLineResult): boolean => {
    const waiter = waiting;
    if (waiter === undefined) return false;
    waiting = undefined;
    waiter(line);
    return true;
  };

  rl.on("line", (line) => {
    if (!deliver(line)) queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    deliver(undefined);
  });

  return {
    next: (promptText) => {
      process.stdout.write(promptText);
      const next = queued.shift();
      if (next !== undefined) return Promise.resolve<ReadLineResult>(next);
      if (ended) return Promise.resolve<ReadLineResult>(undefined);
      return new Promise<ReadLineResult>((resolve) => {
        waiting = resolve;
      });
    },
    close: () => rl.close(),
  };
}

function dim(text: string, color: boolean): string {
  return color ? `[2m${text}[0m` : text;
}

/**
 * What a conversation needs before its first line: a usable model on the
 * native path, a usable CLI on a delegated one.
 *
 * Both failures are reported the same way — one printable line and exit 1 —
 * because "you have no credential" and "you are not logged in to Claude Code"
 * are the same problem seen from two backends.
 */
async function startDelegatedOrNative(
  backend: BackendName,
  alias: string,
): Promise<
  | { readonly model?: ModelDefinition; readonly provider?: ModelProvider }
  | { readonly error: string }
> {
  if (backend === "claude-code") {
    const availability = await ClaudeCodeBackend.checkAvailability();
    if (!availability.installed) {
      return { error: claudeCodeInstallGuidance(availability) };
    }
    if (!availability.loggedIn) {
      return { error: claudeCodeLoginGuidance(availability) };
    }
    return {};
  }
  if (backend === "codex") {
    const availability = await CodexBackend.checkAvailability();
    if (!availability.installed) {
      return { error: codexInstallGuidance(availability) };
    }
    if (!availability.loggedIn) {
      return { error: codexLoginGuidance(availability) };
    }
    return {};
  }
  return await resolveModelAndProvider(process.env, alias);
}

/**
 * Implements `kapel` with no objective, and `kapel chat`: a persistent
 * conversation with the coding agent, in this directory.
 *
 * Returns the process exit code. The conversation itself never decides it —
 * a turn that failed is a turn the user can follow up on — so anything short
 * of a setup failure exits 0.
 */
export async function runInteractive(
  options: InteractiveOptions,
): Promise<number> {
  if (options.json) {
    console.error(
      '--json is not supported in interactive mode: there is no stream to script against until you say something. Use the one-shot form instead: kapel --json "<objective>".',
    );
    return 1;
  }

  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const instructions = loadInstructions(workspacePath, process.env);

  // `.env` is loaded first so a workspace-local `AGENT_BACKEND`/`AGENT_MODEL`
  // takes part in the precedence chain exactly like a shell variable.
  const backend = resolveBackendSetting(
    options.backend,
    process.env,
    options.config,
  ).value;
  const modelSetting = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
  );
  const alias = modelSetting.value;
  const delegatedModel = delegatedModelOverride(modelSetting);
  // What the conversation calls its model. On a delegated backend with nothing
  // chosen, that is honestly `default` — naming the native catalog's default
  // alias would claim a model the external CLI was never told to use.
  const chatAlias = isDelegatedBackend(backend)
    ? (delegatedModel ?? "default")
    : alias;

  const startup = await startDelegatedOrNative(backend, alias);
  if ("error" in startup) {
    console.error(startup.error);
    return 1;
  }

  const store =
    options.save === false ? undefined : await openChatStore(workspacePath);

  try {
    const started = await resolveStartSession(store, workspacePath, {
      ...(options.continue === undefined ? {} : { continue: options.continue }),
      ...(options.session === undefined ? {} : { session: options.session }),
    });
    if ("error" in started) {
      console.error(started.error);
      return 1;
    }

    const interactiveTty = process.stdin.isTTY === true;
    const renderer = new TextRenderer();
    const promptState = createPromptState();

    // The turn currently in flight, if any — a persistent `InputManager`
    // never lets go of raw mode long enough for a mid-turn Ctrl-C to reach
    // the process as a real `SIGINT` (see `inputManagerLineSource`), so its
    // `onIdleSigint` reaches the abort controller through this instead.
    const activeTurn: { current: AbortController | undefined } = {
      current: undefined,
    };

    const inputManager = interactiveTty
      ? createInputManager({
          input: process.stdin,
          output: process.stdout,
          history: await loadHistory(),
          onHistoryAppend: createHistoryAppender(),
          completer: slashCompleter,
          onIdleSigint: () => activeTurn.current?.abort(),
        })
      : undefined;

    const prompter = createPrompter({
      yes: options.yes,
      interactive: interactiveTty,
      state: promptState,
      ...(inputManager === undefined
        ? {}
        : { ask: (query: string) => inputManager.question(query) }),
    });
    const nativeUsage = new UsageTracker();
    const delegatedUsage = new DelegatedUsage();
    // One usage view over both engines, so `/usage` and the per-turn delta
    // read the same however the conversation is being run — and keep adding up
    // across a `/config` that switches from one to the other mid-thread.
    const usage = { totals: () => sumTotals(nativeUsage, delegatedUsage) };

    /**
     * The model id to hand the delegating CLI for one build.
     *
     * The startup alias keeps the precedence chain's verdict (which knows
     * whether anyone actually chose it); anything else got here through
     * `/model` or `/config`, which is a human choosing it by definition.
     */
    const delegatedModelFor = (aliasForBuild: string): string | undefined =>
      aliasForBuild === chatAlias
        ? delegatedModel
        : delegatedModelOverride({ value: aliasForBuild, source: "flag" });

    /** The delegated conversation, plus the usage bookkeeping around a turn. */
    const delegatedSession = (
      target: Exclude<BackendName, "native">,
      args: SessionFactoryArgs,
    ): ChatLike => {
      const forwardedModel = delegatedModelFor(args.modelAlias);
      const chat = createDelegatedChatSession({
        backend: target,
        workspacePath,
        runId: args.sessionId,
        messages: args.messages,
        events: renderer,
        ...(forwardedModel === undefined ? {} : { model: forwardedModel }),
        ...(args.sessionRef === undefined
          ? {}
          : { sessionRef: args.sessionRef }),
        ...(options.timeoutSeconds === undefined
          ? {}
          : { timeoutMs: options.timeoutSeconds * 1000 }),
      });
      return {
        send: async (instruction, context) => {
          const result = await chat.send(instruction, {
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          delegatedUsage.add(result);
          return result;
        },
        toModelMessages: () => chat.toModelMessages(),
        sessionRef: () => chat.sessionRef(),
      };
    };

    const nativeSession = (args: SessionFactoryArgs): InteractiveSession => {
      if (args.model === undefined || args.provider === undefined) {
        throw new Error(
          "the native backend needs a resolved model and provider.",
        );
      }
      const agent: AgentDefinition = {
        name: "agent",
        role: "worker",
        model: args.model,
        systemPrompt:
          options.system ??
          composeSystemPrompt(defaultSystemPrompt(workspacePath), instructions),
        tools: builtinTools().map((tool) => tool.name),
        permissions: DEFAULT_PERMISSIONS,
      };
      return AgentChatSession.restore(
        agentLoopOptions({
          agent,
          provider: args.provider,
          permissions: new PermissionEngine(DEFAULT_PERMISSIONS, {
            defaultDecision: "ask",
            ...(prompter === undefined ? {} : { prompter }),
          }),
          usage: nativeUsage,
          events: renderer,
          maxIterations: options.maxIterations,
          ...(options.timeoutSeconds === undefined
            ? {}
            : { timeoutMs: options.timeoutSeconds * 1000 }),
        }),
        args.messages,
      );
    };

    const createSession: InteractiveSessionFactory = (args) =>
      args.backend === "native"
        ? nativeSession(args)
        : delegatedSession(args.backend, args);

    const wizardTty =
      interactiveTty && process.stdout.isTTY === true && !options.json;

    const controller = await createInteractiveController({
      workspacePath,
      ...(store === undefined ? {} : { store }),
      createSession,
      write: (line) => {
        console.log(line);
      },
      backend,
      modelAlias: chatAlias,
      ...(startup.model === undefined ? {} : { model: startup.model }),
      ...(startup.provider === undefined ? {} : { provider: startup.provider }),
      start: started.start,
      usage,
      orchestrate: (objective) =>
        runOrchestrate(objective, orchestrateOptionsFor(options, alias)),
      ...(wizardTty
        ? {
            configure: () =>
              runConfigWizard({
                // `/config` runs while the REPL's own InputManager still owns
                // stdin — suspend it around the picker so the two don't fight
                // over raw-mode keypresses.
                prompt: ttyWizardPrompt(
                  undefined,
                  inputManager === undefined
                    ? undefined
                    : (fn) => inputManager.withSuspended(fn),
                ),
                write: (line) => {
                  console.log(line);
                },
                checkBackend: (target) => checkBackendAvailability(target),
                ...(options.config === undefined
                  ? {}
                  : { current: options.config }),
              }),
          }
        : {}),
    });

    const color = process.stdout.isTTY === true;
    for (const line of controller.banner(workspacePath)) console.log(line);
    const instructionsLine = instructionsBannerLine(instructions.sources);
    if (instructionsLine !== undefined)
      console.log(dim(instructionsLine, color));
    if (started.start.persisted) {
      const label =
        started.start.title === ""
          ? shortId(started.start.sessionId)
          : started.start.title;
      console.log(
        dim(
          `resumed ${label} (${started.start.messages.length} messages)`,
          color,
        ),
      );
    }

    const lineSource =
      inputManager === undefined
        ? pipedLineSource()
        : inputManagerLineSource(inputManager);
    try {
      return await replLoop({
        controller,
        lines: lineSource,
        promptState,
        promptText: dim("kapel> ", color),
        color,
        activeTurn,
      });
    } finally {
      lineSource.close();
    }
  } finally {
    if (store !== undefined) {
      try {
        store.close();
      } catch {
        // best-effort
      }
    }
  }
}

interface ReplLoopArgs {
  readonly controller: InteractiveController;
  readonly lines: LineSource;
  readonly promptState: PromptState;
  readonly promptText: string;
  readonly color: boolean;
  /**
   * The in-flight turn's `AbortController`, kept current for the duration of
   * `handleLine` so an `InputManager`'s `onIdleSigint` (see
   * `inputManagerLineSource`) can reach it. Absent on the piped-input path,
   * which has no `InputManager` and relies on the real `SIGINT` below.
   */
  readonly activeTurn?: { current: AbortController | undefined };
}

/**
 * Reads lines and dispatches them until the user leaves.
 *
 * The only signal handling that belongs here is the one the controller cannot
 * see: a `SIGINT` arriving mid-turn cancels that turn (unless a permission
 * question is showing, which owns its own Ctrl-C and answers "no"), and one
 * arriving at an idle prompt needs saying twice before it ends the session.
 *
 * Two parallel paths feed that abort, because only one of them fires
 * depending on how lines are being read: piped input leaves the real
 * terminal in charge, so a genuine `SIGINT` reaches `process` and `onSigint`
 * below handles it directly; a TTY `InputManager` never releases raw mode
 * mid-turn, so no real signal arrives and `activeTurn` is how its
 * `onIdleSigint` reaches this same abort instead.
 */
async function replLoop(args: ReplLoopArgs): Promise<number> {
  const { controller, lines, promptState, promptText, color, activeTurn } =
    args;
  let armed = false;

  for (;;) {
    const line = await lines.next(promptText);

    if (line === undefined) {
      console.log("");
      return 0;
    }
    if (line === SIGINT_LINE) {
      if (armed) {
        console.log("");
        return 0;
      }
      armed = true;
      console.log(dim("(/exit to quit, Ctrl-C again to force)", color));
      continue;
    }
    armed = false;

    const turn = new AbortController();
    if (activeTurn !== undefined) activeTurn.current = turn;
    const onSigint = (): void => {
      if (promptState.active) return;
      turn.abort();
    };
    process.on("SIGINT", onSigint);
    let result: DispatchResult;
    try {
      result = await controller.handleLine(line, turn.signal);
    } finally {
      process.off("SIGINT", onSigint);
      if (activeTurn !== undefined) activeTurn.current = undefined;
    }

    if (result.effect === "exit") return 0;
  }
}

/** The orchestrate pipeline's options, derived from the REPL's own globals. */
function orchestrateOptionsFor(
  options: InteractiveOptions,
  alias: string,
): OrchestrateCommandOptions {
  return {
    cwd: options.cwd,
    json: false,
    model: alias,
    dryRun: false,
    workerMode: DEFAULT_WORKER_MODE,
    backend: "native",
    isolation: DEFAULT_ISOLATION,
    validate: true,
    save: options.save !== false,
    tui: false,
    maxIterations: options.maxIterations,
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.timeoutSeconds }),
  };
}
