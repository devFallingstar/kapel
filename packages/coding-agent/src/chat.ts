import type { ModelMessage } from "@agent/ai";
import type { AgentImageAttachment } from "@agent/core";
import {
  AgentLoopEngine,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopRunContext,
} from "./loop.js";

/**
 * The outcome of one user turn. Identical in shape to a one-shot loop result;
 * `iterations` and `toolCalls` are counted per send, not per session.
 */
export interface ChatTurnResult extends AgentLoopResult {}

/** Defensive copy: callers must not be able to reach into retained history. */
function copyMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls === undefined
      ? {}
      : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }),
    // Copied for the same reason as the tool calls; the base64 payloads are
    // strings, so this only duplicates references.
    ...(message.images === undefined
      ? {}
      : { images: message.images.map((image) => ({ ...image })) }),
  };
}

/**
 * A stateful, multi-turn conversation over the agent loop.
 *
 * Each {@link send} appends a user turn to the retained history and drives the
 * same engine {@link AgentLoop} uses until the model stops calling tools; the
 * resulting assistant turns and tool results stay in history, so the next send
 * continues the same conversation. Sessions are snapshotable via
 * {@link messages} and rebuildable via {@link restore}, which is what lets a
 * CLI persist a conversation across process restarts.
 *
 * Sends are single-flight: overlapping sends would interleave writes into one
 * message array and produce a history no provider would accept.
 *
 * ## Steering
 *
 * {@link injectUserMessage} is the one deliberate exception to that rule, and
 * the reason the exception is safe is worth stating: it is an *append*, not a
 * second send. The engine re-snapshots the message array at the top of every
 * iteration, so a user message pushed onto it while a turn is in flight is
 * simply part of the next request that turn makes — which is what lets someone
 * type a correction into a run that is three tool calls deep and have it
 * answered without waiting for the run to finish. It writes one message and
 * drives nothing, so there is no interleaving for the single-flight guard to
 * protect against.
 */
export class AgentChatSession {
  readonly #engine: AgentLoopEngine;
  readonly #messages: ModelMessage[] = [];
  #turn = 0;
  #sending = false;
  /**
   * The index of the most recent {@link injectUserMessage} that no model
   * request is known to have carried yet, or `undefined` when nothing is
   * outstanding.
   *
   * The newest index is enough for all of them: injections only ever append,
   * so a request that reached the last one reached every earlier one too.
   */
  #unanswered: number | undefined;

  constructor(options: AgentLoopOptions) {
    this.#engine = new AgentLoopEngine(options);
  }

  /**
   * Rebuilds a session from a {@link messages} snapshot. The history is used
   * as-is — no system prompt is re-seeded on top of it — and the next send
   * simply appends a user turn. An empty snapshot yields a session that seeds
   * itself on its first send, exactly like a fresh one.
   */
  static restore(
    options: AgentLoopOptions,
    messages: readonly ModelMessage[],
  ): AgentChatSession {
    const session = new AgentChatSession(options);
    for (const message of messages)
      session.#messages.push(copyMessage(message));
    return session;
  }

