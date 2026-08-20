// Re-exported here rather than only from `planning/index.js`: both worker
// executors' `usage` option is typed with this, so a caller wiring workers
// (`workspaceExecutorFactory`) can import it alongside them.
export type { DelegatedWorkerUsageSink } from "../planning/delegated-cli.js";
export { recordDelegatedWorkerUsage } from "../planning/delegated-cli.js";
export type {
  AgentLoopWorkerExecutorOptions,
  ResolvedWorkerModel,
  WorkerModelResolver,
} from "./agent-loop-executor.js";
export {
  AgentLoopWorkerExecutor,
  DEFAULT_WORKER_PERMISSIONS,
  selectToolsForAgent,
} from "./agent-loop-executor.js";
export type { ReviewContract, TaskBriefingOptions } from "./briefing.js";
export {
  buildTaskBriefing,
  buildWorkerSystemPrompt,
  DEFAULT_HANDOFF,
  DEFAULT_REVIEWER_GUIDANCE,
  DEFAULT_WORKER_GUIDANCE,
  WORKER_SYSTEM_POSTAMBLE,
} from "./briefing.js";
export type { ChildProcessWorkerExecutorOptions } from "./child-process-executor.js";
export { ChildProcessWorkerExecutor } from "./child-process-executor.js";
export type { ClaudeCodeWorkerExecutorOptions } from "./claude-code-executor.js";
export {
  ClaudeCodeWorkerExecutor,
  claudeCodeAllowedTools,
  createDelegatedToolsResolver,
} from "./claude-code-executor.js";
export type { CodexWorkerExecutorOptions } from "./codex-executor.js";
export { CodexWorkerExecutor } from "./codex-executor.js";
export { createDelegatedModelResolver } from "./delegated-model.js";
export type {
  NormalizableRun,
  NormalizeTaskResultInput,
  WorkspaceInspection,
} from "./normalize.js";
export {
  failedTaskResult,
  inspectWorkspaceChanges,
  normalizeTaskResult,
} from "./normalize.js";
export type {
  ServeWorkerRequestIo,
  ServeWorkerRequestOptions,
  WorkerEventLine,
  WorkerRequest,
  WorkerRequestHandler,
  WorkerResultLine,
  WorkerStdoutLine,
  WorkerStdoutLineInput,
} from "./protocol.js";
export {
  encodeWorkerLine,
  // Aliased: @agent/orchestration exports its own PlannedTaskSchema (the
  // planner's), and both are star re-exported from the package root.
  PlannedTaskSchema as WorkerPlannedTaskSchema,
  parseWorkerStdoutLine,
  serveWorkerRequest,
  TaskResultSchema,
  toPlannedTask,
  toTaskResult,
  toWorkerExecutionContext,
  WorkerEventLineSchema,
  WorkerRequestSchema,
  WorkerResultLineSchema,
  WorkerStdoutLineSchema,
} from "./protocol.js";
export type {
  ReviewIssue,
  ReviewVerdict,
  ReviewVerdictInput,
  ReviewVerdictOutput,
  ReviewVerdictParse,
} from "./review.js";
export {
  applyReviewVerdict,
  NO_VERDICT_SUMMARY,
  parseReviewVerdictReply,
  REVIEW_VERDICT_TOOL_NAME,
  ReviewVerdictTool,
  reviewVerdictFromRun,
} from "./review.js";
export type {
  WorkspaceExecutorFactory,
  WorktreeIsolatedExecutorOptions,
} from "./worktree-executor.js";
export { WorktreeIsolatedExecutor } from "./worktree-executor.js";
