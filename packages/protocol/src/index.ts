import type { AgentEvent } from "./events.js";

export * from "./events.js";

export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

export interface EventBus extends EventSink {
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
}

export class InMemoryEventBus implements EventBus {
  readonly #listeners = new Set<(event: AgentEvent) => void | Promise<void>>();

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async emit(event: AgentEvent): Promise<void> {
    await Promise.all([...this.#listeners].map((listener) => listener(event)));
  }
}
