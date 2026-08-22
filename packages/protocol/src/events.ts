import { z } from "zod";

/**
 * The event vocabulary the runtime speaks, as a discriminated union.
 *
 * ## Why this is a union and not `{type: string, data: unknown}`
 *
 * It used to be the latter, and every consumer paid for it. A renderer, the
 * TUI reducer, `kapel explain` and the SQLite store each re-derived the same
 * facts from the same payloads by hand — `isRecord(event.data)`, then
 * `typeof data.agent === "string" ? data.agent : "?"`, then a string compare
 * on `event.type` that the compiler could not check against anything. Four
 * copies of the same guesswork, none of which broke when an emitter renamed a
 * field: `task.started` grew a `routing` payload and a `model` field with no
 * consumer failing to compile, because there was nothing to fail against.
 *
 * So the tag is a literal and the payload travels with it. `switch
 * (event.type)` now narrows `event.data` to exactly the shape that event
 * carries, an unhandled variant is a compile error where a package means to
 * handle them all, and renaming a payload field breaks every reader of it.
 *
 * ## What is deliberately *not* enumerated
 *
 * Two namespaces are open by nature and are modelled as such rather than
 * pretended closed — see {@link PassthroughAgentEventSchema}.
 *
 * ## Compatibility
 *
 * This is a compile-time tightening, not a wire-format change: every field
 * name and payload shape here is the one the emitters already wrote, so rows
 * in an existing `sessions.db` keep parsing. {@link parseAgentEvent} is the
 * lenient door for anything that does not — a row written by a build that knew
 * a type this one does not.
 */

/* -------------------------------------------------------------------------- */
/* envelope                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The fields every event carries regardless of kind. Spread into each variant
 * rather than nested, because the wire format has always been flat and this
 * refactor does not get to change it.
 */
const envelope = {
  id: z.string(),
  runId: z.string(),
  timestamp: z.number(),
  /** The orchestration task an event belongs to; absent for run-level events. */
  taskId: z.string().optional(),
  /** The worker process that produced it, when a parent stamped one on. */
  workerId: z.string().optional(),
} as const;

/** Builds one variant: the shared envelope, a literal tag, and its payload. */
function variant<T extends string, D extends z.ZodTypeAny>(
  type: T,
  data: D,
): z.ZodObject<typeof envelope & { type: z.ZodLiteral<T>; data: D }> {
  return z.object({ ...envelope, type: z.literal(type), data });
}

/* -------------------------------------------------------------------------- */
/* shared payload pieces                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A task result as it travels inside `task.completed`.
 *
 * Structurally `@agent/orchestration`'s `TaskResult`, restated here because
 * that package depends on this one and not the other way round. The arrays are
 * `.readonly()` so an orchestration `TaskResult` — whose arrays are readonly —
 * is assignable to it without a copy.
 */
export const TaskResultPayloadSchema = z.object({
  taskId: z.string(),
  status: z.enum(["success", "failed", "partial"]),
  summary: z.string(),
  decisions: z.array(z.string()).readonly(),
  changedFiles: z.array(z.string()).readonly(),
  commit: z.string().optional(),
  tests: z.object({
    passed: z.number(),
    failed: z.number(),
    commands: z.array(z.string()).readonly(),
  }),
  unresolvedIssues: z.array(z.string()).readonly(),
  confidence: z.number(),
});

/** How an agent came to be the one running an attempt. */
export const TaskStartedRoutingSchema = z.object({
  /** The routing or escalation rule that decided it, when one applied. */
  rule: z.string().optional(),
  reason: z.enum(["rule", "suggestedAgent", "orchestrator", "escalation"]),
});

/** Statuses a loop or chat turn settles on. Mirrors `AgentRunResult["status"]`. */
const RunStatusSchema = z.enum(["success", "failed", "partial"]);

/* -------------------------------------------------------------------------- */
/* run lifecycle                                                               */
/* -------------------------------------------------------------------------- */

export const RunStartedEventSchema = variant(
  "run.started",
  z.object({ objective: z.string() }),
);

