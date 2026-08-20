import { execFile, spawn } from "node:child_process";
import type { AgentRunInput, AgentRunResult } from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import {
  detachedSpawnOptions,
  executableCandidates,
  killProcessTree,
} from "../platform/shell.js";

/**
 * Execution backend that delegates a coding objective to Anthropic's official
 * Claude Code CLI.
 *
 * We never implement Anthropic's OAuth flow and never read or write Claude
 * Code's credentials: the user authenticates once by running `claude` and
 * logging in with their existing subscription, and we only spawn the official
 * `claude` binary as a subprocess. Claude Code then runs its own agent loop
 * inside the workspace directory.
 *
 * The CLI is driven headlessly with `-p --output-format stream-json
 * --include-partial-messages`, which emits newline-delimited JSON. Those
 * lines are raw Claude API streaming events wrapped in a
 * `{"type":"stream_event","event":{...}}` envelope, interleaved with
 * whole-message `{"type":"assistant","message":{...}}` lines, with a final
 * result object as the last line. All of it is treated as untrusted and
 * drifting: unknown types, missing fields, bare (un-enveloped) events and
 * non-JSON lines are tolerated and never crash a run.
 *
 * Both shapes of assistant output are understood, because which ones arrive
 * depends on the installed CLI: without `--include-partial-messages` (or on a
 * build that does not know the flag) only the whole-message lines are
 * emitted, and a parser that only spoke deltas showed the user nothing at all.
 * When both arrive the whole message is deduplicated against the deltas that
 * already streamed for it, so nothing is printed twice.
 */

const DEFAULT_BINARY = "claude";
const DEFAULT_PERMISSION_MODE: ClaudeCodePermissionMode = "acceptEdits";
const KILL_GRACE_MS = 2000;
const MAX_STDERR_CHARS = 50_000;
const STDERR_TAIL_CHARS = 2000;
const MAX_RAW_LINES = 20;
const MAX_RAW_LINE_CHARS = 500;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 512 * 1024;

const INSTALL_HINT =
  "Install the Claude Code CLI with `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in with your Claude subscription (no API key required).";

const LOGIN_HINT =
  "Run `claude` and log in with your Claude subscription (no API key required).";

/**
 * Permission modes accepted by `--permission-mode`. Headless runs cannot
 * answer approval prompts, so anything that would prompt hangs the turn —
 * `acceptEdits` is the default here for that reason.
 *
 * Note: `--dangerously-skip-permissions` is deliberately never emitted.
 */
export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "plan"
  | "bypassPermissions";

export interface ClaudeCodeBackendOptions {
  /** Path to (or name of) the `claude` executable. Defaults to `"claude"`. */
  readonly binaryPath?: string;
  /** Optional model alias or full id passed through to `--model`. */
  readonly model?: string;
  /** Permission mode. Defaults to `"acceptEdits"`. */
  readonly permissionMode?: ClaudeCodePermissionMode;
  /** Tools auto-approved via `--allowedTools` (joined with commas). */
  readonly allowedTools?: readonly string[];
  /** Extra directories exposed to the run via repeated `--add-dir`. */
  readonly addDirs?: readonly string[];
  /** Optional sink for normalized `claude-code.*` events. */
  readonly events?: EventSink;
  /** Wall-clock budget for the whole subprocess, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Pass `--verbose` alongside `--output-format stream-json` (default true).
   * Some CLI builds require the pair in print mode; set false to omit it.
   */
  readonly verbose?: boolean;
  /**
   * Pass `--include-partial-messages` (default true), which is what makes the
   * CLI stream `content_block_delta` events instead of only whole-message
   * `assistant` lines. Set false for a CLI build that does not know the flag;
   * the whole-message path still renders, just without token-by-token output.
   */
  readonly includePartialMessages?: boolean;
  /** Escape hatch for flags this wrapper does not model yet. */
  readonly extraArgs?: readonly string[];
}