  /**
   * Runs one user turn to completion: the instruction is appended (seeding the
   * system prompt first if the history is empty) and the loop runs until the
   * model stops requesting tools or the per-send iteration budget is spent.
   *
   * On failure or cancellation the messages produced so far are retained so the
   * user can follow up; any tool call the loop abandoned mid-batch is answered
   * with an error result first, keeping the history replayable.
   *
   * `images` attaches vision content to *this* user turn, already validated and
   * read by the caller (`AgentImageAttachment` is `ImagePart` plus the source
   * path, so it rides straight onto the wire message — see
   * `AgentLoopEngine.seed`). They stay in the retained history like any other
   * part of the turn: the loop replays the whole conversation on every
   * iteration, so an image the user attached three turns ago is still there
   * when the model needs to look at it again.
   *
   * @throws if another send on this session is still in flight.
   */
  async send(
    instruction: string,
    context: AgentLoopRunContext,
    images?: readonly AgentImageAttachment[],
  ): Promise<ChatTurnResult> {
    if (this.#sending) {
      throw new Error(
        "AgentChatSession.send: a send is already in flight; turns must be serialized.",
      );
    }
    this.#sending = true;

    const attached = images ?? [];
    const withImages = attached.length === 0 ? {} : { images: attached };

    try {
      if (this.#messages.length === 0) {
        this.#messages.push(
          ...this.#engine.seed({ instruction, ...withImages }),
        );
      } else {
        this.#messages.push({
          role: "user",
          content: instruction,
          ...withImages,
        });
      }

      return await this.#driveTurn(context);
    } finally {
      this.#sending = false;
    }
  }

  /**
   * Appends a user message to the history of the turn already running, so the
   * model reads it on that turn's next request.
   *
   * This is steering: the user typed something while the agent was working and
   * meant it for the work in progress, not for a turn afterwards. Deliberately
   * *not* guarded by the single-flight check — see the class comment — because
   * an append is not a send: nothing here drives the engine, emits an event or
   * races another writer. The whole mechanism is that
   * {@link AgentLoopEngine.drive} copies the array afresh every iteration.
   *
   * Refused when no send is in flight, and that is the honest answer rather
   * than a convenience: with nothing running there is no turn to steer, the
   * caller's line belongs in an ordinary {@link send}, and appending it here
   * would leave a user message in history that nobody ever answers.
   *
   * @returns whether the message was appended.
   */
  injectUserMessage(text: string): boolean {
    if (!this.#sending) return false;
    if (text === "") return false;
    this.#messages.push({ role: "user", content: text });
    this.#unanswered = this.#messages.length - 1;
    return true;
  }

  /**
   * Whether an injected message is still waiting for its first model request.
   *
   * True only in the narrow case the caller has to handle: the turn ended
   * before it built another request — the model answered in one shot — so the
   * words are sitting in history unread. Everything else (the turn ran another
   * iteration, or the injection arrived before the first request) reads as
   * answered, because the model did in fact see them.
   */
  hasUnansweredInjection(): boolean {
    return this.#unanswered !== undefined;
  }

  /**
   * Runs another turn over the retained history *without* appending anything.
   *
   * The counterpart to {@link hasUnansweredInjection}: the user's steering
   * message is already in the history, so the way to get it answered is to ask
   * the model again — and appending it a second time would show the user their
   * own words twice in every request from here on. A turn in its own right
   * otherwise: same events, same numbering, same single-flight guard.
   *
   * @throws if a send is in flight, or if there is no history to continue.
   */
  async continueTurn(context: AgentLoopRunContext): Promise<ChatTurnResult> {
    if (this.#sending) {
      throw new Error(
        "AgentChatSession.continueTurn: a send is already in flight; turns must be serialized.",
      );
    }
    if (this.#messages.length === 0) {
      throw new Error(
        "AgentChatSession.continueTurn: there is no conversation to continue.",
      );
    }
    this.#sending = true;
    try {
      return await this.#driveTurn(context);
    } finally {
      this.#sending = false;
    }
  }

  /** One turn over the retained history: the shared half of send/continue. */
  async #driveTurn(context: AgentLoopRunContext): Promise<ChatTurnResult> {
    this.#turn += 1;
    const turn = this.#turn;

    await this.#engine.emit(context, "chat.turn.started", { turn });
    const result = await this.#engine.drive(this.#messages, context);
    await this.#engine.emit(context, "chat.turn.completed", {
      turn,
      status: result.status,
    });

    // Every iteration snapshots the array, so the last request's length is
    // exactly how far into the history the model read — see
    // `AgentLoopResult.requestedMessages`.
    const unanswered = this.#unanswered;
    if (
      unanswered !== undefined &&
      (result.requestedMessages ?? 0) > unanswered
    )
      this.#unanswered = undefined;

    return result;
  }

  /** A snapshot of the full history, system message included. */
  messages(): readonly ModelMessage[] {
    return this.#messages.map(copyMessage);
  }

  /**
   * Forces an immediate compaction pass over the retained history, ignoring
   * the `maxMessages` threshold a send's automatic pass respects. Backs the
   * `/compact` slash command.
   *
   * Safe to call between sends (nothing is in flight) and on a session with
   * no history yet — there is simply nothing to elide, and it reports zero.
   *
   * @returns how many tool results were elided and how many characters were
   * saved, for the caller to render a one-line summary.
   */
  async compactNow(
    context: AgentLoopRunContext,
  ): Promise<{ elided: number; savedChars: number }> {
    return await this.#engine.compactNow(this.#messages, context);
  }
}