export const RunCompletedEventSchema = variant(
  "run.completed",
  z.object({
    /**
     * The scheduler's finished task table, so a run can be summarized from the
     * event log alone.
     *
     * The one payload left open on purpose. Its elements are
     * `@agent/orchestration`'s `RuntimeTask` — mutable, holding a `Set` that
     * `JSON.stringify` flattens to `{}`, and belonging to a package that sits
     * *above* this one. Restating it here would be a second, silently drifting
     * definition of a type nothing actually reads back: no consumer in the
     * repo switches on `run.completed`, it exists to be written to the events
     * table. `readonly unknown[]` says that honestly instead.
     */
    tasks: z.array(z.unknown()).readonly(),
  }),
);

/* -------------------------------------------------------------------------- */
/* scheduler task lifecycle                                                    */
/* -------------------------------------------------------------------------- */

export const TaskHeldEventSchema = variant(
  "task.held",
  z.object({ taskId: z.string(), conflictsWith: z.string() }),
);

export const TaskStartedEventSchema = variant(
  "task.started",
  z.object({
    agent: z.string(),
    attempt: z.number(),
    /** The agent's model, when the executor could say without running it. */
    model: z.string().optional(),
    /**
     * Optional because events recorded before this field existed have no
     * routing clause, and `kapel explain` still has to read those runs.
     */
    routing: TaskStartedRoutingSchema.optional(),
  }),
);

export const TaskCompletedEventSchema = variant(
  "task.completed",
  z.object({
    agent: z.string(),
    result: TaskResultPayloadSchema,
    attempt: z.number(),
    /** False when the scheduler is going to retry: not the task's verdict yet. */
    final: z.boolean(),
  }),
);

export const TaskEscalatedEventSchema = variant(
  "task.escalated",
  z.object({ from: z.string(), to: z.string(), rule: z.string() }),
);

export const TaskCancelledEventSchema = variant(
  "task.cancelled",
  z.object({
    reason: z.enum(["dependency-failed", "aborted"]),
    /** The dead task this one depended on, for `dependency-failed`. */
    dependency: z.string().optional(),
  }),
);

export const TaskLowConfidenceEventSchema = variant(
  "task.low_confidence",
  z.object({
    taskId: z.string(),
    agent: z.string(),
    confidence: z.number(),
    threshold: z.number(),
    rule: z.string(),
    /** Set when attempts were exhausted and the result was kept anyway. */
    accepted: z.boolean().optional(),
  }),
);

/* -------------------------------------------------------------------------- */
/* the native agent loop                                                       */
/* -------------------------------------------------------------------------- */

export const LoopStartedEventSchema = variant(
  "loop.started",
  z.object({
    agent: z.string(),
    model: z.string(),
    maxIterations: z.number(),
  }),
);

export const LoopCompletedEventSchema = variant(
  "loop.completed",
  z.object({
    status: RunStatusSchema,
    iterations: z.number(),
    toolCalls: z.number(),
  }),
);

export const ModelTurnCompletedEventSchema = variant(
  "model.turn.completed",
  z.object({
    /** Absent for a turn that produced only tool calls. */
    text: z.string().optional(),
    toolCallCount: z.number(),
    finishReason: z.string().optional(),
  }),
);

/**
 * The event type carrying one streamed chunk of assistant text, emitted as the
 * provider produces it.
 *
 * Named as a constant because it is also the one event type observers filter
 * on by name: it is emitted once per token-ish chunk, so anything that stores
 * or forwards events (the session database, the worker protocol channel) drops
 * it rather than keeping thousands of rows/lines per turn. The turn's full
 * text still arrives once, in `model.turn.completed`.
 */
export const MODEL_TEXT_DELTA_EVENT = "model.text.delta";

export const ModelTextDeltaEventSchema = variant(
  MODEL_TEXT_DELTA_EVENT,
  z.object({
    text: z.string(),
    /**
     * The 1-based model turn within the run — the same counter
     * `loop.completed`'s `iterations` reports — so a consumer can tell one
     * turn's stream from the next without waiting for the turn event.
     */
    iteration: z.number(),
  }),
);

export const ContextCompactedEventSchema = variant(
  "context.compacted",
  z.object({
    elided: z.number(),
    savedChars: z.number(),
    /** Conversation length after compaction. */
    messages: z.number(),
  }),
);

export const ToolExecutionStartedEventSchema = variant(
  "tool.execution.started",
  z.object({
    tool: z.string(),
    /**
     * The tool's arguments, whatever the model produced. Genuinely open: a
     * tool's input schema is the tool's business, not the event log's.
     */
    input: z.unknown(),
  }),
);

