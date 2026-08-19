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
import { loadDotEnvFile } from "./env.js";
import { resolveModelAlias } from "./models.js";
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
import { defaultSystemPrompt, resolveModelAndProvider } from "./run.js";
import { isoTime } from "./sessions.js";

/**
 * The CLI's version, shown by `--version` and in the interactive banner. Kept
 * here so both spellings of it come from one place.
 */
export const CLI_VERSION = "0.2.0";

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
}

export interface SessionFactoryArgs {
  readonly modelAlias: string;
  readonly model: ModelDefinition;
  readonly provider: ModelProvider;
  /** History to rebuild from — empty for a brand new conversation. */
  readonly messages: readonly ModelMessage[];
}

/** Builds (or rebuilds) the conversation. Overridable in tests. */
export type InteractiveSessionFactory = (
  args: SessionFactoryArgs,
) => InteractiveSession | Promise<InteractiveSession>;

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
  | "model-changed";

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
  readonly modelAlias: string;
  readonly model: ModelDefinition;
  readonly provider: ModelProvider;
  /** Where the conversation starts; see {@link resolveStartSession}. */
  readonly start: InteractiveStart;
  /** Cumulative usage across every turn of this process. */
  readonly usage: { totals(): UsageTotals };
  /** Resolves a `/model <alias>` switch. Defaults to the real registry. */
  readonly resolveModel?: (alias: string) => Promise<ResolvedModel>;
  /** Runs `/orchestrate <objective>`; absent means the command is unavailable. */
  readonly orchestrate?: (objective: string) => Promise<number>;
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** The REPL's brain: everything a typed line can do, with no terminal in sight. */
export interface InteractiveController {
  sessionId(): string;
  title(): string;
  modelAlias(): string;
  /** The live conversation — the object `send` is called on. */
  session(): InteractiveSession;
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
  { name: "usage", usage: "/usage", help: "tokens and cost so far" },
  {
    name: "orchestrate",
    usage: "/orchestrate <objective>",
    help: "run the multi-agent pipeline on an objective",
  },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  let modelAlias = deps.modelAlias;
  let model = deps.model;
  let provider = deps.provider;

  let sessionId = deps.start.sessionId;
  let title = deps.start.title;
  let persisted = deps.start.persisted;
  let titleDirty = false;

  let session = await deps.createSession({
    modelAlias,
    model,
    provider,
    messages: deps.start.messages,
  });

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
    const snapshot = session.messages();
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