export interface ClaudeCodeRunContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface ClaudeCodeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ClaudeCodeRunResult extends AgentRunResult {
  /** Process exit code, or `null` when the process was killed by a signal. */
  readonly exitCode: number | null;
  /** Aggregated token usage, when Claude Code reported any. */
  readonly usage?: ClaudeCodeUsage;
  /** Total cost in USD, when the final result line reported one. */
  readonly costUsd?: number;
  /** Claude Code session id, when reported. */
  readonly sessionId?: string;
  /** Number of JSON lines successfully parsed from stdout. */
  readonly events: number;
}

export interface ClaudeCodeAvailability {
  readonly installed: boolean;
  readonly loggedIn: boolean;
  readonly detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The prompt section that attaches images to a `claude -p` turn.
 *
 * `-p` has no image flag — but the agent behind it has a Read tool that
 * renders an image file, which is the whole trick: kapel names the files and
 * asks for them to be opened, and Claude Code does the attaching itself. Pure
 * and exported so the wording is testable without spawning anything.
 */
export function imagePathsSection(paths: readonly string[]): string {
  const lines = paths.map((imagePath) => `- ${imagePath}`).join("\n");
  return `<attached-images>\nThe user attached ${paths.length === 1 ? "an image file" : "image files"} to this message. Open and view ${paths.length === 1 ? "it" : "each of them"} with your Read tool before answering:\n${lines}\n</attached-images>`;
}

/** Composes the single prompt argument handed to `claude -p`. */
function buildPrompt(input: AgentRunInput): string {
  const context = input.context ?? [];
  const imagePaths = input.imagePaths ?? [];

  const parts = [input.instruction];
  if (context.length > 0) {
    const blocks = context.map(
      (entry, index) => `<context index="${index + 1}">\n${entry}\n</context>`,
    );
    parts.push(
      `<additional-context>\n${blocks.join("\n")}\n</additional-context>`,
    );
  }
  // Last, so the instruction to go look at the images is the closest thing to
  // the turn's own question rather than something buried above the transcript.
  if (imagePaths.length > 0) parts.push(imagePathsSection(imagePaths));

  return parts.join("\n\n");
}

function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `...${trimmed.slice(trimmed.length - limit)}`;
}

interface ProbeResult {
  readonly ok: boolean;
  /** True when the binary could not be executed at all (e.g. ENOENT). */
  readonly spawnFailed: boolean;
  readonly detail: string;
}

function probeOnce(
  binaryPath: string,
  args: readonly string[],
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    execFile(
      binaryPath,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER },
      (error, stdout, stderr) => {
        const detail = `${String(stdout)}\n${String(stderr)}`.trim();
        if (error === null) {
          resolve({ ok: true, spawnFailed: false, detail });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          ok: false,
          spawnFailed: typeof code === "string",
          detail: detail === "" ? error.message : detail,
        });
      },
    );
  });
}

/** Probes the binary, retrying Windows `.cmd`/`.exe` shim names on ENOENT. */
async function probe(
  binaryPath: string,
  args: readonly string[],
): Promise<ProbeResult> {
  const candidates = executableCandidates(binaryPath);
  let result = await probeOnce(candidates[0] ?? binaryPath, args);
  for (const candidate of candidates.slice(1)) {
    if (!result.spawnFailed) break;
    result = await probeOnce(candidate, args);
  }
  return result;
}

/** Mutable bookkeeping for a single `claude -p` run. */
interface RunState {
  /** Text accumulated from `text_delta` chunks. */
  assistantText: string;
  /** Authoritative final answer from the trailing result line. */
  finalResult: string | undefined;
  sessionId: string | undefined;
  costUsd: number | undefined;
  stopReason: string | undefined;
  inputTokens: number;
  outputTokens: number;
  /** Output tokens already credited for the message currently streaming. */
  messageOutputTokens: number;
  /** `message.id` of the message currently streaming, when the CLI named one. */
  currentMessageId: string | undefined;
  /** Message ids whose content already arrived as partial stream events. */
  readonly streamedMessageIds: Set<string>;
  /** True once any partial content event was seen (id-less fallback). */
  sawPartialContent: boolean;
  sawUsage: boolean;
  parsedEvents: number;
  readonly errors: string[];
  readonly rawLines: string[];
  stderr: string;
  stderrTruncated: boolean;
}

