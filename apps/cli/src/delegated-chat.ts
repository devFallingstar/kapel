import type { ModelMessage, UsageTotals } from "@agent/ai";
import type {
  BackendTurnRunner,
  ClaudeCodeBackendOptions,
  DelegatingBackendLike,
} from "@agent/coding-agent";
import {
  BackendChatSession,
  backendTurnRunner,
  ClaudeCodeBackend,
  CodexBackend,
} from "@agent/coding-agent";
import type { EventSink } from "@agent/protocol";
import type { BackendName } from "./backend.js";
import { DEFAULT_SANDBOX_MODE, fullAutoForSandbox } from "./backend.js";

/**
 * The delegated half of interactive mode: a chat whose turns are run by the
 * Codex or Claude Code CLI instead of by kapel's own provider loop.
 *
 * `BackendChatSession` already knows both arrangements — replay the transcript,
 * or hand the backend back its own session id — but it deliberately imports no
 * backend, so *deciding* which one a given CLI supports, and building the
 * process wrapper for it, is this module's job.
 */

export interface DelegatedTurnUsage {
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly costUsd?: number;
}

/**
 * Cumulative usage for a delegated conversation.
 *
 * The native path folds tokens into a `UsageTracker` as the provider reports
 * them; a delegating CLI instead reports one total per turn, cost included, so
 * the REPL's `/usage` and per-turn deltas read from this instead. Same shape,
 * so the controller cannot tell the two apart.
 */
export class DelegatedUsage {
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;

  add(turn: DelegatedTurnUsage): void {
    if (turn.usage !== undefined) {
      this.#inputTokens += turn.usage.inputTokens;
      this.#outputTokens += turn.usage.outputTokens;
    }
    if (turn.costUsd !== undefined) this.#costUsd += turn.costUsd;
  }

  totals(): UsageTotals {
    return {
      usage: {
        inputTokens: this.#inputTokens,
        outputTokens: this.#outputTokens,
      },
      costUsd: this.#costUsd,
    };
  }
}

/** Builds one `ClaudeCodeBackend` per turn. Overridable in tests. */
export type ClaudeCodeBackendFactory = (
  options: ClaudeCodeBackendOptions,
) => DelegatingBackendLike;

export interface ClaudeCodeRunnerOptions {
  readonly model?: string;
  readonly events?: EventSink;
  readonly timeoutMs?: number;
  readonly createBackend?: ClaudeCodeBackendFactory;
}

/**
 * A turn runner that threads Claude Code's own conversation across turns.
 *
 * `claude -p` takes `--resume <session_id>`, where the id is the `session_id`
 * its JSON output reported for the previous turn — but only as a *flag*, which
 * means the backend has to be built per turn rather than once per session.
 * That is exactly what this closure does:
 *
 * - **First turn** — no session id yet, so the backend is built plain and the
 *   transcript (empty for a new chat, the stored history for a `/resume`d one)
 *   is rendered into the prompt as context.
 * - **Later turns** — `BackendChatSession` was told `supportsContinuation: true`,
 *   so it hands back the id and an *empty* transcript; the backend is built with
 *   `extraArgs: ["--resume", id]` and nothing is re-sent, because the thread
 *   already lives on Claude Code's side.
 *
 * Codex has no equivalent: `codex exec resume` exists, but `codex exec --json`
 * is not verified to report a resumable id and `CodexBackend` surfaces none, so
 * Codex chats stay stateless (see {@link createDelegatedChatSession}).
 */
export function claudeCodeTurnRunner(
  options: ClaudeCodeRunnerOptions = {},
): BackendTurnRunner {
  const create: ClaudeCodeBackendFactory =
    options.createBackend ??
    ((backendOptions) => new ClaudeCodeBackend(backendOptions));

  return async (request) => {
    const resume = request.sessionRef;
    const backend = create({
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(resume === undefined ? {} : { extraArgs: ["--resume", resume] }),
    });

    // Resuming and replaying are mutually exclusive: re-sending the thread to a
    // session that already holds it would only duplicate it.
    return await backendTurnRunner(backend, {
      promptWithTranscript: resume === undefined,
    })(request);
  };
}

export interface DelegatedChatOptions {
  readonly backend: Exclude<BackendName, "native">;
  readonly workspacePath: string;
  /** The chat session id, used as the run id of every turn it runs. */
  readonly runId: string;
  readonly model?: string;
  readonly events?: EventSink;
  readonly timeoutMs?: number;
  /** Prior conversation, as persisted by the native path. */
  readonly messages?: readonly ModelMessage[];
  /**
   * The backend's own session id to keep continuing, when the conversation is
   * being rebuilt in place (`/model`) rather than started or resumed. It is
   * never restored from the store: a new process has no live backend session.
   */
  readonly sessionRef?: string;
  /** Test seam: replaces the runner this would otherwise build. */
  readonly runner?: BackendTurnRunner;
  readonly createClaudeCodeBackend?: ClaudeCodeBackendFactory;
}

/**
 * Builds the chat for a delegated backend, restored from the same
 * `chat_messages` snapshot the native path persists.
 *
 * Claude Code gets continuation; Codex gets transcript replay. Neither gets a
 * `PermissionEngine` — the external CLI enforces its own approvals.
 */
export function createDelegatedChatSession(
  options: DelegatedChatOptions,
): BackendChatSession {
  const claudeCode = options.backend === "claude-code";

  const runner =
    options.runner ??
    (claudeCode
      ? claudeCodeTurnRunner({
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.events === undefined ? {} : { events: options.events }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
          ...(options.createClaudeCodeBackend === undefined
            ? {}
            : { createBackend: options.createClaudeCodeBackend }),
        })
      : backendTurnRunner(
          new CodexBackend({
            ...(options.model === undefined ? {} : { model: options.model }),
            sandbox: DEFAULT_SANDBOX_MODE,
            fullAuto: fullAutoForSandbox(DEFAULT_SANDBOX_MODE),
            ...(options.events === undefined ? {} : { events: options.events }),
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
          }),
        ));

  return BackendChatSession.fromModelMessages(
    {
      runner,
      workspacePath: options.workspacePath,
      runId: options.runId,
      supportsContinuation: claudeCode,
      ...(options.events === undefined ? {} : { events: options.events }),
    },
    options.messages ?? [],
    options.sessionRef,
  );
}
