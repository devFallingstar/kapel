import type { ModelMessage } from "@agent/ai";
import type { AgentEvent, EventSink } from "@agent/protocol";

/**
 * Multi-turn chat served by a *delegating* execution backend — the Claude Code
 * or Codex CLI — instead of the native provider loop.
 *
 * The native path ({@link AgentChatSession}) owns the conversation: it keeps a
 * `ModelMessage[]` and replays it to a provider on every turn, which requires
 * an API credential. A delegating backend instead runs its own agent loop
 * inside the workspace under the user's *subscription* login, so kapel never
 * sees a key — but it also means kapel is no longer the only owner of the
 * conversation state, and there are two possible arrangements:
 *
 * - **Continuation** (`supportsContinuation: true`): the backend remembers the
 *   thread and kapel hands back the backend-native session id it returned last
 *   turn. The transcript is then *not* resent — it lives on the other side.
 *   Verified support: Claude Code's `claude -p … --resume <session_id>` (the
 *   `session_id` reported by `--output-format json` / `stream-json`) and
 *   `codex exec resume <SESSION_ID>` / `codex exec --last`.
 * - **Stateless** (the default): every turn is a fresh backend invocation, so
 *   the prior turns must travel with the instruction. The session keeps the
 *   transcript and passes the most recent {@link
 *   BackendChatSessionOptions.transcriptTurns} entries to the runner.
 *
 * Threading a continuation flag is the caller's job — this module deliberately
 * imports no backend, so a CLI can decide per backend build whether to pass
 * `--resume`/`resume` and simply close over the result. That keeps this file
 * free of process-spawning dependencies and trivially testable offline.
 */

/** One recorded conversation turn. */
export interface BackendChatEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly at: number;
}

/**
 * What a delegating CLI backend must provide to serve a chat turn.
 *
 * Text only, deliberately: there is no `images` here, so a REPL turn that
 * attached one (`@shot.png` — see the CLI's `prepareMentions`) sends the path
 * and says so rather than the bytes. Claude Code's `-p` accepts no image
 * attachment at all (`ClaudeCodeBackend` refuses them outright), and while
 * Codex's `-i <path>` does, wiring it would mean carrying attachments through
 * this request, {@link backendTurnRunner} and {@link DelegatingBackendLike} for
 * one of the two backends. Left undone on purpose; the CLI's notice is the
 * honest interim.
 */
export interface BackendTurnRequest {
  readonly instruction: string;
  /**
   * Prior turns, oldest first, excluding {@link instruction}. Empty when the
   * backend is continuing its own session (see {@link sessionRef}).
   */
  readonly transcript: readonly BackendChatEntry[];
  /**
   * Backend-native session id from the previous turn, present only when the
   * session was told the backend supports continuation and a previous turn
   * reported one.
   */
  readonly sessionRef?: string;
  readonly context: {
    readonly runId: string;
    readonly taskId?: string;
    readonly workspacePath: string;
    readonly signal?: AbortSignal;
  };
}

/** What the backend reports back for one turn. */
export interface BackendTurnOutcome {
  readonly status: "success" | "failed" | "partial";
  readonly summary: string;
  readonly output?: string;
  /** Backend-native session id, threaded into the next turn's request. */
  readonly sessionRef?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly costUsd?: number;
}

/** The one function a {@link BackendChatSession} needs to run a turn. */
export type BackendTurnRunner = (
  request: BackendTurnRequest,
) => Promise<BackendTurnOutcome>;

export interface BackendChatSessionOptions {
  readonly runner: BackendTurnRunner;
  readonly workspacePath: string;
  readonly runId: string;
  readonly events?: EventSink;
  /**
   * When false (the default) the runner receives the transcript and no
   * `sessionRef`; when true it receives the `sessionRef` and an empty
   * transcript, because the backend already holds the history.
   */
  readonly supportsContinuation?: boolean;
  /** Prior entries passed when continuation is unsupported. Default 12. */
  readonly transcriptTurns?: number;
}

/**
 * The outcome of one delegated turn. Deliberately narrower than
 * `ChatTurnResult`: a delegating backend runs its own loop, so per-turn
 * iteration and tool-call counts are not ours to report.
 */
export interface BackendChatTurnResult {
  readonly status: "success" | "failed" | "partial";
  readonly summary: string;
  readonly output?: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly costUsd?: number;
}

export interface BackendChatSendContext {
  readonly signal?: AbortSignal;
  readonly taskId?: string;
}

/** How many prior entries a stateless turn carries by default. */
export const DEFAULT_TRANSCRIPT_TURNS = 12;

/** Per-entry cap when a transcript is rendered into a prompt context block. */
export const TRANSCRIPT_ENTRY_CHARS = 2000;

const CANCELLED_SUMMARY = "Turn cancelled before the backend replied.";

function copyEntry(entry: BackendChatEntry): BackendChatEntry {
  return { role: entry.role, content: entry.content, at: entry.at };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof Error && error.name === "AbortError";
}

