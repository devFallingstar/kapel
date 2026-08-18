import { z } from "zod";

export const AgentEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  timestamp: z.number(),
  type: z.string(),
  taskId: z.string().optional(),
  workerId: z.string().optional(),
  data: z.unknown().optional(),
});

export type AgentEvent = z.infer<typeof AgentEventSchema>;

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