export class ClaudeCodeBackend {
  readonly #options: ClaudeCodeBackendOptions;

  constructor(options: ClaudeCodeBackendOptions = {}) {
    this.#options = options;
  }

  async run(
    input: AgentRunInput,
    context: ClaudeCodeRunContext,
  ): Promise<ClaudeCodeRunResult> {
    const binary = this.#options.binaryPath ?? DEFAULT_BINARY;
    const timeoutMs = this.#options.timeoutMs;
    const args = this.#buildArgs(buildPrompt(input));

    const signals: AbortSignal[] = [];
    if (context.signal !== undefined) signals.push(context.signal);
    const timeoutSignal =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    if (timeoutSignal !== undefined) signals.push(timeoutSignal);
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);

    const state: RunState = {
      assistantText: "",
      finalResult: undefined,
      sessionId: undefined,
      costUsd: undefined,
      stopReason: undefined,
      inputTokens: 0,
      outputTokens: 0,
      messageOutputTokens: 0,
      currentMessageId: undefined,
      streamedMessageIds: new Set<string>(),
      sawPartialContent: false,
      sawUsage: false,
      parsedEvents: 0,
      errors: [],
      rawLines: [],
      stderr: "",
      stderrTruncated: false,
    };

    // Events are enqueued synchronously as lines arrive and drained in order,
    // so the sink observes the same ordering as the Claude Code stream.
    let queue: Promise<void> = Promise.resolve();
    const emit = (type: string, data: unknown): void => {
      const sink = this.#options.events;
      if (sink === undefined) return;
      const event: AgentEvent = {
        id: crypto.randomUUID(),
        runId: context.runId,
        timestamp: Date.now(),
        type,
        ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
        data,
      };
      queue = queue.then(async () => {
        try {
          await sink.emit(event);
        } catch {
          // Event emission is best-effort and must never fail a run.
        }
      });
    };

    const finish = async (
      result: ClaudeCodeRunResult,
    ): Promise<ClaudeCodeRunResult> => {
      emit("claude-code.completed", {
        status: result.status,
        exitCode: result.exitCode,
      });
      await queue;
      return result;
    };

    const settle = (
      status: AgentRunResult["status"],
      summary: string,
      exitCode: number | null,
    ): ClaudeCodeRunResult => {
      const output = finalText(state);
      return {
        status,
        summary,
        ...(output === undefined ? {} : { output }),
        exitCode,
        ...(state.sawUsage
          ? {
              usage: {
                inputTokens: state.inputTokens,
                outputTokens: state.outputTokens,
              },
            }
          : {}),
        ...(state.costUsd === undefined ? {} : { costUsd: state.costUsd }),
        ...(state.sessionId === undefined
          ? {}
          : { sessionId: state.sessionId }),
        events: state.parsedEvents,
      };
    };

    if (signal?.aborted === true) {
      return finish(
        settle("failed", "Claude Code run cancelled before it started.", null),
      );
    }

    // P1-9: `claude -p` (headless print mode) has no documented flag for
    // attaching image *bytes* — unlike Codex's `exec -i <path>`, there is
    // nothing to translate an inline attachment into. Rather than silently
    // dropping it or stuffing base64 into the text prompt as something the
    // model can't actually see, fail clearly before spawning anything.
    // Attaching by path is the supported route here (`input.imagePaths`, which
    // `buildPrompt` asks the agent to open with its Read tool).
    if ((input.images?.length ?? 0) > 0) {
      return finish(
        settle(
          "failed",
          "Claude Code's headless -p mode has no documented flag for attaching " +
            "image bytes, so kapel cannot send them inline through this " +
            "backend. Attach the images by path instead (kapel's `@shot.png` " +
            "mention does), or use `--backend codex` or the native backend.",
          null,
        ),
      );
    }

