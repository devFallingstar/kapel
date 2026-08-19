import { execFile, spawn } from "node:child_process";
import type { AgentRunInput, AgentRunResult } from "@agent/core";
import type { AgentEvent, EventSink } from "@agent/protocol";
import {
  detachedSpawnOptions,
  executableCandidates,
  killProcessTree,
} from "../platform/shell.js";

/**
 * Execution backend that delegates a coding objective to OpenAI's official
 * Codex CLI.
 *
 * We never implement OpenAI's OAuth flow and never read or write Codex's
 * credentials: the user authenticates once with `codex login` and we only
 * spawn the official `codex` binary as a subprocess. Codex then runs its own
 * agent loop inside the workspace directory.
 *
 * The `--json` event stream is treated as untrusted and drifting: unknown
 * event types, missing fields and non-JSON lines are tolerated and never
 * crash a run.
 */

const DEFAULT_BINARY = "codex";
const DEFAULT_SANDBOX = "workspace-write";
const KILL_GRACE_MS = 2000;
const MAX_STDERR_CHARS = 50_000;
const MAX_RAW_LINES = 20;
const MAX_RAW_LINE_CHARS = 500;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 512 * 1024;

const INSTALL_HINT =
  "Install the Codex CLI with `npm install -g @openai/codex`, then authenticate with `codex login`.";

export type CodexSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface CodexBackendOptions {
  /** Path to (or name of) the `codex` executable. Defaults to `"codex"`. */
  readonly binaryPath?: string;
  /** Optional model id passed through to `-m`. */
  readonly model?: string;
  /** Sandbox mode. Defaults to `"workspace-write"`. */
  readonly sandbox?: CodexSandbox;
  /**
   * When true (the default) and the sandbox is `workspace-write`, pass
   * `--full-auto` instead of `--sandbox workspace-write` so Codex does not
   * stop for approval prompts on a non-interactive stdin.
   */
  readonly fullAuto?: boolean;
  /** Optional sink for normalized `codex.*` events. */
  readonly events?: EventSink;
  /** Wall-clock budget for the whole subprocess, in milliseconds. */
  readonly timeoutMs?: number;
  /** Escape hatch for flags this wrapper does not model yet. */
  readonly extraArgs?: readonly string[];
}

export interface CodexRunContext {
  readonly runId: string;
  readonly taskId?: string;
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface CodexUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CodexRunResult extends AgentRunResult {
  /** Process exit code, or `null` when the process was killed by a signal. */
  readonly exitCode: number | null;
  /** Aggregated token usage, when Codex reported any. */
  readonly usage?: CodexUsage;
  /** Number of JSONL events successfully parsed from stdout. */
  readonly events: number;
}

export interface CodexAvailability {
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
 * Best-effort extraction of the text of an `agent_message` item across the
 * shapes the Codex event stream has used over time.
 */
function extractMessageText(item: Record<string, unknown>): string | undefined {
  const direct = firstString(item.text, item.message, item.content);
  if (direct !== undefined) return direct;

  const content = item.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && typeof part.text === "string")
        parts.push(part.text);
    }
    const joined = parts.join("");
    if (joined !== "") return joined;
  }
  return undefined;
}