/** First value that is a non-empty string, or `undefined`. */
function firstText(
  ...values: readonly (string | undefined)[]
): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * A stateful, multi-turn conversation served by a delegating CLI backend.
 *
 * Sends are single-flight, exactly like `AgentChatSession`: two overlapping
 * turns would interleave appends into one entry list and produce a transcript
 * no backend could make sense of.
 *
 * A turn never rejects for a failure the backend reported *or* threw — both
 * become a `failed` result — because the REPL must stay usable after a bad
 * turn. The only throw is the single-flight guard, which is a caller bug.
 */
export class BackendChatSession {
  readonly #options: BackendChatSessionOptions;
  readonly #entries: BackendChatEntry[] = [];
  #sessionRef: string | undefined;
  #turn = 0;
  #sending = false;

  constructor(options: BackendChatSessionOptions) {
    this.#options = options;
  }

  /**
   * Rebuilds a session from an {@link entries} snapshot and, when the backend
   * supports continuation, the session id that snapshot ended on. Turn
   * numbering resumes from the number of restored user entries so events keep
   * counting up across a process restart.
   */
  static restore(
    options: BackendChatSessionOptions,
    entries: readonly BackendChatEntry[],
    sessionRef?: string,
  ): BackendChatSession {
    const session = new BackendChatSession(options);
    for (const entry of entries) session.#entries.push(copyEntry(entry));
    session.#turn = session.#entries.filter(
      (entry) => entry.role === "user",
    ).length;
    session.#sessionRef = sessionRef;
    return session;
  }

  /**
   * Rebuilds a session from the same `chat_messages` snapshot the native path
   * persists. System and tool messages are dropped — a delegating backend has
   * its own system prompt and runs its own tools — as are empty assistant
   * turns, which on the native path are the tool-call-only ones.
   */
  static fromModelMessages(
    options: BackendChatSessionOptions,
    messages: readonly ModelMessage[],
    sessionRef?: string,
  ): BackendChatSession {
    const at = Date.now();
    const entries: BackendChatEntry[] = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (message.content.trim() === "") continue;
      entries.push({ role: message.role, content: message.content, at });
    }
    return BackendChatSession.restore(options, entries, sessionRef);
  }

  /**
   * Runs one user turn: the instruction is recorded, handed to the runner with
   * either the transcript or the backend's session id, and the reply recorded.
   *
   * The user entry is recorded even when the turn fails, is cancelled, or the
   * runner throws, so the conversation still reads as a conversation. An
   * assistant entry is only recorded when the backend actually produced text.
   *
   * @throws if another send on this session is still in flight.
   */
  async send(
    instruction: string,
    context?: BackendChatSendContext,
  ): Promise<BackendChatTurnResult> {
    if (this.#sending) {
      throw new Error(
        "BackendChatSession.send: a send is already in flight; turns must be serialized.",
      );
    }
    this.#sending = true;

    const signal = context?.signal;
    const taskId = context?.taskId;

    try {
      const prior = this.#entries.map(copyEntry);
      this.#entries.push({
        role: "user",
        content: instruction,
        at: Date.now(),
      });

      this.#turn += 1;
      const turn = this.#turn;
      await this.#emit(taskId, "chat.turn.started", {
        turn,
        backend: "delegated",
      });

      const result = await this.#runTurn(instruction, prior, signal, taskId);

      await this.#emit(taskId, "chat.turn.completed", {
        turn,
        status: result.status,
      });
      return result;
    } finally {
      this.#sending = false;
    }
  }

  /** A defensive copy of the recorded conversation, oldest first. */
  entries(): readonly BackendChatEntry[] {
    return this.#entries.map(copyEntry);
  }

  /** The backend-native session id of the last turn that reported one. */
  sessionRef(): string | undefined {
    return this.#sessionRef;
  }

  /**
   * The conversation as provider messages, so a CLI can persist a delegated
   * chat through the very same `chat_messages` storage the native path uses.
   */
  toModelMessages(): readonly ModelMessage[] {
    return this.#entries.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }

  async #runTurn(
    instruction: string,
    prior: readonly BackendChatEntry[],
    signal: AbortSignal | undefined,
    taskId: string | undefined,
  ): Promise<BackendChatTurnResult> {
    if (signal?.aborted === true) {
      return { status: "failed", summary: CANCELLED_SUMMARY };
    }

    let outcome: BackendTurnOutcome;
    try {
      outcome = await this.#options.runner(
        this.#request(instruction, prior, signal, taskId),
      );
    } catch (error) {
      // A runner that throws is still just a turn that failed: the REPL keeps
      // the conversation and the user can try again.
      return {
        status: "failed",
        summary: isAbort(error, signal)
          ? CANCELLED_SUMMARY
          : errorMessage(error),
      };
    }

    if (outcome.sessionRef !== undefined && outcome.sessionRef !== "") {
      this.#sessionRef = outcome.sessionRef;
    }

    const reply = firstText(outcome.output, outcome.summary);
    if (reply !== undefined) {
      this.#entries.push({
        role: "assistant",
        content: reply,
        at: Date.now(),
      });
    }

    return {
      status: outcome.status,
      summary: outcome.summary,
      ...(outcome.output === undefined ? {} : { output: outcome.output }),
      ...(outcome.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
            },
          }),
      ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
    };
  }

  /**
   * Continuation and stateless mode are mutually exclusive by construction:
   * either the backend has the history (session id, empty transcript) or we do
   * (no session id, the last N entries).
   */
  #request(
    instruction: string,
    prior: readonly BackendChatEntry[],
    signal: AbortSignal | undefined,
    taskId: string | undefined,
  ): BackendTurnRequest {
    const continuing =
      this.#options.supportsContinuation === true &&
      this.#sessionRef !== undefined;
    const limit = this.#options.transcriptTurns ?? DEFAULT_TRANSCRIPT_TURNS;
    const transcript = continuing
      ? []
      : limit <= 0
        ? []
        : prior.slice(Math.max(0, prior.length - limit));

    return {
      instruction,
      transcript,
      ...(continuing && this.#sessionRef !== undefined
        ? { sessionRef: this.#sessionRef }
        : {}),
      context: {
        runId: this.#options.runId,
        workspacePath: this.#options.workspacePath,
        ...(taskId === undefined ? {} : { taskId }),
        ...(signal === undefined ? {} : { signal }),
      },
    };
  }

  /**
   * Best-effort emission on the configured sink, building the same envelope
   * `AgentLoopEngine.emit` does so a renderer cannot tell the delegated path
   * from the native one.
   */
  async #emit(
    taskId: string | undefined,
    type: string,
    data: unknown,
  ): Promise<void> {
    const sink = this.#options.events;
    if (sink === undefined) return;

    const event: AgentEvent = {
      id: crypto.randomUUID(),
      runId: this.#options.runId,
      timestamp: Date.now(),
      type,
      ...(taskId === undefined ? {} : { taskId }),
      data,
    };

    try {
      await sink.emit(event);
    } catch {
      // Event emission is best-effort and must never fail a turn.
    }
  }
}