export const ToolExecutionCompletedEventSchema = variant(
  "tool.execution.completed",
  z.object({
    tool: z.string(),
    ok: z.boolean(),
    /** Set when the permission engine refused the call, rather than it failing. */
    denied: z.boolean().optional(),
  }),
);

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An MCP server finished its handshake and its tools joined the native loop.
 *
 * Two events cover the whole lifecycle on purpose. A started/failed pair is
 * what a user can act on — "did my server come up, and if not, why" — while
 * the calls themselves are already `tool.execution.*` like every other tool's,
 * and a `stopped` event would only ever say "the session ended", which the
 * session's own events already say.
 */
export const McpServerStartedEventSchema = variant(
  "mcp.server.started",
  z.object({
    /** The name the server is configured under, and the one in its tool names. */
    server: z.string(),
    /** How many of its tools were bridged into the loop. */
    tools: z.number(),
    /**
     * Tools the server offered that kapel could not expose — a descriptor that
     * did not validate, or a bridged name past the providers' 64-character
     * cap. Absent when none were dropped.
     */
    skippedTools: z.number().optional(),
    /** The `serverInfo.name` the server reported, when it reported one. */
    implementation: z.string().optional(),
  }),
);

export const McpServerFailedEventSchema = variant(
  "mcp.server.failed",
  z.object({ server: z.string(), reason: z.string() }),
);

/* -------------------------------------------------------------------------- */
/* chat sessions                                                               */
/* -------------------------------------------------------------------------- */

export const ChatTurnStartedEventSchema = variant(
  "chat.turn.started",
  z.object({
    /** 1-based turn number within the session. */
    turn: z.number(),
    /** `"delegated"` for a backend-served turn; absent on the native path. */
    backend: z.string().optional(),
  }),
);

export const ChatTurnCompletedEventSchema = variant(
  "chat.turn.completed",
  z.object({ turn: z.number(), status: RunStatusSchema }),
);

/* -------------------------------------------------------------------------- */
/* project validators                                                          */
/* -------------------------------------------------------------------------- */

export const ValidationStartedEventSchema = variant(
  "validation.started",
  z.object({ name: z.string(), command: z.string() }),
);

export const ValidationCompletedEventSchema = variant(
  "validation.completed",
  z.object({
    name: z.string(),
    passed: z.boolean(),
    /** `null` when the process was killed by a signal or never started. */
    exitCode: z.number().nullable(),
    durationMs: z.number(),
  }),
);

/* -------------------------------------------------------------------------- */
/* backend capability gaps                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A routed agent's `tools:` restriction could not be enforced by the backend
 * that ran it.
 *
 * Exists because a delegating backend can own a coarser permission model than
 * kapel's own (Codex's `--sandbox` gates the whole process, not a tool at a
 * time — see `codexToolScopingFor` in `@agent/coding-agent`), and silently
 * running such an agent unrestricted is the failure mode this event is for:
 * `docs/FUTURE_WORK.md` used to call that gap out only in prose, which is
 * exactly the kind of degradation nothing downstream could ever notice.
 * `backend` names which one hit the limit, so the same event type covers
 * whatever backend runs into it next rather than being named after Codex
 * specifically.
 */
export const ToolScopingUnsupportedEventSchema = variant(
  "backend.tool_scoping_unsupported",
  z.object({ backend: z.string(), agent: z.string() }),
);

/* -------------------------------------------------------------------------- */
/* worktree isolation                                                          */
/* -------------------------------------------------------------------------- */

export const WorktreeCreatedEventSchema = variant(
  "worktree.created",
  z.object({ taskId: z.string(), branch: z.string(), path: z.string() }),
);

export const WorktreeIntegratedEventSchema = variant(
  "worktree.integrated",
  z.object({
    taskId: z.string(),
    merged: z.boolean(),
    commit: z.string().optional(),
    conflictFiles: z.array(z.string()).readonly().optional(),
    reason: z.string().optional(),
    /**
     * What is actually in the way. Without it a `dirty-base` refusal reaches
     * the user as three words and no way to tell which file caused it.
     */
    detail: z.string().optional(),
  }),
);

export const WorktreeRemovedEventSchema = variant(
  "worktree.removed",
  z.object({
    taskId: z.string(),
    keptBranch: z.boolean(),
    branch: z.string(),
  }),
);