/** Composes the single prompt argument handed to `codex exec`. */
function buildPrompt(input: AgentRunInput): string {
  const context = input.context ?? [];
  if (context.length === 0) return input.instruction;

  const blocks = context.map(
    (entry, index) => `<context index="${index + 1}">\n${entry}\n</context>`,
  );
  return `${input.instruction}\n\n<additional-context>\n${blocks.join("\n")}\n</additional-context>`;
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

/**
 * Mutable bookkeeping for a single `codex exec` run.
 */
interface RunState {
  lastAgentMessage: string | undefined;
  inputTokens: number;
  outputTokens: number;
  sawUsage: boolean;
  parsedEvents: number;
  readonly errors: string[];
  readonly rawLines: string[];
  stderr: string;
  stderrTruncated: boolean;
}

export class CodexBackend {
  readonly #options: CodexBackendOptions;

  constructor(options: CodexBackendOptions = {}) {
    this.#options = options;
  }

  async run(
    input: AgentRunInput,
    context: CodexRunContext,
  ): Promise<CodexRunResult> {
    const binary = this.#options.binaryPath ?? DEFAULT_BINARY;
    const timeoutMs = this.#options.timeoutMs;
    const args = this.#buildArgs(buildPrompt(input), context.workspacePath);

    const signals: AbortSignal[] = [];
    if (context.signal !== undefined) signals.push(context.signal);
    const timeoutSignal =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    if (timeoutSignal !== undefined) signals.push(timeoutSignal);
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);

    const state: RunState = {
      lastAgentMessage: undefined,
      inputTokens: 0,
      outputTokens: 0,
      sawUsage: false,
      parsedEvents: 0,
      errors: [],
      rawLines: [],
      stderr: "",
      stderrTruncated: false,
    };

    // Events are enqueued synchronously as lines arrive and drained in order,
    // so the sink observes the same ordering as the Codex stream.
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

    const finish = async (result: CodexRunResult): Promise<CodexRunResult> => {
      emit("codex.completed", {
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
    ): CodexRunResult => ({
      status,
      summary,
      ...(state.lastAgentMessage === undefined
        ? {}
        : { output: state.lastAgentMessage }),
      exitCode,
      ...(state.sawUsage
        ? {
            usage: {
              inputTokens: state.inputTokens,
              outputTokens: state.outputTokens,
            },
          }
        : {}),
      events: state.parsedEvents,
    });

    if (signal?.aborted === true) {
      return finish(
        settle("failed", "Codex run cancelled before it started.", null),
      );
    }

    // On Windows the npm-installed codex CLI is a `codex.cmd` shim, which a
    // bare-name spawn cannot execute — retry the platform's candidate names
    // on ENOENT. A spawn error fires before any output is consumed, so the
    // retry never double-counts events.
    const candidates = executableCandidates(binary);
    let spawnOutcome = await this.#spawnCodex(
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
      spawnOutcome = await this.#spawnCodex(
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
        ? `Codex CLI not found (tried to run "${binary}"). ${INSTALL_HINT}`
        : `Failed to start the Codex CLI ("${binary}"): ${error.message}`;
      return finish(settle("failed", summary, null));
    }

    const { exitCode } = spawnOutcome;

    if (spawnOutcome.timedOut) {
      return finish(
        settle(
          "failed",
          `Codex run timed out after ${String(timeoutMs)}ms and the process was terminated.`,
          exitCode,
        ),
      );
    }

    if (spawnOutcome.aborted) {
      return finish(
        settle(
          "failed",
          "Codex run cancelled; the process was terminated.",
          exitCode,
        ),
      );
    }

    if (exitCode === 0) {
      const message = state.lastAgentMessage;
      return finish(
        settle(
          "success",
          message ?? "Codex completed with no final message.",
          exitCode,
        ),
      );
    }

    const reason = failureReason(state);
    return finish(
      settle(
        "failed",
        `Codex exited with code ${String(exitCode)}: ${reason}`,
        exitCode,
      ),
    );
  }

  #buildArgs(prompt: string, workspacePath: string): string[] {
    const sandbox = this.#options.sandbox ?? DEFAULT_SANDBOX;
    const fullAuto = this.#options.fullAuto ?? true;

    const args = ["exec", "--json", "--cd", workspacePath];
    if (sandbox === "workspace-write" && fullAuto) args.push("--full-auto");
    else args.push("--sandbox", sandbox);

    const model = this.#options.model;
    if (model !== undefined) args.push("-m", model);

    const extra = this.#options.extraArgs;
    if (extra !== undefined) args.push(...extra);

    // The prompt is always the trailing positional argument.
    args.push(prompt);
    return args;
  }

  #spawnCodex(
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
          state.rawLines.push(trimmed.slice(0, MAX_RAW_LINE_CHARS));
          if (state.rawLines.length > MAX_RAW_LINES) state.rawLines.shift();
          return;
        }
        if (!isRecord(parsed)) {
          state.rawLines.push(trimmed.slice(0, MAX_RAW_LINE_CHARS));
          if (state.rawLines.length > MAX_RAW_LINES) state.rawLines.shift();
          return;
        }

        state.parsedEvents += 1;
        applyEvent(parsed, state, emit);
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
   * Reports whether the Codex CLI is installed and whether the user has
   * completed `codex login`. Never throws: failures are encoded in `detail`.
   */
  static async checkAvailability(
    binaryPath?: string,
  ): Promise<CodexAvailability> {
    const binary = binaryPath ?? DEFAULT_BINARY;

    const version = await probe(binary, ["--version"]);
    if (!version.ok) {
      const detail = version.spawnFailed
        ? `Could not run "${binary}". ${INSTALL_HINT}`
        : `\`${binary} --version\` failed: ${tail(version.detail, 500)}`;
      return { installed: false, loggedIn: false, detail };
    }

    const login = await probe(binary, ["login", "status"]);
    if (login.ok) {
      const detail = tail(`${version.detail}\n${login.detail}`, 500);
      return {
        installed: true,
        loggedIn: true,
        ...(detail === "" ? {} : { detail }),
      };
    }

    const reason = login.detail === "" ? "" : ` (${tail(login.detail, 500)})`;
    return {
      installed: true,
      loggedIn: false,
      detail: `Codex CLI is installed but not logged in${reason}. Run \`codex login\` to authenticate with your ChatGPT account.`,
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

/** Picks the most informative diagnostic available for a failed run. */
function failureReason(state: RunState): string {
  const reported = state.errors.at(-1);
  if (reported !== undefined) return reported;
  if (state.stderr.trim() !== "") return tail(state.stderr, 1000);
  if (state.rawLines.length > 0) return state.rawLines.slice(-3).join("\n");
  return "no error details were reported";
}

/**
 * Folds one parsed Codex event into the run state and forwards a normalized
 * `codex.<type>` event to the sink.
 */
function applyEvent(
  event: Record<string, unknown>,
  state: RunState,
  emit: (type: string, data: unknown) => void,
): void {
  // Some Codex versions wrap the payload in `msg`; unwrap it for inspection
  // but always forward the original object as event data.
  const source =
    isRecord(event.msg) && typeof event.msg.type === "string"
      ? event.msg
      : event;
  const kind = typeof source.type === "string" ? source.type : "unknown";

  emit(`codex.${kind}`, event);

  const item = isRecord(source.item) ? source.item : undefined;
  if (item !== undefined && item.type === "agent_message") {
    const text = extractMessageText(item);
    if (text !== undefined) state.lastAgentMessage = text;
  } else if (kind === "agent_message") {
    const text = extractMessageText(source);
    if (text !== undefined) state.lastAgentMessage = text;
  }

  if (kind === "error") {
    state.errors.push(
      firstString(source.message, source.error, source.detail) ??
        "Codex reported an error with no message",
    );
  }

  const usage = isRecord(source.usage) ? source.usage : undefined;
  if (usage !== undefined) {
    const inputTokens = toCount(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = toCount(usage.output_tokens ?? usage.outputTokens);
    if (inputTokens !== 0 || outputTokens !== 0 || kind.startsWith("turn.")) {
      state.sawUsage = true;
      state.inputTokens += inputTokens;
      state.outputTokens += outputTokens;
    }
  }
}
