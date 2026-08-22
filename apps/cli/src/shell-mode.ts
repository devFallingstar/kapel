import type { SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import {
  detachedSpawnOptions,
  killProcessTree,
  shellInvocationFor,
} from "@agent/coding-agent";

/**
 * `!`/`!!` shell mode — the classic REPL escape hatch, kept in its own file
 * because it is the one place `interactive.ts` reaches for a raw subprocess
 * rather than the agent loop.
 *
 * Two commands, one difference: who reads the output.
 *
 * - `!<command>` hands the whole terminal to the command, the same way
 *   `codex login`/`claude auth login` already do (see `backend.ts`'s
 *   `spawnCodexLogin`/`spawnClaudeCodeLogin`, and `withSuspendedFullScreen`
 *   in `interactive.ts`, which this mirrors exactly): stdio inherited, no
 *   capture, no timeout, Ctrl-C delivered to the child by the terminal
 *   itself rather than through an `AbortSignal`. Right for `!vim`, `!npm
 *   install`, anything that wants a real terminal.
 * - `!!<command>` never touches the terminal: it captures stdout+stderr the
 *   way `BashTool` (`packages/coding-agent/src/tools/bash.ts`) does for the
 *   agent, prints what it captured into the transcript, and — this is the
 *   part `BashTool` has no reason to do — queues it so the very next plain
 *   message carries it along as context. Typing `!!npm test` and then "fix
 *   this" is the whole feature; nobody should have to paste a failing test's
 *   output back in by hand.
 *
 * A session with no terminal to hand over (a pipe, `kapel < script.txt`)
 * cannot run `!` interactively either — there is nothing to inherit stdio
 * from — so it falls back to the `!!` capture path, silently as far as the
 * command is concerned: same spawn, same cap, the only difference is that a
 * bare `!` does not queue what it captured (see `interactive.ts`'s
 * `handleShell`, which is what decides that; everything in this file is
 * mechanism, not policy).
 */

// --- Parsing -----------------------------------------------------------------

export type BangKind = "!" | "!!";

export interface ParsedBangLine {
  readonly kind: BangKind;
  /** Trimmed. Empty for a bare `!`/`!!` typed with nothing after it. */
  readonly command: string;
}

/**
 * Recognizes a `!`/`!!` line. Pure — no spawning, no I/O, just "is this shell
 * syntax, and what comes after it" — so `interactive.ts`'s dispatch and
 * mid-turn routing can both ask it the same question without either one
 * owning the answer.
 *
 * `trimmedLine` is expected already trimmed (as every line reaching
 * `handleLine`/`routeMidTurnLine` already is); `undefined` for anything that
 * does not start with `!`, including the empty string.
 */
export function parseBangLine(trimmedLine: string): ParsedBangLine | undefined {
  if (!trimmedLine.startsWith("!")) return undefined;
  const kind: BangKind = trimmedLine.startsWith("!!") ? "!!" : "!";
  return { kind, command: trimmedLine.slice(kind.length).trim() };
}

/** The one-line notice a bare `!`/`!!` gets — not an error, just a reminder. */
export function shellUsageNotice(kind: BangKind): string {
  return kind === "!!"
    ? "usage: !!<command>  — runs a command and attaches its output to your next message"
    : "usage: !<command>  — runs a command in your shell";
}

/**
 * The dim line a shell run gets when it fails, printed for every flavour of
 * `!`/`!!` alike so a nonzero exit never reads as silent success — and
 * nothing at all when it succeeds, because a shell prompt does not announce
 * "exit 0" either. `undefined` rather than `""` so the caller's "is there
 * anything to print" check is a plain `!== undefined`, not a string compare.
 */
export function exitCodeNotice(code: number | null): string | undefined {
  if (code === 0) return undefined;
  return `exit ${code ?? -1}`;
}

/** Splits captured output into transcript lines, dropping one trailing blank. */
export function splitOutputLines(output: string): readonly string[] {
  if (output === "") return [];
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// --- Captured runs -------------------------------------------------------

/**
 * Mirrors `BashTool`'s `MAX_OUTPUT_CHARS` (100,000). Not imported — the tool
 * does not export it, and a shell-mode capture is not the tool's output
 * either (merged stdout+stderr, not two separate fields) — but the same
 * number, for the same reason: a runaway command's output should cost the
 * transcript a truncation notice, never the process's memory.
 */
export const MAX_CAPTURED_OUTPUT_CHARS = 100_000;

function capOutput(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const more = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated, ${more} more characters]`,
    truncated: true,
  };
}

export interface ShellCaptureResult {
  /** Stdout and stderr, merged in emission order (as close as two streams get). */
  readonly output: string;
  readonly code: number | null;
  readonly truncated: boolean;
}

export interface RunShellCapturedOptions {
  readonly cwd: string;
  /** Cancels the child — killed by process tree, not just by pid. */
  readonly signal?: AbortSignal;
  /** Injected for tests; defaults to `node:child_process`'s real `spawn`. */
  readonly spawn?: typeof spawn;
  readonly maxChars?: number;
}

const KILL_GRACE_MS = 2000;

/**
 * Runs `command` through the platform shell with no terminal at all —
 * `stdio: ["ignore", "pipe", "pipe"]` — merging stdout and stderr into one
 * capped string in the order the two streams actually produced it.
 *
 * "Order-preserving where feasible" rather than a guarantee: Node delivers
 * each stream's `data` events as its own pipe fills, so two lines written a
 * moment apart land in the order they were written, but a program that
 * interleaves stdout and stderr faster than the event loop turns can still
 * see them swapped here — the same limitation any merged capture has, and
 * not one worth a more elaborate scheme to fix for a REPL convenience.
 *
 * Backs `!!` always, and `!` wherever there is no terminal to hand over (see
 * the module comment). Cancellation goes through `killProcessTree` — the
 * same tree-aware kill `BashTool` uses — rather than `child.kill()`, because
 * `shellInvocationFor` runs the command through a shell process that may
 * itself have children.
 */
export function runShellCaptured(
  command: string,
  options: RunShellCapturedOptions,
): Promise<ShellCaptureResult> {
  const spawnFn = options.spawn ?? spawn;
  const maxChars = options.maxChars ?? MAX_CAPTURED_OUTPUT_CHARS;
  const invocation = shellInvocationFor(command);

  return new Promise<ShellCaptureResult>((resolve) => {
    const child = spawnFn(invocation.command, [...invocation.args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...detachedSpawnOptions(),
    } satisfies SpawnOptions);

    let output = "";
    let settled = false;

    const killGroup = (signal: NodeJS.Signals): void => {
      killProcessTree(child, signal);
    };

    const onAbort = (): void => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const capped = capOutput(
        `${output}${output === "" ? "" : "\n"}[error: ${error.message}]`,
        maxChars,
      );
      resolve({ output: capped.text, code: -1, truncated: capped.truncated });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const capped = capOutput(output, maxChars);
      resolve({ output: capped.text, code, truncated: capped.truncated });
    });
  });
}

// --- Interactive runs ------------------------------------------------------

export interface ShellInteractiveResult {
  readonly code: number | null;
}

export interface RunShellInteractiveOptions {
  readonly cwd: string;
  /** Injected for tests; defaults to `node:child_process`'s real `spawn`. */
  readonly spawn?: typeof spawn;
}

/**
 * Runs `command` with the terminal handed over — `stdio: "inherit"`, no
 * capture, no timeout — exactly the shape `spawnCodexLogin`/
 * `spawnClaudeCodeLogin` already use in `backend.ts`. The caller is
 * responsible for suspending whatever else owns the terminal first (the
 * REPL's `InputManager`, via `withSuspendedFullScreen` — see
 * `interactive.ts`), the same contract those two login spawns document; this
 * function only does the spawning.
 *
 * No `AbortSignal`: a Ctrl-C here is delivered by the terminal straight to
 * the child's own process group, the same as it would be for any other
 * interactive program run from a shell — there is nothing for this process
 * to forward.
 */
export function runShellInteractive(
  command: string,
  options: RunShellInteractiveOptions,
): Promise<ShellInteractiveResult> {
  const spawnFn = options.spawn ?? spawn;
  const invocation = shellInvocationFor(command);
  return new Promise<ShellInteractiveResult>((resolve) => {
    const child = spawnFn(invocation.command, [...invocation.args], {
      cwd: options.cwd,
      stdio: "inherit",
    } satisfies SpawnOptions);
    child.once("error", () => resolve({ code: -1 }));
    child.once("exit", (code) => resolve({ code }));
  });
}

// --- The pending `!!` attachment --------------------------------------------

export interface ShellCapture {
  /** What followed `!!`, verbatim — for the label on the attached block. */
  readonly command: string;
  readonly output: string;
}

/**
 * Mirrors {@link MAX_CAPTURED_OUTPUT_CHARS}: one capture is already capped at
 * that size, but nothing stopped a run of several `!!`s from piling up
 * several caps' worth before the next plain message finally consumes them.
 * The same number again, for the same reason — a request built from this
 * should cost a truncation, never an unbounded prompt.
 */
export const MAX_PENDING_SHELL_CHARS = MAX_CAPTURED_OUTPUT_CHARS;

/**
 * The `!!` outputs waiting to ride along with the next plain message.
 *
 * FIFO and capped by total characters rather than by count: a chatty `!!ls`
 * and a giant `!!npm test` should not count the same against the limit. When
 * a push would go over, the oldest captures are dropped first — mirroring
 * `history.ts`'s trim discipline — on the theory that a capture from three
 * `!!`s ago is the one least likely to still matter by the time a message
 * finally consumes the queue. The newest capture is never dropped for going
 * over alone; it is truncated instead (mirroring
 * {@link MAX_CAPTURED_OUTPUT_CHARS} at capture time already having capped
 * it), so `!!` never silently produces nothing.
 */
export interface PendingShellQueue {
  push(capture: ShellCapture): void;
  /** Takes everything queued, clearing it — what the next message consumes. */
  takeAll(): readonly ShellCapture[];
  /** Throws the queue away (`/new`), answering how many captures went with it. */
  clear(): number;
  count(): number;
}

export function createPendingShellQueue(
  maxChars = MAX_PENDING_SHELL_CHARS,
): PendingShellQueue {
  const captures: ShellCapture[] = [];
  let totalChars = 0;

  return {
    push(capture) {
      captures.push(capture);
      totalChars += capture.output.length;
      while (totalChars > maxChars && captures.length > 1) {
        const dropped = captures.shift();
        if (dropped !== undefined) totalChars -= dropped.output.length;
      }
    },
    takeAll() {
      const taken = captures.slice();
      captures.length = 0;
      totalChars = 0;
      return taken;
    },
    clear() {
      const dropped = captures.length;
      captures.length = 0;
      totalChars = 0;
      return dropped;
    },
    count: () => captures.length,
  };
}

/**
 * The notice printed right after a `!!` finishes, so the attachment never
 * feels like it vanished into the queue silently.
 */
export function pendingAttachedNotice(command: string): string {
  return `→ output of !!${command} will ride along with your next message`;
}

// --- Attaching onto the next message -----------------------------------------

/**
 * Folds queued `!!` captures into the instruction text of the next plain
 * message.
 *
 * Why the instruction string, and not a structured side-channel: `ChatLike`
 * (`interactive.ts`) sends one instruction string to whichever engine is
 * live, native or delegated, and neither has a second channel at this layer
 * — the native loop's own `AgentRunInput.context` (see `loop.ts`'s
 * `buildUserContent`) belongs to the one-shot orchestration path, not to
 * `AgentChatSession.send`, and a delegated backend (Codex, Claude Code) is
 * handed a single prompt string with no side-channel at all. Appending here
 * is therefore the one mechanism that reaches both uniformly, rather than
 * teaching the native path a trick the delegated one could never share — and
 * it borrows `buildUserContent`'s own `<context index="n">` shape (renamed
 * to `shell-output`, since this is shell output specifically and not
 * arbitrary context) so the format is already one the model has seen
 * elsewhere in this codebase's prompts.
 *
 * Returns `instruction` unchanged when there is nothing queued, so a caller
 * can call this unconditionally without a branch of its own.
 */
export function attachShellContext(
  instruction: string,
  captures: readonly ShellCapture[],
): string {
  if (captures.length === 0) return instruction;
  const blocks = captures.map(
    (capture, index) =>
      `<shell-output index="${index + 1}" command=${JSON.stringify(`!!${capture.command}`)}>\n${capture.output}\n</shell-output>`,
  );
  return `${instruction}\n\n<additional-context>\n${blocks.join("\n")}\n</additional-context>`;
}
