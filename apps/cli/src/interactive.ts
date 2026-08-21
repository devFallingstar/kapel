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
import type { AgentDefinition, AgentImageAttachment } from "@agent/core";
import type {
  ChatSessionRecord,
  ChatSessionTranscript,
  ForkChatSessionOptions,
  ListChatSessionsOptions,
  NewChatSession,
  NewUsageEvent,
  PersistedChatMessage,
} from "@agent/session";
import {
  chatTitleFrom,
  defaultSessionDbPath,
  resolveChatSessionReference,
  SqliteSessionStore,
  startOfWindow,
  WEEK_DAYS,
} from "@agent/session";
import type { BackendName, EnvLike } from "./backend.js";
import {
  claudeCodeInstallGuidance,
  claudeCodeLoginGuidance,
  codexInstallGuidance,
  codexLoginGuidance,
  DEFAULT_BACKEND,
  isDelegatedBackend,
} from "./backend.js";
import type { BandDecor } from "./band.js";
import { createBandDecor } from "./band.js";
import type { CheckpointStore } from "./checkpoint.js";
import { createCheckpointStore, undoLines } from "./checkpoint.js";
import type { CustomCommand, LoadCustomCommandsResult } from "./commands.js";
import { expandCustomCommand, loadCustomCommands } from "./commands.js";
import type { KapelBackend, KapelConfig } from "./config.js";
import { soleExecutionBackend } from "./config.js";
import type { KapelProjectConfig } from "./config-project.js";
import { mergeKapelConfigs } from "./config-project.js";
import {
  checkBackendAvailability,
  claudeCodeLoginRunner,
  codexLoginRunner,
  delegatedModelOverride,
  detectBackendSetting,
  resolveOrchestratorModel,
  ttyWizardPrompt,
} from "./config-runtime.js";
import { runConfigWizard } from "./config-wizard.js";
import type {
  BackendState,
  DashboardBackend,
  DashboardModel,
} from "./dashboard.js";
import {
  backendStateFrom,
  dashboardRoles,
  quotaBlockFrom,
  renderDashboard,
} from "./dashboard.js";
import {
  createDelegatedChatSession,
  DelegatedUsage,
} from "./delegated-chat.js";
import { loadDotEnvFile } from "./env.js";
import { createHistoryAppender, loadHistory } from "./history.js";
import { runInit } from "./init.js";
import type {
  CommandMenuEntry,
  CompleterResult,
  InputCompleter,
} from "./input.js";
import {
  CONTINUATION_PROMPT,
  createInputManager,
  INPUT_SIGINT,
  type InputManager,
} from "./input.js";
import { composeSystemPrompt, loadInstructions } from "./instructions.js";
import type { FileLister, MentionImageReader } from "./mention.js";
import {
  completeMention,
  createFileLister,
  mentionTokenAt,
  prepareMentions,
  workspaceFileExists,
  workspaceImagePathReader,
  workspaceImageReader,
} from "./mention.js";
import { createProjectSetup } from "./onboard.js";
import type { OrchestrateCommandOptions } from "./orchestrate.js";
import { DEFAULT_ISOLATION, runOrchestrate } from "./orchestrate.js";
import {
  DEFAULT_PERMISSIONS,
  loadRepoPermissionRules,
  resolvePermissionRules,
} from "./permissions.js";
import type { OrchestrationOutput, PlanCommandOptions } from "./plan.js";
import { formatTable, runPlan } from "./plan.js";
import type { PolicyCompileOptions } from "./policy.js";
import { runPolicyCompile } from "./policy.js";
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
import type { AltScreen } from "./screen.js";
import { enterAltScreen } from "./screen.js";
import { runSelectPrompt } from "./select-prompt.js";
import { isoTime } from "./sessions.js";
import { PLAIN_STYLES, type Styles, stylesFor } from "./styles.js";

/**
 * The CLI's version, shown by `--version` and in the interactive banner. Kept
 * here so both spellings of it come from one place.
 */
export const CLI_VERSION = "0.12.0";

/**
 * How long the startup dashboard waits for the backend login probes before
 * drawing what it has. Each probe spawns an external CLI twice; a REPL that
 * takes a visible pause to open is a worse trade than a `…` in one cell,
 * which `/stats` fills in.
 */