/**
 * The shape of a delegating backend, structurally — `ClaudeCodeBackend` and
 * `CodexBackend` both satisfy it. Declared rather than imported so this module
 * stays free of the process-spawning backends.
 */
export interface DelegatingBackendLike {
  run(
    input: { instruction: string; context?: readonly string[] },
    context: {
      runId: string;
      taskId?: string;
      workspacePath: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    status: "success" | "failed" | "partial";
    summary: string;
    output?: string;
    sessionId?: string;
    usage?: { inputTokens: number; outputTokens: number };
    costUsd?: number;
  }>;
}

export interface BackendTurnRunnerOptions {
  /**
   * Render the transcript into the prompt's context entries. Default true;
   * set false when the backend is resuming its own session and re-sending the
   * thread would only duplicate it.
   */
  readonly promptWithTranscript?: boolean;
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/** Renders prior turns as one prompt context block. */
export function renderTranscript(
  transcript: readonly BackendChatEntry[],
): string {
  const lines = transcript.map(
    (entry) => `${entry.role}: ${clamp(entry.content, TRANSCRIPT_ENTRY_CHARS)}`,
  );
  return `Earlier in this conversation:\n${lines.join("\n")}`;
}

/**
 * Adapts a delegating backend into a {@link BackendTurnRunner}.
 *
 * A stateless backend sees the thread because the transcript is rendered into
 * an `input.context` entry; `sessionId` from the run result becomes the
 * outcome's `sessionRef`.
 *
 * Note the asymmetry: this helper *reports* a session id but cannot *use* one,
 * because `run()` takes no continuation argument. To actually resume, build a
 * backend configured for it (Claude Code: `--resume <session_id>`; Codex:
 * `exec resume <SESSION_ID>`) and pass your own closure as the runner — that is
 * exactly why `BackendChatSession` takes a runner rather than a backend.
 */
export function backendTurnRunner(
  backend: DelegatingBackendLike,
  options?: BackendTurnRunnerOptions,
): BackendTurnRunner {
  const withTranscript = options?.promptWithTranscript ?? true;

  return async (request) => {
    const context =
      withTranscript && request.transcript.length > 0
        ? [renderTranscript(request.transcript)]
        : [];

    const result = await backend.run(
      {
        instruction: request.instruction,
        ...(context.length === 0 ? {} : { context }),
      },
      {
        runId: request.context.runId,
        workspacePath: request.context.workspacePath,
        ...(request.context.taskId === undefined
          ? {}
          : { taskId: request.context.taskId }),
        ...(request.context.signal === undefined
          ? {}
          : { signal: request.context.signal }),
      },
    );

    return {
      status: result.status,
      summary: result.summary,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.sessionId === undefined
        ? {}
        : { sessionRef: result.sessionId }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  };
}