    // On Windows the npm-installed Claude Code CLI is a `claude.cmd` shim,
    // which a bare-name spawn cannot execute — retry the platform's candidate
    // names on ENOENT. A spawn error fires before any output is consumed, so
    // the retry never double-counts events.
    const candidates = executableCandidates(binary);
    let spawnOutcome = await this.#spawnClaude(
      candidates[0] ?? binary,
      args,
      context.workspacePath,
      signal,
      timeoutSignal,
      state,
      emit,
    );
    for (const candidate of candidates.slice(1)) {
      if (
        spawnOutcome.kind !== "spawn-error" ||
        (spawnOutcome.error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        break;
      }
      spawnOutcome = await this.#spawnClaude(
        candidate,
        args,
        context.workspacePath,
        signal,
        timeoutSignal,
        state,
        emit,
      );
    }

    if (spawnOutcome.kind === "spawn-error") {
      const error = spawnOutcome.error;
      const enoent = (error as NodeJS.ErrnoException).code === "ENOENT";
      const summary = enoent
        ? `Claude Code CLI not found (tried to run "${binary}"). ${INSTALL_HINT}`
        : `Failed to start the Claude Code CLI ("${binary}"): ${error.message}`;
      return finish(settle("failed", summary, null));
    }

    const { exitCode } = spawnOutcome;

    if (spawnOutcome.timedOut) {
      return finish(
        settle(
          "failed",
          `Claude Code run timed out after ${String(timeoutMs)}ms and the process was terminated.`,
          exitCode,
        ),
      );
    }

    if (spawnOutcome.aborted) {
      return finish(
        settle(
          "failed",
          "Claude Code run cancelled; the process was terminated.",
          exitCode,
        ),
      );
    }

    if (exitCode === 0) {
      return finish(
        settle(
          "success",
          finalText(state) ?? "Claude Code completed with no final message.",
          exitCode,
        ),
      );
    }

    const reason = failureReason(state);
    const hint = modelAccessHint(this.#options.model);
    return finish(
      settle(
        "failed",
        `Claude Code exited with code ${String(exitCode)}: ${reason}${hint}`,
        exitCode,
      ),
    );
  }

  #buildArgs(prompt: string): string[] {
    const permissionMode =
      this.#options.permissionMode ?? DEFAULT_PERMISSION_MODE;

    // There is no `--cwd` flag: the workspace is the child process's cwd.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      permissionMode,
    ];

    // Some CLI builds reject `--output-format stream-json` in print mode
    // unless `--verbose` accompanies it, and the docs' own stream-json
    // examples pass it. Emitting it costs nothing (extra lines are parsed
    // tolerantly) while omitting it can fail the whole run, so it is on by
    // default and `verbose: false` opts out.
    if (this.#options.verbose !== false) args.push("--verbose");

    // Without this, Claude Code 2.x reports a turn as a single whole-message
    // `assistant` line and never streams a `content_block_delta` — the answer
    // still arrives, but nothing can be shown while it is being written.
    if (this.#options.includePartialMessages !== false) {
      args.push("--include-partial-messages");
    }

    const model = this.#options.model;
    if (model !== undefined) args.push("--model", model);

    const allowedTools = this.#options.allowedTools;
    if (allowedTools !== undefined && allowedTools.length > 0) {
      args.push("--allowedTools", allowedTools.join(","));
    }

    for (const dir of this.#options.addDirs ?? []) {
      args.push("--add-dir", dir);
    }

    const extra = this.#options.extraArgs;
    if (extra !== undefined) args.push(...extra);

    // `--` before the prompt, always. Several of the flags above are variadic
    // in Claude Code's own parser (`--allowedTools <tools...>`, `--add-dir
    // <directories...>`), so a bare trailing positional is swallowed as one
    // more value for whichever variadic flag came last and the CLI exits 1
    // with "Input must be provided either through stdin or as a prompt
    // argument when using --print". The separator ends option parsing, and a
    // run with no variadic flag at all accepts it just the same, so it is
    // unconditional rather than something to reason about per flag set.
    args.push("--", prompt);
    return args;
  }

  #spawnClaude(
    binary: string,
    args: readonly string[],
    workspacePath: string,
    signal: AbortSignal | undefined,
    timeoutSignal: AbortSignal | undefined,
    state: RunState,
    emit: (type: string, data: unknown) => void,
  ): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      const child = spawn(binary, [...args], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOptions(),
      });

      let settled = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;

      const killGroup = (sig: NodeJS.Signals): void => {
        killProcessTree(child, sig);
      };

      const onAbort = (): void => {
        aborted = true;
        // SIGTERM aborts the turn and takes the child bash tree with it;
        // SIGKILL is the backstop if the CLI does not exit in time.
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
      };

      let pending = "";
      const consumeLine = (line: string): void => {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed.trim() === "") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Non-JSON output (banners, warnings, progress). Keep a short ring
          // buffer for diagnostics and move on.
          pushRawLine(state, trimmed);
          return;
        }
        if (!isRecord(parsed)) {
          pushRawLine(state, trimmed);
          return;
        }

        state.parsedEvents += 1;
        applyLine(parsed, state, emit);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let index = pending.indexOf("\n");
        while (index !== -1) {
          consumeLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.indexOf("\n");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (state.stderrTruncated) return;
        state.stderr += chunk.toString("utf8");
        if (state.stderr.length > MAX_STDERR_CHARS) {
          state.stderr = state.stderr.slice(0, MAX_STDERR_CHARS);
          state.stderrTruncated = true;
        }
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ kind: "spawn-error", error });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (pending !== "") consumeLine(pending);
        resolve({
          kind: "exit",
          exitCode: code,
          aborted,
          timedOut: aborted && timeoutSignal?.aborted === true,
        });
      });
    });
  }

  /**
   * Reports whether the Claude Code CLI is installed and whether the user is
   * logged in. Never throws: failures are encoded in `detail`.
   */
  static async checkAvailability(
    binaryPath?: string,
  ): Promise<ClaudeCodeAvailability> {
    const binary = binaryPath ?? DEFAULT_BINARY;

    const version = await probe(binary, ["--version"]);
    if (!version.ok) {
      const detail = version.spawnFailed
        ? `Could not run "${binary}". ${INSTALL_HINT}`
        : `\`${binary} --version\` failed: ${tail(version.detail, 500)}`;
      return { installed: false, loggedIn: false, detail };
    }

    // `claude auth status` exits 0 when a subscription login is present.
    const auth = await probe(binary, ["auth", "status"]);
    if (auth.ok) {
      const detail = tail(`${version.detail}\n${auth.detail}`, 500);
      return {
        installed: true,
        loggedIn: true,
        ...(detail === "" ? {} : { detail }),
      };
    }

    const reason = auth.detail === "" ? "" : ` (${tail(auth.detail, 500)})`;
    return {
      installed: true,
      loggedIn: false,
      detail: `Claude Code CLI is installed but not logged in${reason}. ${LOGIN_HINT}`,
    };
  }
}