const STARTUP_PROBE_BUDGET_MS = 1000;

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
    images?: readonly AgentImageAttachment[],
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
  /**
   * Runs one turn. `images` and `imagePaths` are the two halves of what an
   * `@shot.png` mention resolved to (see {@link prepareMentions}): the native
   * loop sends the bytes to a provider, a delegated backend hands its CLI the
   * paths and lets it open the files itself. An implementation reads whichever
   * one it can use and ignores the other — the controller fills in only the one
   * this backend asked for, so the unused argument is empty anyway.
   */
  send(
    instruction: string,
    context: AgentLoopRunContext,
    images?: readonly AgentImageAttachment[],
    imagePaths?: readonly string[],
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
    send: (instruction, context, images) =>
      session.send(instruction, context, images),
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
  /**
   * Files what one turn spent — see `SqliteSessionStore.recordUsage`.
   *
   * Optional because it is the one method here that is not load-bearing for
   * the conversation itself: a store that cannot record usage still records
   * the transcript, and the dashboard simply has less to report. In-process
   * `/usage` never reads it; it exists so the numbers survive the process.
   */
  recordUsage?(entry: NewUsageEvent): Promise<void>;
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

/** What the dashboard has to be told about the conversation drawing it. */
export interface DashboardContext {
  readonly sessionId: string;
  readonly backend: BackendName;
  readonly modelAlias: string;
}

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
  /**
   * Finishes this project's setup, uninvited, before `/plan` or
   * `/orchestrate` runs — the same thing the REPL does at startup, run again
   * here for a session that never got the chance (it started
   * non-interactively, or the workspace wasn't ready yet). See `onboard.ts`;
   * the object behind this remembers a failure for the process, so a setup
   * that just failed is not retried on every command.
   *
   * The returned boolean is deliberately not acted on: a project that is
   * still not set up falls through to the command's own error, which says
   * exactly what is missing and how to fix it by hand.
   */
  readonly ensureProjectSetup?: (
    output: OrchestrationOutput,
  ) => Promise<boolean>;
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
   * Backs `/login`: every backend the effective (machine + project) config
   * allows, and how to check and fix each one. Absent means `/login` says so
   * instead of running — same shape of absence as `configure`.
   */
  readonly login?: {
    /** Every backend `mergeKapelConfigs(machine, project)` currently allows. */
    readonly backends: readonly KapelBackend[];
    /** The same probe the wizard uses — see `checkBackendAvailability`. */
    readonly check: (backend: KapelBackend) => Promise<{
      readonly ok: boolean;
      readonly installed?: boolean;
      readonly detail?: string;
    }>;
    /** Read for the native backend's credential variables. */
    readonly env: EnvLike;
    /**
     * Asks a yes/no question at the prompt. Absent (along with
     * `runCodexLogin`) on a non-interactive stdin — `/login` then only ever
     * reports status, never offers to spawn anything.
     */
    readonly confirm?: (question: string) => Promise<boolean>;
    /** Runs `codex login` and re-probes; see `codexLoginRunner`. */
    readonly runCodexLogin?: () => Promise<{
      readonly ok: boolean;
      readonly detail?: string;
    }>;
    /** Runs `claude auth login` and re-probes; see `claudeCodeLoginRunner`. */
    readonly runClaudeCodeLogin?: () => Promise<{
      readonly ok: boolean;
      readonly detail?: string;
    }>;
  };
  /**
   * Backs `/stats` (and, at startup, the banner the shell prints): renders
   * the dashboard for the conversation as it stands right now.
   *
   * A function rather than pre-rendered lines because `/stats` promises
   * *fresh* numbers — it re-probes logins and re-reads the session database,
   * and the conversation may have changed backend, model or session since
   * startup, which is why the current three are passed in. Absent means there
   * is nothing to draw and `/stats` says so, the same shape of absence as
   * {@link configure}.
   */
  readonly dashboard?: (
    context: DashboardContext,
  ) => Promise<readonly string[]>;
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
  /**
   * Reads an `@shot.png` mention into an attachment, for a turn that carries
   * bytes (the native backend). Defaults to a containment-checked, size-capped
   * read under {@link workspacePath}; tests override it to keep the bytes in
   * memory.
   */
  readonly readImage?: MentionImageReader;
  /**
   * The same, for a turn that attaches by path (the delegated backends):
   * validates the mention and answers with the path, reading nothing. Defaults
   * to a containment-checked, size-capped `stat` under {@link workspacePath}.
   */
  readonly readImagePath?: MentionImageReader;
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
   * rescan) with the commands found, so a caller that built its Tab completer
   * before the controller existed (the REPL's `InputManager` has to — see
   * `runInteractive`) can keep offering current names without re-scanning
   * itself.
   *
   * The whole commands, not just their names: the `/` menu shows each one's
   * description beside it, and the scan is the only place that has read them.
   */
  readonly onCustomCommandsChanged?: (
    commands: readonly CustomCommand[],
  ) => void;
  /**
   * The role palette every line this controller emits is painted with (see
   * `styles.ts`).
   *
   * Defaults to {@link PLAIN_STYLES}: a controller is built with no terminal
   * in sight, and the shell — the one layer that knows whether stdout is one —
   * hands in a coloured palette when it is. Which is also what keeps the
   * `DispatchResult.output` the tests read free of escapes.
   */
  readonly styles?: Styles;
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
  {
    name: "login",
    usage: "/login",
    help: "check every configured backend's login status and help fix it",
  },
  { name: "usage", usage: "/usage", help: "tokens and cost so far" },
  {
    name: "stats",
    usage: "/stats",
    help: "redraw the startup dashboard with fresh numbers",
  },
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

/** What `/help` and the `/` menu say about a command file with no `description`. */
const NO_DESCRIPTION = "(no description)";

/**
 * The one command list the REPL shows the user, in both places it shows it:
 * the `/help` table and the live menu that opens under the prompt on `/`.
 *
 * Same array, same order, same sentences — built-ins first, then whatever
 * `.agent/commands/` contributed to *this* session. The menu is a view of the
 * registry, not a second copy of it, so a command can never appear in one and
 * not the other, or describe itself differently in each.
 *
 * `usage` is deliberately not what the menu lists: `/resume <id|name>` is the
 * right thing to read in a table you called up on purpose, and the wrong thing
 * to have flickering under your cursor while you type — the name is what you
 * are matching against, and the argument shape is one `/help` away.
 */
export function replCommandMenuEntries(
  custom: readonly CustomCommand[] = [],
): readonly CommandMenuEntry[] {
  return [
    ...SLASH_COMMANDS.map((command) => ({
      name: `/${command.name}`,
      description: command.help,
    })),
    ...custom.map((command) => ({
      name: `/${command.name}`,
      description: command.description ?? NO_DESCRIPTION,
    })),
  ];
}

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
 * The banner's tail: who enforces approvals, and how to drive the prompt.
 *
 * Shared by both openings — the plain banner below and the dashboard the
 * shell draws on a terminal — so the two can never drift into telling the
 * user different things about the same REPL.
 */
