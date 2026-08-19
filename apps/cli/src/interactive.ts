import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import type {
  ModelDefinition,
  ModelMessage,
  ModelProvider,
  UsageBreakdown,
  UsageDimension,
  UsageTotals,
} from "@agent/ai";
import { defaultModelCatalog, UNATTRIBUTED, UsageTracker } from "@agent/ai";
import type { AgentLoopRunContext, ChatTurnResult } from "@agent/coding-agent";
import {
  AgentChatSession,
  builtinTools,
  ClaudeCodeBackend,
  CodexBackend,
  PermissionEngine,
  SessionAllowlist,
} from "@agent/coding-agent";
import type { AgentDefinition } from "@agent/core";
import type {
  ChatSessionRecord,
  ChatSessionTranscript,
  ForkChatSessionOptions,
  ListChatSessionsOptions,
  NewChatSession,
  PersistedChatMessage,
} from "@agent/session";
import {
  chatTitleFrom,
  defaultSessionDbPath,
  resolveChatSessionReference,
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
import type { CheckpointStore } from "./checkpoint.js";
import { createCheckpointStore, undoLines } from "./checkpoint.js";
import type { CustomCommand, LoadCustomCommandsResult } from "./commands.js";
import { expandCustomCommand, loadCustomCommands } from "./commands.js";
import type { KapelConfig } from "./config.js";
import {
  checkBackendAvailability,
  delegatedModelOverride,
  detectBackendSetting,
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
import type { CompleterResult, InputCompleter } from "./input.js";
import {
  createInputManager,
  INPUT_SIGINT,
  type InputManager,
} from "./input.js";
import { composeSystemPrompt, loadInstructions } from "./instructions.js";
import type { FileLister } from "./mention.js";
import {
  annotateMentions,
  completeMention,
  createFileLister,
  mentionTokenAt,
  workspaceFileExists,
} from "./mention.js";
import type { OrchestrateCommandOptions } from "./orchestrate.js";
import { DEFAULT_ISOLATION, runOrchestrate } from "./orchestrate.js";
import {
  DEFAULT_PERMISSIONS,
  loadRepoPermissionRules,
  resolvePermissionRules,
} from "./permissions.js";
import type { OrchestrationOutput, PlanCommandOptions } from "./plan.js";
import { formatTable, runPlan } from "./plan.js";
import type { PromptState } from "./prompter.js";
import { createPrompter, createPromptState } from "./prompter.js";
import { TextRenderer, usageRollupLines } from "./render.js";
import type { ResumeCommandOptions } from "./resume-cmd.js";
import { runResume } from "./resume-cmd.js";
import type { ResolvedModel } from "./run.js";
import {
  agentLoopOptions,
  DEFAULT_MAX_ITERATIONS,
  defaultSystemPrompt,
  resolveModelAndProvider,
} from "./run.js";
import { runRunsCommand } from "./runs-cmd.js";
import { isoTime } from "./sessions.js";

/**
 * The CLI's version, shown by `--version` and in the interactive banner. Kept
 * here so both spellings of it come from one place.
 */
export const CLI_VERSION = "0.7.0";

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
  /** Backs `/name`; see `SqliteSessionStore.renameChatSession`. */
  renameChatSession(sessionId: string, name: string): Promise<void>;
  /** Backs `/fork`; see `SqliteSessionStore.forkChatSession`. */
  forkChatSession(
    sessionId: string,
    options?: ForkChatSessionOptions,
  ): Promise<string>;
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
  | "renamed"
  | "forked"
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
  /** User-given label (`/name`), when the resumed session has one. */
  readonly name?: string;
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
  | { readonly start: InteractiveStart; readonly note?: string }
  | { readonly error: string };

/**
 * Resolves a `--session`/`/resume` reference and reports the one thing about
 * it worth telling the user without failing the resolution: two sessions
 * sharing a name, resolved to the more recent one. `matchChatSession` used to
 * live here as a hand-rolled id-only version of exactly this; P1-8 moved that
 * logic into `@agent/session` (`resolveChatSessionReference`) and taught it
 * names too, so both `--session` and `/resume` take a name as readily as an
 * id or an id prefix — this is the one place that still has to turn its
 * `onNote` into something printable.
 */
function resolveSessionReference(
  records: readonly ChatSessionRecord[],
  reference: string,
):
  | { readonly record: ChatSessionRecord; readonly note?: string }
  | { readonly error: string } {
  let note: string | undefined;
  const resolved = resolveChatSessionReference(records, reference, {
    onNote: (found) => {
      note = found;
    },
  });
  if ("error" in resolved) return { error: resolved.error };
  return note === undefined
    ? { record: resolved.record }
    : { record: resolved.record, note };
}

function startFrom(transcript: ChatSessionTranscript): InteractiveStart {
  return {
    sessionId: transcript.record.id,
    title: transcript.record.title,
    persisted: true,
    messages: transcript.messages,
    ...(transcript.record.name === undefined
      ? {}
      : { name: transcript.record.name }),
  };
}

/**
 * Decides which conversation this invocation opens: a new one, the most
 * recently touched one (`--continue`), or a named one (`--session <id|name>`).
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
    const matched = resolveSessionReference(records, selector.session);
    if ("error" in matched) return { error: matched.error };
    const transcript = await store.loadChatSession(matched.record.id);
    if (transcript === undefined) {
      return { error: `Chat session ${matched.record.id} could not be read.` };
    }
    return matched.note === undefined
      ? { start: startFrom(transcript) }
      : { start: startFrom(transcript), note: matched.note };
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

/**
 * `/usage`'s per-model view: whatever the native tracker attributed, plus one
 * bucket per delegating backend that ran a turn this process.
 *
 * A delegated backend bills a subscription, not tokens, so its bucket carries
 * real token counts and a price only when the CLI itself reported one —
 * otherwise `unknown`, which renders as `n/a` rather than a misleading `$0.00`.
 */
export function chatUsageBreakdown(
  native: ReadonlyMap<string, UsageBreakdown>,
  delegated: readonly {
    readonly label: string;
    readonly totals: UsageTotals;
  }[],
): ReadonlyMap<string, UsageBreakdown> {
  const out = new Map(native);
  for (const { label, totals } of delegated) {
    const { inputTokens, outputTokens } = totals.usage;
    if (inputTokens === 0 && outputTokens === 0 && totals.costUsd === 0) {
      continue;
    }
    out.set(label, {
      key: label,
      usage: totals.usage,
      costUsd: totals.costUsd,
      pricing: totals.costUsd > 0 ? "known" : "unknown",
      models: [label],
      agents: [UNATTRIBUTED],
      tasks: [UNATTRIBUTED],
      samples: 1,
    });
  }
  return out;
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
  /**
   * Cumulative usage across every turn of this process.
   *
   * `breakdownBy` is optional: a source that cannot attribute its spend (a
   * bare delegated total) still reports a running total, and `/usage` prints
   * the breakdown only when there is one to print.
   */
  readonly usage: {
    totals(): UsageTotals;
    breakdownBy?(
      dimension: UsageDimension,
    ): ReadonlyMap<string, UsageBreakdown>;
  };
  /** Resolves a `/model <alias>` switch. Defaults to the real registry. */
  readonly resolveModel?: (alias: string) => Promise<ResolvedModel>;
  /** Runs `/orchestrate <objective>`; absent means the command is unavailable. */
  readonly orchestrate?: (objective: string) => Promise<number>;
  /**
   * Runs `/plan <objective>` — the same preparePlan pipeline `/orchestrate`
   * starts with, stopping before execution. Absent means the command is
   * unavailable.
   *
   * The three commands below take the {@link OrchestrationOutput} to write
   * through, rather than printing for themselves: their output belongs in the
   * REPL's own line stream (and therefore in the `DispatchResult`), not on a
   * console the renderer does not know about.
   */
  readonly plan?: (
    objective: string,
    output: OrchestrationOutput,
  ) => Promise<number>;
  /** Runs `/runs` — the recorded orchestration runs of this workspace. */
  readonly runs?: (output: OrchestrationOutput) => Promise<number>;
  /** Runs `/resume-run <runId>` — see `resume-cmd.ts`. */
  readonly resumeRun?: (
    runId: string,
    output: OrchestrationOutput,
  ) => Promise<number>;
  /**
   * Runs `/config` — the setup wizard — and returns the saved configuration,
   * or `undefined` when it was cancelled. Absent means there is no terminal to
   * run it on, and `/config` says so instead.
   */
  readonly configure?: () => Promise<KapelConfig | undefined>;
  /**
   * Working-tree checkpoints for `/undo`. Absent means the feature is off and
   * `/undo` says so — which is what a caller with no filesystem to snapshot
   * (the tests) gets by simply not passing one.
   */
  readonly checkpoints?: CheckpointStore;
  /**
   * Decides whether an `@mention` names a real workspace file, for the
   * send-time annotation. Defaults to a containment-checked `stat` under
   * {@link workspacePath}; tests override it to keep the decision in memory.
   */
  readonly fileExists?: (relativePath: string) => boolean | Promise<boolean>;
  readonly newId?: () => string;
  readonly now?: () => number;
  /**
   * Scans `.agent/commands/*.md` for custom slash commands (P1-4). Defaults
   * to the real filesystem scan rooted at {@link workspacePath}; tests
   * substitute a fake source to avoid touching disk. Runs once when the
   * controller is built and again on every `/help` — see the comment above
   * {@link loadCustomCommands}, which is cheap enough for both.
   */
  readonly customCommands?: () => Promise<LoadCustomCommandsResult>;
  /**
   * Called after every custom-command scan (initial load and each `/help`
   * rescan) with the names found, so a caller that built its Tab completer
   * before the controller existed (the REPL's `InputManager` has to — see
   * `runInteractive`) can keep offering current names without re-scanning
   * itself.
   */
  readonly onCustomCommandsChanged?: (names: readonly string[]) => void;
}

/** The REPL's brain: everything a typed line can do, with no terminal in sight. */
export interface InteractiveController {
  sessionId(): string;
  title(): string;
  /** This conversation's `/name`d label, or `undefined` when it has none. */
  name(): string | undefined;
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
  /**
   * The command's argument vocabulary, when it has a finite and knowable one.
   *
   * Only `/model` does. `/resume` takes a session id — finite, but a property
   * of the store rather than of the command, and the ids are already one
   * `/sessions` away; `/orchestrate` takes free-form English; everything else
   * takes nothing at all. Completing a word the command does not actually
   * accept would be worse than completing nothing, so this stays empty
   * wherever the vocabulary is not genuinely closed.
   */
  readonly args?: readonly string[];
}

/**
 * The aliases `/model` can switch to — the built-in catalog's ids.
 *
 * A delegated backend will accept names beyond this list (the external CLI
 * owns that vocabulary), which is why `/model` itself does not validate
 * against the catalog; offering it on Tab is a shortcut for the common case,
 * not a constraint on what may be typed.
 */
function modelAliases(): readonly string[] {
  return Object.keys(defaultModelCatalog()).sort();
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
    usage: "/resume <id|name>",
    help: "switch to a stored conversation",
  },
  {
    name: "name",
    usage: "/name [name]",
    help: "show, or set, this conversation's name",
  },
  {
    name: "fork",
    usage: "/fork [name]",
    help: "branch this conversation into a new session",
  },
  {
    name: "model",
    usage: "/model [alias]",
    help: "show or switch the model for future turns",
    args: modelAliases(),
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
    name: "undo",
    usage: "/undo",
    help: "restore the files to before the last prompt",
  },
  {
    name: "plan",
    usage: "/plan <objective>",
    help: "plan an objective and show the routing — nothing is executed",
  },
  {
    name: "orchestrate",
    usage: "/orchestrate <objective>",
    help: "run the multi-agent pipeline on an objective",
  },
  { name: "runs", usage: "/runs", help: "list this workspace's recorded runs" },
  {
    name: "resume-run",
    usage: "/resume-run <runId>",
    help: "re-execute the unfinished tasks of a recorded run (see /runs)",
  },
];

/**
 * Tab completion for slash commands, in two halves.
 *
 * Before the first space, `/` plus a prefix completes the command *name*
 * against {@link SLASH_COMMANDS} plus `customNames` — the custom commands
 * found under `.agent/commands/` (P1-4), appended after the built-ins so a
 * name collision (already resolved by {@link loadCustomCommands} in favor of
 * the built-in) never shows up twice. After the first space, the last word
 * completes against that command's {@link SlashCommand.args} — the model
 * aliases for `/model`, nothing for anything else (including every custom
 * command, whose arguments are free-form `$ARGUMENTS` text with no closed
 * vocabulary to guess at). A line that is not a slash command offers no
 * completions. Matches `readline`'s synchronous `Completer` shape.
 */
export function slashCompleter(
  line: string,
  customNames: readonly string[] = [],
): CompleterResult {
  if (!line.startsWith("/")) return [[], line];

  const space = line.indexOf(" ");
  if (space === -1) {
    const names = [
      ...SLASH_COMMANDS.map((command) => `/${command.name}`),
      ...customNames.map((name) => `/${name}`),
    ];
    const hits = names.filter((name) => name.startsWith(line));
    return [hits.length > 0 ? hits : names, line];
  }

  const name = line.slice(1, space).toLowerCase();
  const values = SLASH_COMMANDS.find((command) => command.name === name)?.args;
  if (values === undefined || values.length === 0) return [[], line];

  // Only the word under the cursor is replaced, so `/model claude-` completes
  // in place instead of swallowing the command that precedes it.
  const argument = line.slice(space + 1);
  const partial = argument.slice(argument.lastIndexOf(" ") + 1);
  const hits = values.filter((value) => value.startsWith(partial));
  return [hits.length > 0 ? [...hits] : [...values], partial];
}

/**
 * The REPL's one completer: `@` mentions when a mention is being typed, slash
 * commands otherwise.
 *
 * Routing on the token under the cursor rather than on the first character of
 * the line is what lets the two coexist — `@` wins wherever it appears
 * (including inside a slash command's arguments), `/` only ever applies to a
 * line that starts with one, and a plain sentence gets neither.
 *
 * Async only when it has to be: the slash half returns its tuple directly, and
 * only the mention half — which may spawn `git ls-files` — returns a promise.
 * Without a {@link FileLister} (no workspace to list) the mention half is
 * simply absent and every line falls through to {@link slashCompleter}.
 *
 * `customNames` is a getter rather than a static list because this completer
 * is built once, before the controller exists (see `runInteractive` — the
 * `InputManager` it is wired into has to precede the controller, which needs
 * the `InputManager` to build its first session), while the controller's own
 * view of `.agent/commands/` can change on every `/help`. Reading through a
 * getter is what lets the two stay in sync without the completer re-scanning
 * anything itself.
 */
export function createReplCompleter(
  files?: FileLister,
  customNames?: () => readonly string[],
): InputCompleter {
  return (line: string): CompleterResult | Promise<CompleterResult> => {
    if (files !== undefined) {
      const token = mentionTokenAt(line);
      if (token !== undefined) return completeMention(files, token);
    }
    return slashCompleter(line, customNames?.() ?? []);
  };
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
 * `undefined` when `candidate` is a usable `/name`/`/fork` label; the
 * printable reason otherwise. Empty is rejected because a name that reads
 * back as "(unnamed)" is not a name; a leading `/` is rejected because
 * `/resume that-name` would otherwise be indistinguishable from a slash
 * command. Everything else is accepted as typed — trimming is the caller's
 * job (both `/name` and `/fork` already hand this the trimmed argument).
 */
export function invalidSessionName(candidate: string): string | undefined {
  if (candidate === "") return "a name cannot be empty.";
  if (candidate.startsWith("/")) {
    return 'a name cannot start with "/" — that would be ambiguous with slash commands.';
  }
  return undefined;
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
  const builtinCommandNames = new Set(
    SLASH_COMMANDS.map((command) => command.name),
  );
  const loadCommands =
    deps.customCommands ??
    (() => loadCustomCommands(deps.workspacePath, builtinCommandNames));

  let backend: BackendName = deps.backend ?? "native";
  let modelAlias = deps.modelAlias;
  let model = deps.model;
  let provider = deps.provider;

  let sessionId = deps.start.sessionId;
  let title = deps.start.title;
  let sessionName = deps.start.name;
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

  // P1-4: custom slash commands from `.agent/commands/*.md`. Scanned once
  // here (below, after `handleMessage` exists) and again on every `/help` —
  // both scans are the same cheap directory read, so staleness between the
  // two never lasts longer than one `/help` away.
  let customCommands: readonly CustomCommand[] = [];
  let customCommandWarnings: readonly string[] = [];
  const refreshCustomCommands = async (): Promise<void> => {
    const result = await loadCommands();
    customCommands = result.commands;
    customCommandWarnings = result.warnings;
    deps.onCustomCommandsChanged?.(
      customCommands.map((command) => command.name),
    );
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

  const fileExists =
    deps.fileExists ??
    ((relativePath: string) =>
      workspaceFileExists(deps.workspacePath, relativePath));

  const handleMessage = async (
    text: string,
    signal?: AbortSignal,
  ): Promise<DispatchResult> => {
    // The checkpoint is taken here rather than in `handleLine` because this is
    // the one place a line is known to be about to start a turn: a slash
    // command changes no files and would only push the real work off the end
    // of a 20-deep stack. It covers the delegated backends too — an external
    // CLI edits the same working tree kapel is standing in.
    const checkpointWarning = await deps.checkpoints?.capture(text);
    if (checkpointWarning !== undefined) emit(checkpointWarning);

    if (title === "") {
      title = chatTitleFrom(text);
      titleDirty = true;
    }

    // `@path` mentions stay verbatim in the message and gain one trailing
    // line naming the files they resolved to (see `annotateMentions`). The
    // title and the checkpoint label above deliberately come from the text as
    // typed — the annotation is for the agent, not for the history.
    const instruction = await annotateMentions(text, fileExists);

    const before = deps.usage.totals();
    let result: ChatTurnLike | undefined;
    try {
      result = await chat.send(instruction, {
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

  const slashHelp = async (): Promise<DispatchResult> => {
    // Rescanned here (as well as once at controller start) so a command file
    // added or fixed mid-session shows up without restarting the REPL — the
    // scan is one directory read plus one `readFile` per command, cheap
    // enough to redo on every `/help`.
    await refreshCustomCommands();

    emit("commands:");
    const width = Math.max(
      ...SLASH_COMMANDS.map((command) => command.usage.length),
    );
    for (const command of SLASH_COMMANDS) {
      emit(`  ${command.usage.padEnd(width)}  ${command.help}`);
    }
    emit("anything else is sent to the agent.");

    if (customCommands.length > 0) {
      emit("");
      emit("custom commands (.agent/commands/):");
      const customWidth = Math.max(
        ...customCommands.map((command) => command.name.length + 1),
      );
      for (const command of customCommands) {
        const usage = `/${command.name}`.padEnd(customWidth);
        emit(`  ${usage}  ${command.description ?? "(no description)"}`);
      }
    }
    for (const warning of customCommandWarnings) {
      emit(`warning: ${warning}`);
    }
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
    // A NAME column only when it would say something — matching `kapel
    // sessions`'s own listing (`sessionRow` in `sessions.ts`), so a
    // workspace nobody has ever run `/name` in does not grow a column of
    // blanks.
    const showName = records.some((record) => record.name !== undefined);
    const rows = records.map((record) => {
      // The conversation this REPL is on gets a marker of its own column, so
      // the ids stay in one straight line.
      const row = [record.id === sessionId ? "*" : "", shortId(record.id)];
      if (showName) row.push(record.name ?? "");
      row.push(
        isoTime(record.updatedAt),
        String(record.messageCount),
        record.title === "" ? "(untitled)" : record.title,
      );
      return row;
    });
    const headers = showName
      ? ["", "ID", "NAME", "UPDATED", "MSGS", "TITLE"]
      : ["", "ID", "UPDATED", "MSGS", "TITLE"];
    for (const line of formatTable(headers, rows)) {
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
      emit("usage: /resume <id|name>  — see /sessions");
      return drain();
    }
    const records = await listRecords();
    // P1-8: `resolveChatSessionReference` accepts a `/name`d session as
    // readily as an id or an id prefix — `onNote` is how it tells us "two
    // sessions share that name, resolved to the newer one" without treating
    // the ambiguity as an error.
    const matched = resolveChatSessionReference(records, argument, {
      onNote: (note) => emit(note),
    });
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
    sessionName = transcript.record.name;
    persisted = true;
    titleDirty = false;
    await build(transcript.messages);
    emit(
      `resumed ${title === "" ? shortId(sessionId) : title} (${transcript.messages.length} messages)`,
    );
    return drain("resumed");
  };

  /**
   * `/name [name]` — show or set this conversation's user-given label.
   *
   * Bare `/name` reads it back rather than doing anything, which is what
   * makes it safe to run just to check. Setting it persists immediately
   * (rather than waiting for the next message, the way the auto-derived
   * `title` does) because naming a session is itself the whole point of
   * running the command — a name nobody can see again until the next turn
   * would not be worth having.
   */
  const slashName = async (argument: string): Promise<DispatchResult> => {
    if (argument === "") {
      emit(sessionName === undefined ? "(unnamed)" : sessionName);
      return drain();
    }
    const problem = invalidSessionName(argument);
    if (problem !== undefined) {
      emit(problem);
      return drain();
    }

    sessionName = argument;
    if (deps.store === undefined) {
      emit(
        `named "${sessionName}" for this run (not persisted — sessions are not being recorded, --no-save).`,
      );
      return drain();
    }
    try {
      if (!persisted) {
        // Mirrors `persist()`'s lazy row creation, but on purpose skips its
        // "nothing was said yet" guard: naming *is* the thing the user asked
        // to happen, unlike the title, which only exists as a side effect of
        // a message being sent.
        await deps.store.createChatSession({
          id: sessionId,
          workspacePath: deps.workspacePath,
          title,
          name: sessionName,
          modelAlias,
          createdAt: now(),
        });
        persisted = true;
        titleDirty = false;
      } else {
        await deps.store.renameChatSession(sessionId, sessionName);
      }
    } catch (error) {
      emit(`(not saved: ${errorText(error)})`);
      return drain();
    }
    emit(`named "${sessionName}"`);
    return drain("renamed");
  };

  /**
   * `/fork [name]` — branch this conversation (everything said up to now)
   * into a new, independent session and switch this REPL onto it, the same
   * way `/resume` switches onto a stored one.
   *
   * The source has to actually be in the store for `SqliteSessionStore.
   * forkChatSession` to copy — `persist()` here covers the ordinary case (a
   * few turns have already been saved along the way) and also the one where
   * every one of them landed this same turn; a conversation that has never
   * said anything at all still has nothing to fork, which is reported rather
   * than silently forking an empty session.
   */
  const slashFork = async (argument: string): Promise<DispatchResult> => {
    if (deps.store === undefined) {
      emit(
        "sessions are not being recorded (--no-save), so there is nothing to fork.",
      );
      return drain();
    }
    if (argument !== "") {
      const problem = invalidSessionName(argument);
      if (problem !== undefined) {
        emit(problem);
        return drain();
      }
    }

    await persist();
    if (!persisted) {
      emit("nothing to fork yet — say something first.");
      return drain();
    }

    const forkName = argument === "" ? undefined : argument;
    let newSessionId: string;
    try {
      newSessionId = await deps.store.forkChatSession(
        sessionId,
        forkName === undefined ? {} : { name: forkName },
      );
    } catch (error) {
      emit(`could not fork: ${errorText(error)}`);
      return drain();
    }

    // The new session's row (title, model, transcript) was just written by
    // the store from `sessionId`'s own row, so what's already in memory —
    // `chat.toModelMessages()` — is exactly its transcript; no need to read
    // it back. `title` itself carries over untouched (the store copied it
    // verbatim); only `sessionName` does *not* — a fork is unnamed unless
    // this command named it, even when the source had a name (see
    // `ForkChatSessionOptions`).
    const messages = chat.toModelMessages();
    sessionId = newSessionId;
    sessionName = forkName;
    persisted = true;
    titleDirty = false;
    await build(messages);
    emit(
      `forked to ${shortId(sessionId)}${forkName === undefined ? "" : ` (${forkName})`} — now on the new session.`,
    );
    return drain("forked");
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

  /**
   * `/undo` — put the working tree back the way it was before the last prompt.
   *
   * One-way by design: the checkpoint that was just restored is popped and
   * there is no `/redo`. Redo would mean keeping a snapshot of the state the
   * user just asked to throw away and then re-applying it over whatever they
   * did next, which is a merge, not an undo.
   */
  const slashUndo = async (): Promise<DispatchResult> => {
    if (deps.checkpoints === undefined) {
      emit("/undo is not available here.");
      return drain();
    }
    for (const line of undoLines(await deps.checkpoints.undo())) emit(line);
    return drain();
  };

  /**
   * The sink `/plan`, `/runs` and `/resume-run` write through.
   *
   * Everything they produce — tables, notes, and the "run `kapel policy
   * compile` first" kind of failure — lands as REPL lines, which is what puts
   * it in front of the renderer and in the dispatch result the tests read.
   * `error` deliberately goes to the same place: there is no stderr worth
   * separating out at a prompt.
   */
  const replOutput: OrchestrationOutput = { log: emit, error: emit };

  /**
   * `/plan <objective>` — the plan `/orchestrate` would execute, printed and
   * then thrown away. Always with the routing rationale, which used to be a
   * flag of its own: at a prompt the table and the reason behind it are one
   * thought, and the alternative is another thing to remember to type.
   */
  const slashPlan = async (objective: string): Promise<DispatchResult> => {
    if (deps.plan === undefined) {
      emit("/plan is not available here.");
      return drain();
    }
    if (objective === "") {
      emit('usage: /plan "<objective>"');
      return drain();
    }
    try {
      await deps.plan(objective, replOutput);
    } catch (error) {
      // A failed plan (stale policy lock, unusable planner model, …) is a
      // thing to fix and retry, not a reason to lose the conversation.
      emit(errorText(error));
    }
    return drain();
  };

  /** `/runs` — the recorded runs, newest first, so `/resume-run` has an id to take. */
  const slashRuns = async (): Promise<DispatchResult> => {
    if (deps.runs === undefined) {
      emit("/runs is not available here.");
      return drain();
    }
    try {
      await deps.runs(replOutput);
    } catch (error) {
      emit(errorText(error));
    }
    return drain();
  };

  /**
   * `/resume-run <runId>` — finish a run that stopped part-way.
   *
   * Named around `/resume`, which was already taken by the conversation
   * switcher: a run and a chat session are different things with different
   * ids, and one command that guessed which was meant would be wrong at the
   * worst possible moment.
   */
  const slashResumeRun = async (runId: string): Promise<DispatchResult> => {
    if (deps.resumeRun === undefined) {
      emit("/resume-run is not available here.");
      return drain();
    }
    if (runId === "") {
      emit("usage: /resume-run <runId>  — see /runs");
      return drain();
    }
    try {
      await deps.resumeRun(runId, replOutput);
    } catch (error) {
      emit(errorText(error));
    }
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

  /**
   * Runs a custom command (P1-4): its template, expanded against whatever
   * followed the command name (see `expandCustomCommand`), is sent exactly
   * like a typed message — through `handleMessage`, so checkpoints, mention
   * annotation and history all apply the same as they would if the user had
   * pasted the expanded text in themselves.
   *
   * `model` in the command's front matter pins *this one turn* to that
   * model, native backend only: the session is rebuilt onto it (the same
   * mechanism `/model` uses), the turn runs, and the session is rebuilt back
   * onto whatever model was live before — so the switch never outlives the
   * command and never shows up in `/model`. A delegated backend has no
   * catalog to resolve a pin against (the external CLI owns that), and an
   * alias `resolveModel` cannot resolve is exactly the same shape of
   * problem `/model` already reports — both cases run the turn anyway, on
   * the session's current model, with one line explaining why the pin was
   * skipped.
   */
  const dispatchCustomCommand = async (
    command: CustomCommand,
    argument: string,
    signal?: AbortSignal,
  ): Promise<DispatchResult> => {
    const instruction = expandCustomCommand(command, argument);

    if (command.model === undefined) {
      return await handleMessage(instruction, signal);
    }
    if (backend !== "native") {
      emit(
        `note: /${command.name} asks for model "${command.model}", but the ` +
          `${backend} backend has no per-command model to switch — running ` +
          "on the session's current model.",
      );
      return await handleMessage(instruction, signal);
    }
    const resolved = await resolveModel(command.model);
    if ("error" in resolved) {
      emit(
        `note: /${command.name} asks for model "${command.model}": ${resolved.error} — running on the session's current model.`,
      );
      return await handleMessage(instruction, signal);
    }

    const savedAlias = modelAlias;
    const savedModel = model;
    const savedProvider = provider;
    modelAlias = command.model;
    model = resolved.model;
    provider = resolved.provider;
    await rebuildSession(true);
    try {
      return await handleMessage(instruction, signal);
    } finally {
      modelAlias = savedAlias;
      model = savedModel;
      provider = savedProvider;
      await rebuildSession(true);
    }
  };

  const handleSlash = async (
    line: string,
    signal?: AbortSignal,
  ): Promise<DispatchResult> => {
    const space = line.indexOf(" ");
    const name = (space === -1 ? line : line.slice(0, space))
      .slice(1)
      .toLowerCase();
    const argument = space === -1 ? "" : line.slice(space + 1).trim();

    switch (name) {
      case "help":
      case "?":
        return await slashHelp();
      case "exit":
      case "quit":
        return drain("exit");
      case "new":
        return await slashNew();
      case "sessions":
        return await slashSessions();
      case "resume":
        return await slashResume(argument);
      case "name":
        return await slashName(argument);
      case "fork":
        return await slashFork(argument);
      case "model":
        return await slashModel(argument);
      case "config":
        return await slashConfig();
      case "usage":
        emit(usageTotalsLine(deps.usage.totals()));
        // Indented under the total: the same tokens, split by which model
        // spent them. Absent when the usage source cannot attribute anything.
        for (const line of usageRollupLines(
          deps.usage.breakdownBy?.("model") ?? new Map(),
        )) {
          emit(`  ${line}`);
        }
        return drain();
      case "compact":
        return await slashCompact();
      case "undo":
        return await slashUndo();
      case "plan":
        return await slashPlan(argument);
      case "orchestrate":
        return await slashOrchestrate(argument);
      case "runs":
        return await slashRuns();
      case "resume-run":
        return await slashResumeRun(argument);
      default: {
        // P1-4: a name that isn't a built-in may still be a custom command
        // loaded from `.agent/commands/` — checked here, after every
        // built-in, so a custom file can never shadow one.
        const custom = customCommands.find((c) => c.name === name);
        if (custom !== undefined) {
          return await dispatchCustomCommand(custom, argument, signal);
        }
        emit(`Unknown command "/${name}". Type /help for the list.`);
        return drain();
      }
    }
  };

  // P1-4: the one scan a session that never touches `/help` still gets, so
  // custom commands (and tab completion for them, via
  // `onCustomCommandsChanged`) work from the very first prompt.
  await refreshCustomCommands();

  return {
    sessionId: () => sessionId,
    title: () => title,
    name: () => sessionName,
    modelAlias: () => modelAlias,
    backend: () => backend,
    session: () => session,
    banner: (cwd: string) => [
      `kapel v${CLI_VERSION}  ${bannerModel(backend, modelAlias)}  session ${shortId(sessionId)}`,
      cwd,
      ...(isDelegatedBackend(backend) ? [approvalsLine(backend)] : []),
      "type /help for commands, /exit to quit",
      "\\ + Enter for multiline input, ↑/↓ to recall, tab-complete /commands and @files",
      "",
    ],
    handleLine: async (line, signal) => {
      const trimmed = line.trim();
      if (trimmed === "") return { output: [] };
      if (trimmed.startsWith("/")) return await handleSlash(trimmed, signal);
      return await handleMessage(trimmed, signal);
    },
  };
}

// --- The terminal shell -----------------------------------------------------

export interface InteractiveOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutSeconds?: number;
  /** `--no-save`: run the conversation without recording it. Defaults to true. */
  readonly save?: boolean;
  readonly continue?: boolean;
  readonly session?: string;
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
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);
  const instructions = loadInstructions(workspacePath, process.env);
  // P1-5: same permission-rule merge as one-shot runs (run.ts) — defaults <
  // machine config < repo config; a config deny is checked before the
  // session allowlist overlay, so it can never be masked by an 'a' answer.
  const repoPermission = await loadRepoPermissionRules(workspacePath);
  const permissionRules = resolvePermissionRules(
    DEFAULT_PERMISSIONS,
    options.config?.permission,
    repoPermission,
  );

  // `.env` is loaded first so a workspace-local `AGENT_BACKEND`/`AGENT_MODEL`
  // takes part in the precedence chain exactly like a shell variable.
  const backend = (
    await detectBackendSetting(options.backend, process.env, options.config)
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
    const promptState = createPromptState();
    // Approvals answered with "a" are remembered for the life of this REPL,
    // across `/model` and `/config` switches — which is why the allowlist is
    // created here and not inside the per-session engine below.
    const sessionAllowlist = new SessionAllowlist();
    const nativeUsage = new UsageTracker();
    // One ledger per delegating backend rather than one for all of them: a
    // `/config` can switch backends mid-thread, and `/usage` should then say
    // which CLI spent what instead of merging Codex's tokens into Claude
    // Code's line.
    const delegatedUsage = new Map<
      Exclude<BackendName, "native">,
      DelegatedUsage
    >();
    const delegatedUsageFor = (
      target: Exclude<BackendName, "native">,
    ): DelegatedUsage => {
      const existing = delegatedUsage.get(target);
      if (existing !== undefined) return existing;
      const created = new DelegatedUsage();
      delegatedUsage.set(target, created);
      return created;
    };
    // One usage view over both engines, so `/usage` and the per-turn delta
    // read the same however the conversation is being run — and keep adding up
    // across a `/config` that switches from one to the other mid-thread.
    const usage = {
      totals: () => sumTotals(nativeUsage, ...delegatedUsage.values()),
      breakdownBy: (dimension: UsageDimension) =>
        chatUsageBreakdown(
          nativeUsage.breakdownBy(dimension),
          [...delegatedUsage].map(([label, ledger]) => ({
            label,
            totals: ledger.totals(),
          })),
        ),
    };

    // The renderer owns everything the turn puts on screen: streamed assistant
    // text, tool lines, and the status line that fills the silence in between.
    const renderer = new TextRenderer(process.stdout, {
      tokens: () => {
        const totals = usage.totals().usage;
        return totals.inputTokens + totals.outputTokens;
      },
      // A permission question owns the screen while it waits for an answer.
      suspended: () => promptState.active,
    });

    // The turn currently in flight, if any — a persistent `InputManager`
    // never lets go of raw mode long enough for a mid-turn Ctrl-C to reach
    // the process as a real `SIGINT` (see `inputManagerLineSource`), so its
    // `onIdleSigint` reaches the abort controller through this instead.
    const activeTurn: { current: AbortController | undefined } = {
      current: undefined,
    };

    // One lister for the whole REPL: its cache is what keeps a burst of Tabs
    // from spawning `git ls-files` per keystroke.
    const mentionFiles = createFileLister({ workspacePath });

    // P1-4: names tab-completion offers for custom commands. It starts empty
    // and is kept current by `onCustomCommandsChanged` below — the
    // `InputManager` (and its completer) has to exist before the controller
    // does, since the controller's first session is built through the
    // prompter this manager backs, so the completer cannot simply ask the
    // controller for its list at build time.
    const customCommandNames: { current: readonly string[] } = { current: [] };

    const inputManager = interactiveTty
      ? createInputManager({
          input: process.stdin,
          output: process.stdout,
          history: await loadHistory(),
          onHistoryAppend: createHistoryAppender(),
          completer: createReplCompleter(
            mentionFiles,
            () => customCommandNames.current,
          ),
          onIdleSigint: () => activeTurn.current?.abort(),
        })
      : undefined;

    const prompter = createPrompter({
      // There is no `-y` here any more: the REPL is the one place a human is
      // definitely present, so every write still gets asked about.
      yes: false,
      interactive: interactiveTty,
      state: promptState,
      allowlist: sessionAllowlist,
      ...(inputManager === undefined
        ? {}
        : { ask: (query: string) => inputManager.question(query) }),
    });
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
          delegatedUsageFor(target).add(result);
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
        systemPrompt: composeSystemPrompt(
          defaultSystemPrompt(workspacePath),
          instructions,
        ),
        tools: builtinTools().map((tool) => tool.name),
        permissions: DEFAULT_PERMISSIONS,
      };
      return AgentChatSession.restore(
        agentLoopOptions({
          agent,
          provider: args.provider,
          permissions: new PermissionEngine(permissionRules, {
            defaultDecision: "ask",
            overlay: sessionAllowlist,
            ...(prompter === undefined ? {} : { prompter }),
          }),
          usage: nativeUsage,
          events: renderer,
          maxIterations: DEFAULT_MAX_ITERATIONS,
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

    const wizardTty = interactiveTty && process.stdout.isTTY === true;

    const controller = await createInteractiveController({
      workspacePath,
      ...(store === undefined ? {} : { store }),
      createSession,
      // Through the renderer rather than straight to the console: the REPL's
      // own lines land while a turn's status line may still be on screen, and
      // only the renderer knows how to take the cursor back from it.
      write: (line) => {
        renderer.line(line);
      },
      backend,
      modelAlias: chatAlias,
      ...(startup.model === undefined ? {} : { model: startup.model }),
      ...(startup.provider === undefined ? {} : { provider: startup.provider }),
      start: started.start,
      usage,
      // One store for the whole REPL: the checkpoints outlive `/new`,
      // `/resume` and `/model`, because the working tree does too.
      checkpoints: createCheckpointStore({ workspacePath }),
      onCustomCommandsChanged: (names) => {
        customCommandNames.current = names;
      },
      orchestrate: (objective) =>
        runOrchestrate(
          objective,
          orchestrateOptionsFor(options, alias, backend),
        ),
      plan: (objective, output) =>
        runPlan(objective, planOptionsFor(options, alias, backend), { output }),
      runs: (output) =>
        runRunsCommand({ cwd: options.cwd, json: false }, { output }),
      resumeRun: (runId, output) =>
        runResume(runId, resumeOptionsFor(options, backend), { output }),
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
    // P1-8: `--session <name>` matched more than one stored session by name
    // — `resolveStartSession` still picked one (the most recently updated),
    // this just says so, so a name that turns out to be ambiguous is
    // noticed here rather than after acting on the wrong conversation.
    if ("note" in started && started.note !== undefined) {
      console.log(dim(started.note, color));
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

/**
 * `/plan`'s options, derived from the REPL's own settings.
 *
 * `why: true` is not a choice the prompt offers — see `slashPlan` for why the
 * rationale is always printed. The backend is the conversation's own resolved
 * backend, so a REPL running on Claude Code plans through Claude Code, with no
 * API key involved.
 */
function planOptionsFor(
  options: InteractiveOptions,
  alias: string,
  backend: BackendName,
): PlanCommandOptions {
  return {
    cwd: options.cwd,
    json: false,
    model: alias,
    backend,
    why: true,
    ...(options.config === undefined ? {} : { config: options.config }),
  };
}

/** The orchestrate pipeline's options, derived from the REPL's own settings. */
function orchestrateOptionsFor(
  options: InteractiveOptions,
  alias: string,
  backend: BackendName,
): OrchestrateCommandOptions {
  return {
    cwd: options.cwd,
    json: false,
    model: alias,
    dryRun: false,
    backend,
    isolation: DEFAULT_ISOLATION,
    validate: true,
    save: options.save !== false,
    tui: false,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.timeoutSeconds }),
  };
}

/** `/resume-run`'s options: the execution half of {@link orchestrateOptionsFor}. */
function resumeOptionsFor(
  options: InteractiveOptions,
  backend: BackendName,
): ResumeCommandOptions {
  return {
    cwd: options.cwd,
    json: false,
    backend,
    isolation: DEFAULT_ISOLATION,
    validate: true,
    tui: false,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.timeoutSeconds }),
  };
}