type SpawnOutcome =
  | { readonly kind: "spawn-error"; readonly error: Error }
  | {
      readonly kind: "exit";
      readonly exitCode: number | null;
      readonly aborted: boolean;
      readonly timedOut: boolean;
    };

function pushRawLine(state: RunState, line: string): void {
  state.rawLines.push(line.slice(0, MAX_RAW_LINE_CHARS));
  if (state.rawLines.length > MAX_RAW_LINES) state.rawLines.shift();
}

/**
 * The authoritative final answer: the trailing result line when Claude Code
 * emitted one, otherwise the text accumulated from streamed deltas.
 */
function finalText(state: RunState): string | undefined {
  const result = state.finalResult;
  if (result !== undefined && result.trim() !== "") return result;
  const streamed = state.assistantText.trim();
  return streamed === "" ? undefined : streamed;
}

/** Picks the most informative diagnostic available for a failed run. */
function failureReason(state: RunState): string {
  const reported = state.errors.at(-1);
  if (reported !== undefined) return reported;
  if (state.stderr.trim() !== "") return tail(state.stderr, STDERR_TAIL_CHARS);
  const text = finalText(state);
  if (text !== undefined) return tail(text, STDERR_TAIL_CHARS);
  if (state.rawLines.length > 0) return state.rawLines.slice(-3).join("\n");
  if (state.stopReason !== undefined)
    return `stopped with reason "${state.stopReason}"`;
  return "no error details were reported";
}