export function bannerHints(backend: BackendName): readonly string[] {
  return [
    ...(isDelegatedBackend(backend) ? [approvalsLine(backend)] : []),
    "type /help for commands, /exit to quit",
    "\\ + Enter for multiline input, ↑/↓ to recall, tab-complete /commands and @files",
    "",
  ];
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
    deps.onCustomCommandsChanged?.(customCommands);
  };

  /**
   * The controller's voice, in roles (see `styles.ts`). Plain unless the shell
   * handed in a terminal's palette.
   *
   * The distinction each `emit*` below encodes: `emit` is *the answer you
   * asked for* (a model name, a table body, a dashboard already styled by its
   * own renderer) and stays undecorated; `emitNotice` is kapel remarking on
   * the session; `emitHeading` titles a block; and warn/error are exactly what
   * they say, so red and yellow keep meaning something.
   */
  const styles = deps.styles ?? PLAIN_STYLES;

  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    deps.write(line);
  };
  const emitNotice = (line: string): void => {
    emit(styles.notice(line));
  };
  const emitHeading = (line: string): void => {
    emit(styles.heading(line));
  };
  const emitWarn = (line: string): void => {
    emit(styles.warn(line));
  };
  const emitError = (line: string): void => {
    emit(styles.error(line));
  };
  const emitOk = (line: string): void => {
    emit(styles.ok(line));
  };
  const drain = (effect?: InteractiveEffect): DispatchResult => {
    const output = lines.slice();
    lines.length = 0;
    return effect === undefined ? { output } : { output, effect };
  };

  /**
   * Makes sure this conversation has a row in the store, creating it if not.
   *
   * Row creation is lazy on purpose — a `kapel` invocation someone opened and
   * closed without doing anything should not leave an empty conversation
   * behind in `/sessions` — so this is called from each of the three places
   * that count as *doing* something: the first message (through
   * {@link persist}), `/name`, and the slash commands that record a run
   * (see {@link registerForRun}).
   *
   * `label` titles a session that has none yet, so a conversation that began
   * with `/orchestrate …` reads as that objective in `kapel sessions` instead
   * of as `(untitled)`.
   *
   * @returns whether there is now a row to write to.
   */
  const registerSession = async (label?: string): Promise<boolean> => {
    if (persisted) return true;
    const store = deps.store;
    if (store === undefined) return false;
    if (title === "" && label !== undefined) title = chatTitleFrom(label);
    try {
      await store.createChatSession({
        id: sessionId,
        workspacePath: deps.workspacePath,
        title,
        ...(sessionName === undefined ? {} : { name: sessionName }),
        modelAlias,
        createdAt: now(),
      });
      persisted = true;
      titleDirty = false;
      return true;
    } catch (error) {
      emitWarn(`(not saved: ${errorText(error)})`);
      return false;
    }
  };

  /**
   * Writes the whole transcript back, keyed by position.
   *
   * The snapshot is written in full rather than incrementally because the
   * loop rewrites history as it goes (tool calls get sealed, results get
   * elided during compaction); `(sessionId, seq)` is the row's identity, so
   * re-saving overlapping messages updates them instead of duplicating them.
   */
  const persist = async (): Promise<void> => {
    const store = deps.store;
    if (store === undefined) return;
    const snapshot = chat.toModelMessages();
    // Nothing was said: there is no conversation to create a row for, and an
    // already-stored one has nothing new to write.
    if (snapshot.length === 0) return;
    if (!(await registerSession())) return;
    try {
      if (titleDirty) {
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
      emitWarn(`(not saved: ${errorText(error)})`);
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
  const readImage = deps.readImage ?? workspaceImageReader(deps.workspacePath);
  const readImagePath =
    deps.readImagePath ?? workspaceImagePathReader(deps.workspacePath);

  /**
   * How *this* turn attaches an image mention.
   *
   * The native path sends provider messages, and `@agent/ai`'s providers
   * serialize `ModelMessage.images` into vision content blocks, so the bytes
   * travel. A delegated turn is a CLI invocation in this very workspace, so the
   * path travels and the CLI opens the file itself (`-i <path>` for Codex, a
   * prompt section for Claude Code — see `BackendTurnRequest`). Read per turn
   * rather than once, because `/config` can switch backends mid-conversation.
   */
  const imageReaderForTurn = (): MentionImageReader =>
    backend === "native" ? readImage : readImagePath;

  /**
   * Files this turn's spend in the session database, as the difference
   * between the cumulative totals before and after it.
   *
   * A difference rather than the running total, because the store's rows are
   * append-only facts about moments: summing them back up has to give the
   * conversation's total, which it only does if each row holds one turn.
   * Best-effort — a store that refuses the write costs the dashboard a turn,
   * never the user their answer.
   */
  const recordTurnUsage = async (
    before: UsageTotals,
    after: UsageTotals,
  ): Promise<void> => {
    const record = deps.store?.recordUsage;
    if (record === undefined || deps.store === undefined) return;
    const inputTokens = after.usage.inputTokens - before.usage.inputTokens;
    const outputTokens = after.usage.outputTokens - before.usage.outputTokens;
    const costUsd = after.costUsd - before.costUsd;
    try {
      await record.call(deps.store, {
        kind: "chat",
        sourceId: sessionId,
        backend,
        model: modelAlias,
        inputTokens: Math.max(0, inputTokens),
        outputTokens: Math.max(0, outputTokens),
        ...(costUsd > 0 ? { costUsd } : {}),
      });
    } catch {
      // best-effort: the conversation is the product, its receipt is not.
    }
  };

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
    if (checkpointWarning !== undefined) emitWarn(checkpointWarning);

    if (title === "") {
      title = chatTitleFrom(text);
      titleDirty = true;
    }

    // `@path` mentions stay verbatim in the message and gain a trailing line
    // naming what they resolved to; an `@shot.png` is additionally attached to
    // the turn — as bytes or as a path, depending on the backend (see
    // `prepareMentions`). The title and the checkpoint label above deliberately
    // come from the text as typed — the annotation is for the agent, not for
    // the history.
    const prepared = await prepareMentions(text, {
      exists: fileExists,
      readImage: imageReaderForTurn(),
    });
    // An image that could not be attached is a note, never a failed turn: the
    // message still goes, with that mention as an ordinary path.
    for (const notice of prepared.notices) emitNotice(notice);

    const before = deps.usage.totals();
    let result: ChatTurnLike | undefined;
    try {
      result = await chat.send(
        prepared.instruction,
        {
          runId: sessionId,
          workspacePath: deps.workspacePath,
          ...(signal === undefined ? {} : { signal }),
        },
        prepared.images,
        prepared.imagePaths,
      );
    } catch (error) {
      emitError(`error: ${errorText(error)}`);
    }

    await persist();

    if (result !== undefined && result.status !== "success") {
      const line = `(${result.status}) ${result.summary}`;
      if (result.status === "failed") emitError(line);
      else emitWarn(line);
    }
    const after = deps.usage.totals();
    await recordTurnUsage(before, after);
    emit(styles.tool(usageDeltaLine(before, after)));
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

    emitHeading("commands:");
    const width = Math.max(
      ...SLASH_COMMANDS.map((command) => command.usage.length),
    );
    for (const command of SLASH_COMMANDS) {
      emit(`  ${command.usage.padEnd(width)}  ${command.help}`);
    }
    emitNotice("anything else is sent to the agent.");

    if (customCommands.length > 0) {
      emit("");
      emitHeading("custom commands (.agent/commands/):");
      const customWidth = Math.max(
        ...customCommands.map((command) => command.name.length + 1),
      );
      for (const command of customCommands) {
        const usage = `/${command.name}`.padEnd(customWidth);
        emit(`  ${usage}  ${command.description ?? NO_DESCRIPTION}`);
      }
    }
    for (const warning of customCommandWarnings) {
      emitWarn(`warning: ${warning}`);
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
    emitNotice(`started a new session ${shortId(sessionId)}`);
    return drain("new-session");
  };

  const slashSessions = async (): Promise<DispatchResult> => {
    if (deps.store === undefined) {
      emitNotice("sessions are not being recorded (--no-save).");
      return drain();
    }
    const records = await listRecords();
    if (records.length === 0) {
      emitNotice(`No chat sessions recorded for ${deps.workspacePath} yet.`);
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
    const table = formatTable(headers, rows);
    table.forEach((line, index) => {
      if (index === 0) emitHeading(line);
      else emit(line);
    });
    return drain();
  };

  const slashResume = async (argument: string): Promise<DispatchResult> => {
    if (deps.store === undefined) {
      emitNotice(
        "sessions are not being recorded (--no-save), so there is none to resume.",
      );
      return drain();
    }
    if (argument === "") {
      emitNotice("usage: /resume <id|name>  — see /sessions");
      return drain();
    }
    const records = await listRecords();
    // P1-8: `resolveChatSessionReference` accepts a `/name`d session as
    // readily as an id or an id prefix — `onNote` is how it tells us "two
    // sessions share that name, resolved to the newer one" without treating
    // the ambiguity as an error.
    const matched = resolveChatSessionReference(records, argument, {
      onNote: (note) => emitWarn(note),
    });
    if ("error" in matched) {
      emitError(matched.error);
      return drain();
    }
    if (matched.record.id === sessionId) {
      emitNotice(`already on ${shortId(sessionId)}`);
      return drain();
    }

    const transcript = await deps.store.loadChatSession(matched.record.id);
    if (transcript === undefined) {
      emitError(`Chat session ${matched.record.id} could not be read.`);
      return drain();
    }

    await persist();
    sessionId = transcript.record.id;
    title = transcript.record.title;
    sessionName = transcript.record.name;
    persisted = true;
    titleDirty = false;
    await build(transcript.messages);
    emitNotice(
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
      emitError(problem);
      return drain();
    }

    sessionName = argument;
    if (deps.store === undefined) {
      emitNotice(
        `named "${sessionName}" for this run (not persisted — sessions are not being recorded, --no-save).`,
      );
      return drain();
    }
    if (!persisted) {
      // Creates the row right here, skipping `persist()`'s "nothing was said
      // yet" guard: naming *is* the thing the user asked to happen, unlike the
      // title, which only exists as a side effect of a message being sent.
      if (!(await registerSession())) return drain();
    } else {
      try {
        await deps.store.renameChatSession(sessionId, sessionName);
      } catch (error) {
        emitWarn(`(not saved: ${errorText(error)})`);
        return drain();
      }
    }
    emitNotice(`named "${sessionName}"`);
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
      emitNotice(
        "sessions are not being recorded (--no-save), so there is nothing to fork.",
      );
      return drain();
    }
    if (argument !== "") {
      const problem = invalidSessionName(argument);
      if (problem !== undefined) {
        emitError(problem);
        return drain();
      }
    }

    await persist();
    if (!persisted) {
      emitNotice("nothing to fork yet — say something first.");
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
      emitError(`could not fork: ${errorText(error)}`);
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
    emitNotice(
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
        emitError(resolved.error);
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
    emitNotice(`model switched to ${modelAlias} — future turns use it.`);
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
      emitWarn("/config needs a terminal — run `kapel config` from one.");
      return drain();
    }

    const config = await deps.configure();
    if (config === undefined) return drain();

    // Still one backend per conversation in this phase: the orchestrator's,
    // since a chat turn is the orchestrator's own work (see
    // `soleExecutionBackend`).
    const nextBackend = soleExecutionBackend(config);
    const nextAlias = config.models.orchestrator.model;
    if (nextBackend === backend && nextAlias === modelAlias) {
      emitNotice("config unchanged.");
      return drain();
    }

    if (nextBackend === "native") {
      const resolved = await resolveModel(nextAlias);
      if ("error" in resolved) {
        // The config is saved either way — it is the machine's setting, not
        // this conversation's — but this REPL keeps what still works.
        emitError(resolved.error);
        emitWarn("keeping the current backend for this conversation.");
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
    emitNotice(`${changes.join(", ")} — future turns use it.`);
    return drain("config-changed");
  };

  /** Whether an env var actually carries a value — mirrors `present` in `config-runtime.ts`. */
  const hasValue = (value: string | undefined): boolean =>
    value !== undefined && value !== "";

  /**
   * `/login` — one line per backend in the effective config, and for any
   * that isn't logged in, the same per-backend fix the wizard offers: codex
   * and claude-code each get an offer to run their own login command right
   * here (`codex login` / `claude auth login`), and native gets the name of
   * the credential variable it's missing.
   *
   * `deps.login` is absent from a test double that doesn't wire it, and its
   * `confirm`/`runCodexLogin`/`runClaudeCodeLogin` are absent whenever stdin
   * isn't interactive — both are `/login`'s way of never asking a question,
   * or spawning anything, nobody can answer.
   */
  const slashLogin = async (): Promise<DispatchResult> => {
    const login = deps.login;
    if (login === undefined) {
      emitWarn("/login is not available here.");
      return drain();
    }

    for (const target of login.backends) {
      if (target === "native") {
        const configured =
          hasValue(login.env.ANTHROPIC_API_KEY) ||
          hasValue(login.env.ANTHROPIC_AUTH_TOKEN) ||
          hasValue(login.env.OPENAI_API_KEY);
        if (configured) emitOk("native: credential present");
        else {
          emitWarn(
            "native: credential missing — set ANTHROPIC_API_KEY, " +
              "ANTHROPIC_AUTH_TOKEN, or OPENAI_API_KEY",
          );
        }
        continue;
      }

      const result = await login.check(target);
      if (result.installed === false) {
        const detail = result.detail === undefined ? "" : ` (${result.detail})`;
        emitWarn(`${target}: not installed${detail}`);
        continue;
      }
      if (result.ok) {
        emitOk(`${target}: logged in`);
        continue;
      }

      emitWarn(`${target}: not logged in`);
      if (target === "codex" || target === "claude-code") {
        const label = target === "codex" ? "Codex" : "Claude Code";
        const loginCmd =
          target === "codex" ? "codex login" : "claude auth login";
        const runLogin =
          target === "codex" ? login.runCodexLogin : login.runClaudeCodeLogin;
        if (login.confirm === undefined || runLogin === undefined) {
          continue;
        }
        const yes = await login.confirm(
          `${label} is installed but not logged in — run \`${loginCmd}\` now?`,
        );
        if (!yes) continue;
        emitNotice(
          `running \`${loginCmd}\` — follow the prompts in your terminal…`,
        );
        const after = await runLogin();
        if (after.ok) emitOk(`${target}: now logged in.`);
        else {
          emitWarn(
            `${target}: still not logged in${after.detail === undefined ? "" : `: ${after.detail}`}`,
          );
        }
      }
    }
    return drain();
  };

  /**
   * `/stats` — the startup dashboard again, with the numbers taken now.
   *
   * Everything it shows can have moved since the banner was printed: turns
   * have been spent, runs have finished, `/config` or `/model` may have
   * changed which backend this conversation talks to, and a backend that was
   * still being probed at startup (its cell drawn as `…`) has had time to
   * answer. So this re-renders rather than replaying — see `deps.dashboard`.
   */
  const slashStats = async (): Promise<DispatchResult> => {
    if (deps.dashboard === undefined) {
      emitWarn("/stats is not available here.");
      return drain();
    }
    for (const line of await deps.dashboard({
      sessionId,
      backend,
      modelAlias,
    })) {
      emit(line);
    }
    return drain();
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
      emitWarn(`/compact is not supported with the ${cli} backend.`);
      return drain();
    }

    const result = await chat.compactNow({
      runId: sessionId,
      workspacePath: deps.workspacePath,
    });
    emitNotice(
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
      emitWarn("/undo is not available here.");
      return drain();
    }
    for (const line of undoLines(await deps.checkpoints.undo())) {
      emitNotice(line);
    }
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
  const replOutput: OrchestrationOutput = { log: emit, error: emitError };

  /**
   * Records this conversation before a slash command that will record a *run*.
   *
   * `/orchestrate` and `/resume-run` write to the run half of the very same
   * `sessions.db` the chat half lives in, so a REPL that only ever ran those
   * used to leave `kapel runs` listing work and `kapel sessions` insisting
   * nothing had been recorded here — two commands over one database
   * disagreeing, which reads as data loss. Registering the session first makes
   * them agree: the run is listed, and so is the conversation it was started
   * from — titled after what it was asked to do, so the listing says something.
   *
   * Only these two commands do it. `/help`, `/usage`, `/sessions` and the rest
   * record nothing anywhere, so a row for them would be the opposite mistake —
   * `kapel sessions` full of empty conversations nobody had.
   */
  const registerForRun = async (label: string): Promise<void> => {
    await registerSession(label);
  };

  /**
   * `/plan <objective>` — the plan `/orchestrate` would execute, printed and
   * then thrown away. Always with the routing rationale, which used to be a
   * flag of its own: at a prompt the table and the reason behind it are one
   * thought, and the alternative is another thing to remember to type.
   */
  const slashPlan = async (objective: string): Promise<DispatchResult> => {
    if (deps.plan === undefined) {
      emitWarn("/plan is not available here.");
      return drain();
    }
    if (objective === "") {
      emitNotice('usage: /plan "<objective>"');
      return drain();
    }
    // A project that was never set up (or whose policy was never compiled)
    // gets set up here automatically, instead of the raw "run `kapel init`
    // first" error. A setup that cannot run here (no terminal, or it already
    // failed) falls through to that error, one line below.
    await deps.ensureProjectSetup?.(replOutput);
    try {
      await deps.plan(objective, replOutput);
    } catch (error) {
      // A failed plan (stale policy lock, unusable planner model, …) is a
      // thing to fix and retry, not a reason to lose the conversation.
      emitError(errorText(error));
    }
    return drain();
  };

  /** `/runs` — the recorded runs, newest first, so `/resume-run` has an id to take. */
  const slashRuns = async (): Promise<DispatchResult> => {
    if (deps.runs === undefined) {
      emitWarn("/runs is not available here.");
      return drain();
    }
    try {
      await deps.runs(replOutput);
    } catch (error) {
      emitError(errorText(error));
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
      emitWarn("/resume-run is not available here.");
      return drain();
    }
    if (runId === "") {
      emitNotice("usage: /resume-run <runId>  — see /runs");
      return drain();
    }
    await registerForRun(`/resume-run ${runId}`);
    try {
      await deps.resumeRun(runId, replOutput);
    } catch (error) {
      emitError(errorText(error));
    }
    return drain();
  };

  const slashOrchestrate = async (
    objective: string,
  ): Promise<DispatchResult> => {
    if (deps.orchestrate === undefined) {
      emitWarn("/orchestrate is not available here.");
      return drain();
    }
    if (objective === "") {
      emitNotice('usage: /orchestrate "<objective>"');
      return drain();
    }
    // Same automatic setup `/plan` runs, for the same reason — see `slashPlan`.
    await deps.ensureProjectSetup?.(replOutput);
    await registerForRun(objective);
    try {
      const code = await deps.orchestrate(objective);
      if (code !== 0) emitWarn(`orchestrate exited ${code}`);
    } catch (error) {
      // A failed pipeline (stale policy lock, dirty worktree, …) is a thing
      // to fix and retry, not a reason to lose the conversation.
      emitError(errorText(error));
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
      emitNotice(
        `note: /${command.name} asks for model "${command.model}", but the ` +
          `${backend} backend has no per-command model to switch — running ` +
          "on the session's current model.",
      );
      return await handleMessage(instruction, signal);
    }
    const resolved = await resolveModel(command.model);
    if ("error" in resolved) {
      emitNotice(
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
      case "login":
        return await slashLogin();
      case "usage":
        emit(usageTotalsLine(deps.usage.totals()));
        // Indented under the total: the same tokens, split by which model
        // spent them. Absent when the usage source cannot attribute anything.
        for (const line of usageRollupLines(
          deps.usage.breakdownBy?.("model") ?? new Map(),
        )) {
          emit(styles.tool(`  ${line}`));
        }
        return drain();
      case "stats":
        return await slashStats();
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
        emitWarn(`Unknown command "/${name}". Type /help for the list.`);
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
      ...bannerHints(backend),
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
  /**
   * This workspace's `.agent/config.local.json` override, when it has one —
   * loaded by the caller, which is the layer that knows the cwd.
   */
  readonly projectConfig?: KapelProjectConfig;
  /**
   * `--no-setup` (commander sets this `false` when the flag is passed): never
   * set the project up automatically. It already skips the first-run wizard
   * before this REPL is built; here it also skips the automatic project setup
   * at startup and its `/plan`/`/orchestrate` fallback, because "don't touch
   * my project without being asked" is one promise, not two. Typing
   * `/config`, `kapel init` or `kapel policy compile` still does the work —
   * those are requests, not something kapel decided on its own.
   */
  readonly setup?: boolean;
  /**
   * `--no-altscreen` (commander sets this `false` when the flag is passed):
   * run the REPL on the terminal's normal screen, the way every version
   * before this one did, instead of on the alternate buffer. The trade is the
   * one documented in the README — a clean screen that leaves no trace, or a
   * transcript your terminal's own scrollback keeps. Only ever consulted on a
   * terminal: a piped or redirected run never switches buffers either way.
   */
  readonly altScreen?: boolean;
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

/**
 * Resolves with `promise`'s value, or with `fallback` once `ms` have passed.
 *
 * The loser is abandoned rather than cancelled — there is nothing to cancel
 * in a subprocess probe already in flight — and the timer is unref'd, so a
 * slow probe can never be the reason the process refuses to exit.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Reads a value from a store that may not be there, or may refuse. */
async function bestEffortValue<T>(
  read: () => Promise<T> | undefined,
): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * The prompt marker: `kapel>` in the user's own colour.
 *
 * It survives for exactly one caller — the piped line source, which writes it
 * to stdout so `kapel chat < script.txt` still produces the interleaved
 * `kapel> …` transcript it always has. A terminal gets no marker at all: the
 * band's two rules say where the input is, far more clearly than a word can,
 * and the message that was typed there is reprinted into the transcript as its
 * own gray bar (see `band.ts`) rather than left as whatever the terminal
 * echoed. A prompt word as well would be labelling a labelled thing.
 */
export function promptMarker(styles: Styles): string {
  return `${styles.user("kapel>")} `;
}

/**
 * What the band's input row is prefixed with: nothing.
 *
 * Named rather than inlined because "" is not obviously a decision, and this
 * is one — see {@link promptMarker}.
 */
export const BAND_PROMPT = "";

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
  // One answer about styling for the whole shell — the renderer, the
  // controller, the dashboard, the prompt marker and the startup lines below
  // all paint from these, so a pipe or `NO_COLOR` silences every one of them
  // together. Two of them, because stdout and stderr can be redirected apart:
  // a run whose transcript is piped to a file still has a terminal to report
  // a setup failure on, and vice versa.
  const styles = stylesFor(process.stdout, process.env);
  const errorStyles = stylesFor(process.stderr, process.env);
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
    await detectBackendSetting(
      options.backend,
      process.env,
      options.config,
      options.projectConfig,
      {
        // "backend: claude-code (auto-detected …)" is kapel remarking on the
        // session, so it wears the notice bar like every other such remark —
        // on stderr, where this announcement has always gone, and in that
        // stream's own palette.
        announce: (line) => {
          console.error(errorStyles.notice(line));
        },
      },
    )
  ).value;
  const modelSetting = resolveOrchestratorModel(
    options.model,
    process.env,
    options.config,
    options.projectConfig,
  );
  const alias = modelSetting.value.model;
  const delegatedModel = delegatedModelOverride(modelSetting);
  // What the conversation calls its model. On a delegated backend with nothing
  // chosen, that is honestly `default` — naming the native catalog's default
  // alias would claim a model the external CLI was never told to use.
  const chatAlias = isDelegatedBackend(backend)
    ? (delegatedModel ?? "default")
    : alias;

  const startup = await startDelegatedOrNative(backend, alias);
  if ("error" in startup) {
    console.error(errorStyles.error(startup.error));
    return 1;
  }

  const interactiveTty = process.stdin.isTTY === true;
  /** True only where a question can actually be asked and answered. */
  const promptTty = interactiveTty && process.stdout.isTTY === true;
  /** …and where the user has not said `--no-setup`. */
  const onboardingTty = promptTty && options.setup !== false;
  /** The effective (machine + this directory's) configuration, merged once. */
  const effectiveConfig = mergeKapelConfigs(
    options.config,
    options.projectConfig,
  )?.config;

  // The REPL's persistent stdin owner, once there is one. Declared out here
  // because `withSuspended` below is used before it exists (automatic project
  // setup runs before the store is even opened) and after — and with no
  // manager it is simply "run the thing", which is exactly right when nothing
  // else holds the terminal.
  let inputManager: InputManager | undefined;

  // The one seam a spawned `codex login`/`claude auth login` (and, alongside
  // it, any picker or yes/no question) hands the terminal through: pause the
  // persistent `InputManager`'s readline around the call, run it, resume. A
  // no-op when there is no `InputManager` at all (piped input, or startup),
  // matching `Suspend`'s own default in `config-runtime.ts`.
  const withSuspended = <T>(fn: () => Promise<T>): Promise<T> =>
    inputManager === undefined ? fn() : inputManager.withSuspended(fn);

  /**
   * The clean screen this session runs on, once it has actually started (see
   * below). Declared out here because the seams that hand the terminal to
   * something else have to be able to take it back.
   */
  let altScreen: AltScreen | undefined;

  /**
   * Repaints whatever the screen is supposed to be showing. Replaced with the
   * real thing once there is a controller to ask; until then there is nothing
   * on screen worth putting back.
   */
  let repaintScreen: () => Promise<void> = async () => {};

  /**
   * {@link withSuspended}, for a child that is a full-screen program in its
   * own right — `codex login`, `claude auth login`. Those drive the
   * terminal's buffers themselves, and one that switches back on the way out
   * would drop this session onto the shell's screen while it is still
   * running. Re-assert ours, then put back what was on it.
   */
  const withSuspendedFullScreen = <T>(fn: () => Promise<T>): Promise<T> =>
    withSuspended(async () => {
      try {
        return await fn();
      } finally {
        if (altScreen?.active === true) {
          altScreen.reenter();
          await repaintScreen();
        }
      }
    });

  /** A yes/no question at the prompt — `/login`'s. */
  const confirmAtPrompt = async (
    question: string,
    initial: "yes" | "no",
  ): Promise<boolean> => {
    const answer = await withSuspended(() =>
      runSelectPrompt(
        { input: process.stdin, output: process.stdout },
        {
          title: question,
          choices: [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ],
          initial,
        },
      ),
    );
    return answer?.[0] === "yes";
  };

  // Automatic project setup (see `onboard.ts`). It has to run before
  // `openChatStore`, which creates a bare `.agent/` of its own for
  // `sessions.db` — after that a fresh directory no longer looks fresh, and
  // `kapel init` would be filling in a directory rather than creating one.
  const projectSetup = createProjectSetup({
    workspacePath,
    init: (output) =>
      runInit({
        cwd: workspacePath,
        // The `.agent/` a previous run left behind (this feature filling in
        // only part of it before failing, or `openChatStore` reaching it
        // first on a piped run) holds nothing but kapel's session database —
        // fill it in, never delete it.
        fill: true,
        output,
        ...(effectiveConfig === undefined ? {} : { config: effectiveConfig }),
      }),
    compile: (output) =>
      runPolicyCompile(policyCompileOptionsFor(options, chatAlias, backend), {
        output,
      }),
    // Nothing runs where nobody would see it — a piped or redirected REPL is
    // never auto-set-up, exactly as it is never asked to configure itself —
    // and nothing runs where `--no-setup` has already said not to.
    interactive: onboardingTty,
  });
  await projectSetup.ensure({
    log: (line) => {
      console.log(styles.notice(line));
    },
    error: (line) => {
      console.error(errorStyles.error(line));
    },
  });

  const store =
    options.save === false ? undefined : await openChatStore(workspacePath);

  try {
    const started = await resolveStartSession(store, workspacePath, {
      ...(options.continue === undefined ? {} : { continue: options.continue }),
      ...(options.session === undefined ? {} : { session: options.session }),
    });
    if ("error" in started) {
      console.error(errorStyles.error(started.error));
      return 1;
    }

    // From here on the conversation owns the screen — a fresh one, the way
    // opening any full-screen terminal program gives you one, and the shell's
    // own scrollback comes back untouched when it ends (see `screen.ts`).
    //
    // Deliberately *here*, after the last thing that can fail with a message
    // worth reading: the backend startup check, the automatic project setup
    // and `resolveStartSession` all report onto the terminal the user keeps,
    // instead of onto a screen that is about to be thrown away. The restore
    // is the `finally` this `try` already has, plus the process-level
    // handlers `enterAltScreen` registers for every way out that never
    // reaches it.
    altScreen = enterAltScreen({
      stdout: process.stdout,
      stdin: process.stdin,
      env: process.env,
      ...(options.altScreen === undefined
        ? {}
        : { enabled: options.altScreen }),
    });

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

    /**
     * The band's strings, for both the halves of the screen that draw it: the
     * renderer's status line while a turn runs, and the `InputManager` while
     * the prompt is open. One object, so the rule over the input and the rule
     * over the spinner can never come out as two different rules.
     *
     * Only on a terminal with a terminal on the other end of stdin, which is
     * exactly the condition an `InputManager` exists under: a piped or
     * redirected run has no band, no rules and no gray bar — it prints the
     * bytes it always printed.
     */
    const band: BandDecor | undefined = promptTty
      ? createBandDecor(styles)
      : undefined;

    // The renderer owns everything the turn puts on screen: streamed assistant
    // text, tool lines, and the band that fills the silence in between.
    const renderer = new TextRenderer(process.stdout, {
      styles,
      ...(band === undefined ? {} : { frame: band }),
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
    // The same scan, in the shape the live `/` menu reads: built-ins plus
    // whatever `.agent/commands/` currently holds, descriptions and all.
    const commandMenu: { current: readonly CommandMenuEntry[] } = {
      current: replCommandMenuEntries(),
    };

    // Held in a local as well as in the outer `inputManager` (which
    // `withSuspended` reads, and which had to exist before this point):
    // narrowing a `let` does not survive into the closures below.
    const manager = interactiveTty
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
          // A continued line still needs *something* in front of it, or the
          // rows of a multiline block read as one paragraph the band happens
          // to be wrapped around. One dim ellipsis, the quietest mark that
          // still says "this line is a continuation of the one above".
          continuationPrompt:
            band === undefined
              ? `${styles.user(CONTINUATION_PROMPT.trimEnd())} `
              : `${styles.tool("…")} `,
          // The live `/` menu: same registry `/help` prints, read per
          // keystroke so a command file added mid-session shows up as soon as
          // the next `/help` has seen it.
          commandMenu: () => commandMenu.current,
          styles,
          ...(band === undefined ? {} : { band }),
        })
      : undefined;
    inputManager = manager;

    const prompter = createPrompter({
      // There is no `-y` here any more: the REPL is the one place a human is
      // definitely present, so every write still gets asked about.
      yes: false,
      interactive: interactiveTty,
      state: promptState,
      allowlist: sessionAllowlist,
      ...(manager === undefined
        ? {}
        : { ask: (query: string) => manager.question(query) }),
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
        // `images` (bytes) is ignored here on purpose: a delegated turn
        // attaches by path, and the controller only ever fills in one of the
        // two for a given backend.
        send: async (instruction, context, _images, imagePaths) => {
          const result = await chat.send(
            instruction,
            {
              ...(context.signal === undefined
                ? {}
                : { signal: context.signal }),
            },
            imagePaths,
          );
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

    const wizardTty = promptTty;

    /**
     * `/login`'s yes/no question — see `slashLogin`. Defaulted to "no":
     * spawning an external CLI's login flow is a bigger step than the file
     * writes and one model call automatic project setup already runs on its
     * own without asking.
     */
    const loginConfirm = (question: string): Promise<boolean> =>
      confirmAtPrompt(question, "no");

    // Every backend this machine (and this directory's override) currently
    // allows — `/login` probes all of them, not just the one this
    // conversation happens to be running on.
    const loginBackends: readonly KapelBackend[] =
      effectiveConfig?.backends ?? [DEFAULT_BACKEND];

    /**
     * The backends the dashboard shows a login glyph for: every one the
     * effective config allows, plus the one this conversation actually runs
     * on if that is not among them.
     *
     * The two can differ — an unconfigured machine falls back to `native` for
     * `loginBackends` while `detectBackendSetting` auto-detects an installed
     * CLI for the chat — and a dashboard whose `chat` row named a backend its
     * `backends` row said nothing about would be reporting on two different
     * REPLs.
     */
    const dashboardBackends: readonly KapelBackend[] = loginBackends.includes(
      backend,
    )
      ? loginBackends
      : [backend, ...loginBackends];

    /**
     * Probes every configured backend's login state for the dashboard.
     *
     * Each probe spawns the CLI twice (`--version`, then `login status`), so
     * on startup it is given a budget: whatever has not answered by then is
     * drawn as `…` and the REPL opens on time. `/stats` passes no budget —
     * by then the user has asked for the answer and can wait for it.
     */
    const probeBackends = async (
      budgetMs?: number,
    ): Promise<readonly DashboardBackend[]> =>
      await Promise.all(
        dashboardBackends.map(async (name): Promise<DashboardBackend> => {
          const pending = checkBackendAvailability(name, process.env)
            .then((result) => ({ name, state: backendStateFrom(result) }))
            // A probe that throws is unknown, not failed: the CLI may be
            // fine and the spawn may not be.
            .catch(() => ({ name, state: "pending" as BackendState }));
          return budgetMs === undefined
            ? await pending
            : await withDeadline(pending, budgetMs, {
                name,
                state: "pending",
              });
        }),
      );

    /**
     * Gathers and renders the dashboard — the shell's opening on a terminal,
     * and `/stats` on demand.
     *
     * Everything it reads is local: the merged configuration, one subprocess
     * probe per backend, and two aggregate queries against the session
     * database. Nothing here goes to the network, and a store that fails to
     * answer costs the activity column, not the dashboard.
     */
    const buildDashboard = async (
      context: DashboardContext,
      budgetMs?: number,
    ): Promise<readonly string[]> => {
      const activity = await bestEffortValue(() => store?.activity());
      const usage =
        store === undefined
          ? []
          : ((await bestEffortValue(() =>
              store.usageByBackend({ since: startOfWindow(Date.now()) }),
            )) ?? []);
      // No store means no numbers to put in it — an empty block would say
      // "this backend spent nothing", which is not what `--no-save` means.
      const quota =
        store === undefined
          ? undefined
          : quotaBlockFrom([...dashboardBackends], usage, WEEK_DAYS);
      const dashboardModel: DashboardModel = {
        version: CLI_VERSION,
        workspacePath,
        sessionId: shortId(context.sessionId),
        chat: bannerModel(context.backend, context.modelAlias),
        backends: await probeBackends(budgetMs),
        roles: dashboardRoles(
          effectiveConfig?.models,
          options.projectConfig?.models,
        ),
        projectOverride: options.projectConfig !== undefined,
        ...(activity === undefined ? {} : { activity }),
        ...(quota === undefined ? {} : { quota }),
      };
      return renderDashboard(dashboardModel, {
        // The shell's own palette, so the box is drawn in the same accent the
        // prompt's rule and the notice bars below it wear — and switched off
        // by the same `NO_COLOR`.
        styles,
        ...(process.stdout.columns === undefined
          ? {}
          : { columns: process.stdout.columns }),
      });
    };

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
      // `/stats`, with no probe budget: an explicit request may wait.
      dashboard: (context) => buildDashboard(context),
      // One store for the whole REPL: the checkpoints outlive `/new`,
      // `/resume` and `/model`, because the working tree does too.
      checkpoints: createCheckpointStore({ workspacePath }),
      onCustomCommandsChanged: (commands) => {
        customCommandNames.current = commands.map((command) => command.name);
        commandMenu.current = replCommandMenuEntries(commands);
      },
      // The one layer that knows stdout is a terminal is the one that decides
      // the controller may write escapes; see `InteractiveControllerDeps.styles`.
      styles,
      // `chatAlias`, not `alias`: on a delegated backend the conversation
      // already decided what it honestly calls its model — the chosen id, or
      // `default` when nobody chose one — and `/plan` and `/orchestrate` must
      // report and forward the same thing the chat does. On the native path
      // the two are the same value.
      orchestrate: (objective) =>
        runOrchestrate(
          objective,
          orchestrateOptionsFor(options, chatAlias, backend),
        ),
      plan: (objective, output) =>
        runPlan(objective, planOptionsFor(options, chatAlias, backend), {
          output,
        }),
      runs: (output) =>
        runRunsCommand({ cwd: options.cwd, json: false }, { output }),
      // The same setup startup ran (or tried to), through the same object —
      // so a failure there is remembered here, and nothing runs twice.
      ensureProjectSetup: (output) => projectSetup.ensure(output),
      resumeRun: (runId, output) =>
        runResume(runId, resumeOptionsFor(options, backend), { output }),
      login: {
        backends: loginBackends,
        check: (target) => checkBackendAvailability(target),
        env: process.env,
        // `confirm`/`runCodexLogin`/`runClaudeCodeLogin` are only ever wired
        // when there is a human at a terminal to ask — a piped
        // `kapel < script.txt` has no `InputManager`, and `/login` must
        // report status only there, never spawn anything nobody can answer.
        ...(manager === undefined
          ? {}
          : {
              confirm: loginConfirm,
              // The login CLIs are full-screen programs of their own, so they
              // go through the seam that takes the screen back afterwards.
              runCodexLogin: codexLoginRunner(
                withSuspendedFullScreen,
                process.env,
              ),
              runClaudeCodeLogin: claudeCodeLoginRunner(
                withSuspendedFullScreen,
                process.env,
              ),
            }),
      },
      ...(wizardTty
        ? {
            // `/config` writes the machine-level file, so what this
            // conversation then obeys is that answer *with this workspace's
            // `.agent/config.local.json` still on top* — an override the
            // directory asked for does not lose to a wizard run somewhere
            // else in the same session.
            configure: async () => {
              const saved = await runConfigWizard({
                // `/config` runs while the REPL's own InputManager still owns
                // stdin — suspend it around the picker (and around a spawned
                // `codex login`/`claude auth login`) so the two don't fight
                // over raw-mode keypresses.
                prompt: ttyWizardPrompt(undefined, withSuspended),
                write: (line) => {
                  console.log(line);
                },
                checkBackend: (target) => checkBackendAvailability(target),
                runCodexLogin: codexLoginRunner(
                  withSuspendedFullScreen,
                  process.env,
                ),
                runClaudeCodeLogin: claudeCodeLoginRunner(
                  withSuspendedFullScreen,
                  process.env,
                ),
                ...(options.config === undefined
                  ? {}
                  : { current: options.config }),
              });
              if (saved === undefined) return undefined;
              return (
                mergeKapelConfigs(saved, options.projectConfig)?.config ?? saved
              );
            },
          }
        : {}),
    });

    /**
     * The session's opening: the dashboard on a terminal, the plain banner
     * off one — a pipe or a redirect keeps the latter, so
     * `kapel chat < script.txt` still produces a transcript with no box
     * drawing and no escape sequences anywhere in it.
     *
     * On the alternate screen this is also the top of the fresh screen, and
     * what goes back on it after a full-screen child process has been there
     * (see `withSuspendedFullScreen`).
     */
    const printOpening = async (): Promise<void> => {
      if (process.stdout.isTTY === true) {
        for (const line of await buildDashboard(
          {
            sessionId: controller.sessionId(),
            backend: controller.backend(),
            modelAlias: controller.modelAlias(),
          },
          STARTUP_PROBE_BUDGET_MS,
        )) {
          console.log(line);
        }
        for (const line of bannerHints(controller.backend())) {
          console.log(styles.notice(line));
        }
      } else {
        for (const line of controller.banner(workspacePath)) console.log(line);
      }
    };
    repaintScreen = printOpening;
    await printOpening();
    const instructionsLine = instructionsBannerLine(instructions.sources);
    if (instructionsLine !== undefined) {
      console.log(styles.notice(instructionsLine));
    }
    if (started.start.persisted) {
      const label =
        started.start.title === ""
          ? shortId(started.start.sessionId)
          : started.start.title;
      console.log(
        styles.notice(
          `resumed ${label} (${started.start.messages.length} messages)`,
        ),
      );
    }
    // P1-8: `--session <name>` matched more than one stored session by name
    // — `resolveStartSession` still picked one (the most recently updated),
    // this just says so, so a name that turns out to be ambiguous is
    // noticed here rather than after acting on the wrong conversation.
    if ("note" in started && started.note !== undefined) {
      console.log(styles.warn(started.note));
    }

    const lineSource =
      manager === undefined
        ? pipedLineSource()
        : inputManagerLineSource(manager);
    try {
      return await replLoop({
        controller,
        lines: lineSource,
        promptState,
        // The band's own row carries no marker; the piped source still writes
        // one, because its transcript is the only place a marker still helps.
        promptText: band === undefined ? promptMarker(styles) : BAND_PROMPT,
        styles,
        activeTurn,
      });
    } finally {
      lineSource.close();
    }
  } finally {
    // The one teardown seam: every way out of the REPL body — `/exit`,
    // Ctrl-D, a double Ctrl-C, a thrown error on its way to `chatAndExit` —
    // passes through here, and the terminal goes back before anything else
    // is printed onto it. The handlers inside `enterAltScreen` cover the ways
    // out that never run a `finally` at all.
    altScreen?.leave();
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
  /** The shell's role palette — plain off a terminal. See `styles.ts`. */
  readonly styles: Styles;
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
  const { controller, lines, promptState, promptText, styles, activeTurn } =
    args;
  let armed = false;

  for (;;) {
    // Nothing is drawn here: the band opens and closes around each read inside
    // the `InputManager`, which is the only thing that knows how many rows the
    // line being typed took and therefore how many the erase has to climb.
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
      console.log(styles.notice("(/exit to quit, Ctrl-C again to force)"));
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
    ...(options.projectConfig === undefined
      ? {}
      : { projectConfig: options.projectConfig }),
  };
}

/**
 * The policy compile's options, derived from the REPL's own settings.
 *
 * Deliberately the same shape as {@link planOptionsFor}: onboarding's compile
 * is the very call `/plan` will make one moment later, so it has to resolve
 * its backend and model the same way — a REPL running on Claude Code compiles
 * through Claude Code, with no API key involved.
 */
function policyCompileOptionsFor(
  options: InteractiveOptions,
  alias: string,
  backend: BackendName,
): PolicyCompileOptions {
  return {
    cwd: options.cwd,
    json: false,
    model: alias,
    backend,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.projectConfig === undefined
      ? {}
      : { projectConfig: options.projectConfig }),
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
    ...(options.projectConfig === undefined
      ? {}
      : { projectConfig: options.projectConfig }),
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