/* -------------------------------------------------------------------------- */
/* the closed set                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every event kind kapel itself defines, discriminated on `type`.
 *
 * Strict: a payload that does not match its tag is rejected rather than
 * shrugged at, which is the whole point of naming the payloads.
 */
export const KnownAgentEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunCompletedEventSchema,
  TaskHeldEventSchema,
  TaskStartedEventSchema,
  TaskCompletedEventSchema,
  TaskEscalatedEventSchema,
  TaskCancelledEventSchema,
  TaskLowConfidenceEventSchema,
  LoopStartedEventSchema,
  LoopCompletedEventSchema,
  ModelTurnCompletedEventSchema,
  ModelTextDeltaEventSchema,
  ContextCompactedEventSchema,
  ToolExecutionStartedEventSchema,
  ToolExecutionCompletedEventSchema,
  McpServerStartedEventSchema,
  McpServerFailedEventSchema,
  ChatTurnStartedEventSchema,
  ChatTurnCompletedEventSchema,
  ValidationStartedEventSchema,
  ValidationCompletedEventSchema,
  ToolScopingUnsupportedEventSchema,
  WorktreeCreatedEventSchema,
  WorktreeIntegratedEventSchema,
  WorktreeRemovedEventSchema,
]);

export type KnownAgentEvent = z.infer<typeof KnownAgentEventSchema>;

/**
 * Tags in the closed set, in schema order.
 *
 * Read off the schema rather than written out again beside it. A second list
 * would be a second thing to remember: `parseAgentEvent` uses this set to
 * decide what counts as "a type this build does not know", so a variant added
 * to the union but forgotten here would quietly start being treated as legacy.
 */
export const KNOWN_AGENT_EVENT_TYPES: readonly KnownAgentEvent["type"][] =
  KnownAgentEventSchema.options.map((option) => option.shape.type.value);

const KNOWN_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_AGENT_EVENT_TYPES);

/* -------------------------------------------------------------------------- */
/* the open namespaces                                                         */
/* -------------------------------------------------------------------------- */

export const CODEX_EVENT_PREFIX = "codex.";
export const CLAUDE_CODE_EVENT_PREFIX = "claude-code.";

/**
 * Tags of the two pass-through namespaces.
 *
 * Template literals rather than an enumeration because these names are not
 * kapel's to enumerate: a delegating backend forwards whatever its CLI printed
 * (`codex.${line.type}`, `claude-code.${line.type}`), so the set grows every
 * time the upstream tool ships a new stream event. TypeScript narrows a
 * template literal against a string literal correctly, so `case
 * "task.started"` still excludes these — which a `type: string` catch-all
 * would not, and that is exactly the looseness this union exists to remove.
 */
export type PassthroughEventType =
  | `${typeof CODEX_EVENT_PREFIX}${string}`
  | `${typeof CLAUDE_CODE_EVENT_PREFIX}${string}`;

const PassthroughEventTypeSchema = z.custom<PassthroughEventType>(
  (value) =>
    typeof value === "string" &&
    (value.startsWith(CODEX_EVENT_PREFIX) ||
      value.startsWith(CLAUDE_CODE_EVENT_PREFIX)),
  { message: "Expected a codex.* or claude-code.* event type" },
);

/**
 * One event forwarded verbatim from a delegating CLI backend.
 *
 * `data` is the upstream JSON line as it arrived, which is why it stays
 * `unknown`: it is the Codex/Claude Code wire format, versioned by someone
 * else, and a schema here would be a guess that breaks on their next release.
 * Consumers that render these (the CLI renderer, the TUI) already probe it
 * field by field, and now the compiler makes them.
 */
export const PassthroughAgentEventSchema = z.object({
  ...envelope,
  type: PassthroughEventTypeSchema,
  /** Optional because an upstream line can be a bare marker with no body. */
  data: z.unknown().optional(),
});

export type PassthroughAgentEvent = z.infer<typeof PassthroughAgentEventSchema>;

/* -------------------------------------------------------------------------- */
/* the union                                                                   */
/* -------------------------------------------------------------------------- */