/**
 * When a specific model alias or id was requested (as opposed to letting the
 * CLI pick its own default) and the run failed, appends a note that the
 * account or plan may simply not have that model — one of the most common
 * reasons a Claude Code run fails, and one the raw exit code and stderr tail
 * rarely say in so many words. This is offered as a possibility, not a
 * diagnosis: it is appended alongside the real failure reason, never in
 * place of it.
 */
function modelAccessHint(model: string | undefined): string {
  if (model === undefined) return "";
  return ` (model "${model}" was requested — your account or plan may not have access to it)`;
}

/** True for the trailing `--output-format json`-shaped result object. */
function isFinalResult(line: Record<string, unknown>): boolean {
  return typeof line.result === "string" && !isRecord(line.event);
}

/**
 * Folds one parsed stdout line into the run state and forwards a normalized
 * `claude-code.<type>` event to the sink.
 *
 * Lines are either an envelope (`{"type":"stream_event","event":{...}}`), a
 * bare streaming event, the trailing result object, or something we have never
 * seen — all four are tolerated.
 */
function applyLine(
  line: Record<string, unknown>,
  state: RunState,
  emit: (type: string, data: unknown) => void,
): void {
  if (isFinalResult(line)) {
    emit("claude-code.result", line);
    applyResult(line, state);
    return;
  }

  // Unwrap the stream envelope when present; a bare event is used as-is.
  const event = isRecord(line.event) ? line.event : line;
  const kind = firstString(event.type, line.type) ?? "unknown";

  emit(`claude-code.${kind}`, line);
  applyStreamEvent(kind, event, state, emit);
}

/** Folds the trailing result object into the run state. */
function applyResult(line: Record<string, unknown>, state: RunState): void {
  if (typeof line.result === "string") state.finalResult = line.result;

  const sessionId = firstString(line.session_id, line.sessionId);
  if (sessionId !== undefined) state.sessionId = sessionId;

  const cost = line.total_cost_usd ?? line.totalCostUsd;
  if (typeof cost === "number" && Number.isFinite(cost)) state.costUsd = cost;

  if (line.is_error === true) {
    state.errors.push(
      firstString(line.result, line.subtype) ??
        "Claude Code reported an error with no message",
    );
  }

  // Only used when the stream carried no usage of its own (e.g. a plain
  // `--output-format json` style line).
  const usage = isRecord(line.usage) ? line.usage : undefined;
  if (usage !== undefined && !state.sawUsage) {
    state.sawUsage = true;
    state.inputTokens +=
      toCount(usage.input_tokens) + toCount(usage.cache_read_input_tokens);
    state.outputTokens += toCount(usage.output_tokens);
  }
}

/**
 * Records that partial (delta-style) content arrived for the message being
 * streamed, so the whole-message `assistant` line that repeats it later is
 * recognized as a duplicate rather than re-emitted.
 *
 * The id is the reliable key; `sawPartialContent` is the fallback for a CLI
 * that streams deltas without ever naming a message id, where "we already
 * streamed something" is the best available answer.
 */
function markPartialContent(state: RunState): void {
  state.sawPartialContent = true;
  if (state.currentMessageId !== undefined) {
    state.streamedMessageIds.add(state.currentMessageId);
  }
}

/**
 * Normalizes a whole-message `{"type":"assistant","message":{content:[…]}}`
 * line into the same events the delta path produces, so a CLI that only
 * reports finished messages still renders text and tool calls.
 *
 * Skipped entirely when partial events already carried this message: with
 * `--include-partial-messages` the CLI emits both shapes for the same
 * `message.id`, and re-emitting would print the answer twice.
 */
