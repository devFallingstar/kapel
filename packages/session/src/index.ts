import type { OrchestrationPolicy } from "@agent/policy";
import type { AgentEvent } from "@agent/protocol";

export interface RunRecord {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: number;
  readonly policySnapshot: OrchestrationPolicy;
}

export interface SessionStore {
  createRun(run: RunRecord): Promise<void>;
  appendEvent(event: AgentEvent): Promise<void>;
  listEvents(runId: string): Promise<readonly AgentEvent[]>;
}

export {
  BOOTSTRAP_DDL,
  chatMessages,
  chatSessions,
  events,
  type RunStatus,
  runs,
  type TaskResultStatus,
  taskResults,
} from "./schema.js";
export {
  type ChatSessionRecord,
  type ChatSessionTranscript,
  chatTitleFrom,
  defaultSessionDbPath,
  type ListChatSessionsOptions,
  type ListRunsOptions,
  type NewChatSession,
  type PersistedChatMessage,
  type PersistedRun,
  type PersistedRunSummary,
  type PersistedTaskResult,
  type RunReconstruction,
  type RunTaskCounts,
  reconstructRun,
  SqliteSessionStore,
  type SqliteSessionStoreOptions,
} from "./sqlite.js";

export class InMemorySessionStore implements SessionStore {
  readonly #runs = new Map<string, RunRecord>();
  readonly #events = new Map<string, AgentEvent[]>();

  async createRun(run: RunRecord): Promise<void> {
    this.#runs.set(run.id, run);
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    const events = this.#events.get(event.runId) ?? [];
    events.push(event);
    this.#events.set(event.runId, events);
  }

  async listEvents(runId: string): Promise<readonly AgentEvent[]> {
    return this.#events.get(runId) ?? [];
  }
}