export const AgentEventSchema = z.union([
  KnownAgentEventSchema,
  PassthroughAgentEventSchema,
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * The variant carrying tag `T`.
 *
 * Written as `T extends E["type"]` rather than `Extract<AgentEvent, {type: T}>`
 * because the pass-through variants are tagged with template literals: a
 * concrete `"codex.item.completed"` is *assignable to* `` `codex.${string}` ``
 * but the member is not assignable to it, so `Extract` would answer `never`
 * for every tag in an open namespace.
 */
export type AgentEventOf<T extends AgentEvent["type"]> =
  AgentEvent extends infer E
    ? E extends AgentEvent
      ? T extends E["type"]
        ? E
        : never
      : never
    : never;

/** The payload tag `T` carries. */
export type AgentEventData<T extends AgentEvent["type"]> =
  AgentEventOf<T>["data"];

/**
 * A tag and its payload without the envelope — what an emitter actually
 * decides, with the id/runId/timestamp bookkeeping left to {@link agentEvent}.
 *
 * Distributes over the union so the pairing stays checked: `{type:
 * "task.held", data: {...}}` is validated against `task.held`'s payload and
 * nothing else.
 */
export type AgentEventBody = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, keyof AgentEventEnvelope>
    : never
  : never;

/** The envelope every variant carries, independent of its tag. */
export type AgentEventEnvelope = Pick<
  AgentEvent,
  "id" | "runId" | "timestamp" | "taskId" | "workerId"
>;

/** Envelope fields an emitter supplies; `id` and `timestamp` are generated. */
export interface AgentEventContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly workerId?: string;
}

/**
 * Stamps an envelope onto a body. The single place a `crypto.randomUUID()` id
 * and a `Date.now()` timestamp are attached, so every emitter in the repo —
 * scheduler, agent loop, chat sessions, validators, worktree manager — writes
 * the same envelope and a renderer cannot tell which one produced an event.
 */
export function agentEvent(
  context: AgentEventContext,
  body: AgentEventBody,
): AgentEvent {
  return {
    id: crypto.randomUUID(),
    runId: context.runId,
    // Written conditionally rather than as `undefined`: the store distinguishes
    // "no task" from "task unknown", and `exactOptionalPropertyTypes` agrees.
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.workerId === undefined ? {} : { workerId: context.workerId }),
    timestamp: Date.now(),
    ...body,
  };
}

/* -------------------------------------------------------------------------- */
/* reading events back                                                         */
/* -------------------------------------------------------------------------- */

const LegacyEnvelopeSchema = z.object({
  ...envelope,
  type: z.string(),
  data: z.unknown().optional(),
});

/**
 * Parses one event off the wire or out of storage, leniently.
 *
 * Two callers need this rather than `AgentEventSchema.parse`: the SQLite store,
 * whose `events` table holds rows written by every kapel a user has ever run,
 * and the worker protocol, which reads a child process's stdout. Both must
 * survive a `type` this build has no schema for — an event kind that has since
 * been renamed, or one a newer kapel sharing the same `sessions.db` wrote —
 * because dropping those rows silently shortens `kapel explain`'s history of a
 * run rather than failing loudly.
 *
 * Such an event is surfaced as a pass-through event: `data` stays `unknown`,
 * which is exactly what a consumer's `default:` branch already assumes about a
 * tag it does not recognize. The alternative — a `{type: string}` member in
 * the union — is not available: TypeScript keeps a `string`-tagged member in
 * *every* `case`, so `event.data` would collapse back to `unknown` in all of
 * them and the union would buy nothing.
 *
 * Returns `undefined` in two cases, both of which mean "there is no event
 * here": an unusable envelope (no id, no runId, no numeric timestamp), and a
 * tag in the closed set whose payload does not match it. The second is the
 * deliberate limit on leniency — admitting a malformed `task.started` as a
 * pass-through event would hand consumers something typed as a `task.started`
 * that is missing the fields they are now allowed to trust.
 */
export function parseAgentEvent(value: unknown): AgentEvent | undefined {
  const parsed = AgentEventSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const legacy = LegacyEnvelopeSchema.safeParse(value);
  if (!legacy.success) return undefined;
  if (KNOWN_TYPE_SET.has(legacy.data.type)) return undefined;

  // The tag is outside both the closed set and the two pass-through prefixes,
  // so nothing about it is known beyond the envelope. Presenting it as a
  // pass-through event is the only representation the union has for "opaque
  // payload", and it is an accurate one — see this function's doc comment.
  return { ...legacy.data, type: legacy.data.type as PassthroughEventType };
}