function applyAssistantMessage(
  line: Record<string, unknown>,
  state: RunState,
  emit: (type: string, data: unknown) => void,
): void {
  const message = isRecord(line.message) ? line.message : undefined;
  if (message === undefined) return;

  const stopReason = firstString(message.stop_reason);
  if (stopReason !== undefined) state.stopReason = stopReason;

  const content = Array.isArray(message.content) ? message.content : undefined;
  if (content === undefined) return;

  const id = firstString(message.id);
  const duplicate =
    id === undefined
      ? state.sawPartialContent
      : state.streamedMessageIds.has(id);
  if (duplicate) return;
  // Also guards against the same whole message being repeated on the stream.
  if (id !== undefined) state.streamedMessageIds.add(id);

  let index = 0;
  let emittedText = false;
  for (const block of content) {
    if (isRecord(block)) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text !== "") {
          state.assistantText += block.text;
          emit("claude-code.content_block_delta", {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            },
          });
          emittedText = true;
        }
      } else if (block.type === "tool_use") {
        emit("claude-code.tool_use", {
          name: firstString(block.name) ?? "unknown",
          ...(typeof block.id === "string" ? { id: block.id } : {}),
          index,
        });
      }
    }
    index += 1;
  }

  // Closes the block the synthesized deltas opened, so a renderer that buffers
  // text until a stop event flushes it instead of holding it to the end of the
  // run. Only when there was text: a tool-only message has nothing to flush.
  if (emittedText) {
    emit("claude-code.message_stop", {
      type: "stream_event",
      event: { type: "message_stop" },
    });
  }
}

/** Folds one raw Claude API streaming event into the run state. */
function applyStreamEvent(
  kind: string,
  event: Record<string, unknown>,
  state: RunState,
  emit: (type: string, data: unknown) => void,
): void {
  switch (kind) {
    case "message_start": {
      const message = isRecord(event.message) ? event.message : undefined;
      state.currentMessageId =
        message === undefined ? undefined : firstString(message.id);
      const rawUsage = message === undefined ? undefined : message.usage;
      const usage = isRecord(rawUsage) ? rawUsage : undefined;
      if (usage !== undefined) {
        state.sawUsage = true;
        // Cache reads are still input the model saw, so they are folded in.
        state.inputTokens +=
          toCount(usage.input_tokens) + toCount(usage.cache_read_input_tokens);
        const output = toCount(usage.output_tokens);
        state.outputTokens += output;
        state.messageOutputTokens = output;
      } else {
        state.messageOutputTokens = 0;
      }
      return;
    }
    case "content_block_start": {
      markPartialContent(state);
      const block = isRecord(event.content_block)
        ? event.content_block
        : undefined;
      if (block?.type !== "tool_use") return;
      const name = firstString(block.name) ?? "unknown";
      // A dedicated event so consumers do not have to re-parse the envelope.
      emit("claude-code.tool_use", {
        name,
        ...(typeof block.id === "string" ? { id: block.id } : {}),
        ...(typeof event.index === "number" ? { index: event.index } : {}),
      });
      return;
    }
    case "content_block_delta": {
      markPartialContent(state);
      const delta = isRecord(event.delta) ? event.delta : undefined;
      if (delta?.type !== "text_delta") return;
      if (typeof delta.text === "string") state.assistantText += delta.text;
      return;
    }
    case "assistant": {
      applyAssistantMessage(event, state, emit);
      return;
    }
    case "message_delta": {
      const delta = isRecord(event.delta) ? event.delta : undefined;
      const stopReason = firstString(delta?.stop_reason);
      if (stopReason !== undefined) state.stopReason = stopReason;

      // `message_delta` carries the running output-token count for the message
      // currently streaming, which supersedes the placeholder reported by
      // `message_start`; credit only the difference.
      const usage = isRecord(event.usage) ? event.usage : undefined;
      if (usage !== undefined && typeof usage.output_tokens === "number") {
        const output = toCount(usage.output_tokens);
        if (output >= state.messageOutputTokens) {
          state.sawUsage = true;
          state.outputTokens += output - state.messageOutputTokens;
          state.messageOutputTokens = output;
        }
      }
      return;
    }
    case "error": {
      const error = isRecord(event.error) ? event.error : event;
      state.errors.push(
        firstString(error.message, error.type, event.message) ??
          "Claude Code reported an error with no message",
      );
      return;
    }
    default:
      return;
  }
}