  const rebuildSession = async (): Promise<void> => {
    session = await deps.createSession({
      modelAlias,
      model,
      provider,
      messages: session.messages(),
    });
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
    let result: ChatTurnResult | undefined;
    try {
      result = await session.send(text, {
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
    session = await deps.createSession({
      modelAlias,
      model,
      provider,
      messages: [],
    });
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
    session = await deps.createSession({
      modelAlias,
      model,
      provider,
      messages: transcript.messages,
    });
    emit(
      `resumed ${title === "" ? shortId(sessionId) : title} (${transcript.messages.length} messages)`,
    );
    return drain("resumed");
  };

  const slashModel = async (argument: string): Promise<DispatchResult> => {
    if (argument === "") {
      emit(`model: ${modelAlias} (${provider.id}/${model.id})`);
      return drain();
    }
    const resolved = await resolveModel(argument);
    if ("error" in resolved) {
      emit(resolved.error);
      return drain();
    }
    modelAlias = argument;
    model = resolved.model;
    provider = resolved.provider;
    // The history moves to the new model as-is; the turns already taken keep
    // whatever model produced them, so only future turns change hands.
    await rebuildSession();
    emit(`model switched to ${modelAlias} — future turns use it.`);
    return drain("model-changed");
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
      case "usage":
        emit(usageTotalsLine(deps.usage.totals()));
        return drain();
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
    session: () => session,
    banner: (cwd: string) => [
      `kapel v${CLI_VERSION}  ${modelAlias}  session ${shortId(sessionId)}`,
      cwd,
      "type /help for commands, /exit to quit",
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

/** What a Ctrl-C at the prompt reads as, as opposed to a line or end-of-input. */
const SIGINT_LINE = Symbol("sigint");

type ReadLineResult = string | undefined | typeof SIGINT_LINE;

/** Where the REPL's lines come from: a terminal, or whatever was piped in. */
interface LineSource {
  next(promptText: string): Promise<ReadLineResult>;
  close(): void;
}

/**
 * A terminal line source: one readline interface per prompt, closed again
 * before the line is dispatched.
 *
 * Per-prompt interfaces rather than one long-lived one because the permission
 * prompter opens its own interface on the same stdin mid-turn, and two live
 * interfaces would both consume the answer. Closing this one also restores
 * the terminal out of raw mode for the duration of a turn, which is what lets
 * a Ctrl-C during a send arrive as a real `SIGINT` — exactly the arrangement
 * a one-shot `kapel "<objective>"` run already relies on.
 */
function ttyLineSource(): LineSource {
  return {
    next: (promptText) =>
      new Promise<ReadLineResult>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
        let settled = false;
        const finish = (value: ReadLineResult): void => {
          if (settled) return;
          settled = true;
          rl.close();
          resolve(value);
        };
        rl.on("SIGINT", () => finish(SIGINT_LINE));
        // Ctrl-D at an empty prompt closes the interface with no `line` event.
        rl.on("close", () => finish(undefined));
        rl.question(promptText, (answer) => finish(answer));
      }),
    close: () => undefined,
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

  const alias = resolveModelAlias(process.env, options.model);
  const resolved = await resolveModelAndProvider(process.env, alias);
  if ("error" in resolved) {
    console.error(resolved.error);
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
    const prompter = createPrompter({
      yes: options.yes,
      interactive: interactiveTty,
      state: promptState,
    });
    const usage = new UsageTracker();

    const createSession: InteractiveSessionFactory = (args) => {
      const agent: AgentDefinition = {
        name: "agent",
        role: "worker",
        model: args.model,
        systemPrompt: options.system ?? defaultSystemPrompt(workspacePath),
        tools: builtinTools().map((tool) => tool.name),
        permissions: DEFAULT_PERMISSIONS,
      };
      return AgentChatSession.restore(
        {
          agent,
          provider: args.provider,
          tools: builtinTools(),
          permissions: new PermissionEngine(DEFAULT_PERMISSIONS, {
            defaultDecision: "ask",
            ...(prompter === undefined ? {} : { prompter }),
          }),
          usage,
          events: renderer,
          maxIterations: options.maxIterations,
          ...(options.timeoutSeconds === undefined
            ? {}
            : { timeoutMs: options.timeoutSeconds * 1000 }),
        },
        args.messages,
      );
    };

    const controller = await createInteractiveController({
      workspacePath,
      ...(store === undefined ? {} : { store }),
      createSession,
      write: (line) => {
        console.log(line);
      },
      modelAlias: alias,
      model: resolved.model,
      provider: resolved.provider,
      start: started.start,
      usage,
      orchestrate: (objective) =>
        runOrchestrate(objective, orchestrateOptionsFor(options, alias)),
    });

    const color = process.stdout.isTTY === true;
    for (const line of controller.banner(workspacePath)) console.log(line);
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

    const lineSource = interactiveTty ? ttyLineSource() : pipedLineSource();
    try {
      return await replLoop({
        controller,
        lines: lineSource,
        promptState,
        promptText: dim("kapel> ", color),
        color,
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
}

/**
 * Reads lines and dispatches them until the user leaves.
 *
 * The only signal handling that belongs here is the one the controller cannot
 * see: a `SIGINT` arriving mid-turn cancels that turn (unless a permission
 * question is showing, which owns its own Ctrl-C and answers "no"), and one
 * arriving at an idle prompt needs saying twice before it ends the session.
 */
async function replLoop(args: ReplLoopArgs): Promise<number> {
  const { controller, lines, promptState, promptText, color } = args;
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
