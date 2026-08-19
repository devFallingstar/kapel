import type { ModelMessage } from "@agent/ai";
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
 */
export class AgentChatSession {
  readonly #engine: AgentLoopEngine;
  readonly #messages: ModelMessage[] = [];
  #turn = 0;
  #sending = false;

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
   * @throws if another send on this session is still in flight.
   */
  async send(
    instruction: string,
    context: AgentLoopRunContext,
  ): Promise<ChatTurnResult> {
    if (this.#sending) {
      throw new Error(
        "AgentChatSession.send: a send is already in flight; turns must be serialized.",
      );
    }
    this.#sending = true;

    try {
      if (this.#messages.length === 0) {
        this.#messages.push(...this.#engine.seed({ instruction }));
      } else {
        this.#messages.push({ role: "user", content: instruction });
      }

      this.#turn += 1;
      const turn = this.#turn;

      await this.#engine.emit(context, "chat.turn.started", { turn });
      const result = await this.#engine.drive(this.#messages, context);
      await this.#engine.emit(context, "chat.turn.completed", {
        turn,
        status: result.status,
      });

      return result;
    } finally {
      this.#sending = false;
    }
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
