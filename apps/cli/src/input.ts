import * as readline from "node:readline";

/**
 * The input-editor core: one long-lived `readline` interface owning stdin
 * for the whole life of the interactive REPL, instead of the previous
 * per-prompt throwaway interfaces in `interactive.ts`.
 *
 * A single interface is what makes ↑-history, multiline continuation, and
 * paste coalescing possible at all — each of those needs state (readline's
 * own history buffer, a partially-typed multiline block, a run of lines that
 * arrived together) to survive across individual `line` events, which a
 * fresh interface per prompt cannot offer.
 *
 * This module is split into a pure line-assembly reducer (fully
 * unit-testable, no I/O) and a thin `InputManager` shell that drives one
 * `readline.Interface` with that reducer. The wiring task (a separate step)
 * adapts `InputManager` to `interactive.ts`'s `LineSource` shape.
 */

// --- Pure line assembly ------------------------------------------------------

/** Continuation lines collected so far, for a multiline block in progress. */
export interface AssemblyState {
  readonly pending: readonly string[];
}

export type AssemblyAction =
  | { readonly type: "continue"; readonly state: AssemblyState }
  | { readonly type: "message"; readonly text: string };

export function initialAssembly(): AssemblyState {
  return { pending: [] };
}

/** Shown in place of the normal prompt while a multiline block is open. */
export const CONTINUATION_PROMPT = "... ";

/**
 * Feeds one raw line into the assembly state machine.
 *
 * - A line ending in exactly one `\` (not `\\`) means "more is coming":
 *   the trailing backslash is stripped and assembly continues.
 * - A line ending in `\\` is a literal backslash at end-of-line: one `\` is
 *   stripped, the line is otherwise complete.
 * - An empty line while a block is pending terminates the block (blank line
 *   ends a multiline paste/continuation) *without* contributing itself to
 *   the message.
 */
export function reduceAssemblyLine(
  state: AssemblyState,
  line: string,
): AssemblyAction {
  if (line === "" && state.pending.length > 0) {
    return { type: "message", text: state.pending.join("\n") };
  }

  const endsInBackslash = line.endsWith("\\");
  const endsInEscapedBackslash = line.endsWith("\\\\");

  if (endsInBackslash && !endsInEscapedBackslash) {
    const stripped = line.slice(0, -1);
    return {
      type: "continue",
      state: { pending: [...state.pending, stripped] },
    };
  }

  const finalLine = endsInEscapedBackslash ? line.slice(0, -1) : line;
  const lines = [...state.pending, finalLine];
  return { type: "message", text: lines.join("\n") };
}

/**
 * What to do with whatever was pending when input is abandoned (Ctrl-C or
 * close) mid-block: returns the joined text so the *caller* decides whether
 * to discard it or surface it, or `undefined` when nothing was pending.
 */
export function flushAssembly(state: AssemblyState): string | undefined {
  return state.pending.length === 0 ? undefined : state.pending.join("\n");
}

/** A recall-safe single-line form of a (possibly multiline) message. */
export function historyEntryFor(message: string): string {
  return message.replace(/\n/g, " ").trim();
}

// --- InputManager -------------------------------------------------------------

export const INPUT_SIGINT: unique symbol = Symbol("input-sigint");

export type InputReadResult = string | undefined | typeof INPUT_SIGINT;

export interface InputManagerOptions {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output: NodeJS.WritableStream;
  /** Newest-first, matching `readline`'s own history convention. */
  readonly history?: readonly string[];
  /** Called once per accepted top-level message, with its recall-safe form. */
  readonly onHistoryAppend?: (entry: string) => void;
  readonly completer?: (line: string) => [string[], string];
  /** Ctrl-C while no read is pending — e.g. a turn is running. */
  readonly onIdleSigint?: () => void;
  /** How long to wait for more lines before resolving a paste as one message. */
  readonly pasteWindowMs?: number;
}

export interface InputManager {
  /** The main REPL read: multiline continuation + paste coalescing. */
  readMessage(promptText: string): Promise<InputReadResult>;
  /** One-line sub-question (e.g. a permission y/N). Not coalesced or stored. */
  question(query: string): Promise<string | typeof INPUT_SIGINT | undefined>;
  /** Pause the interface and hand raw stdin to another consumer, then restore. */
  withSuspended<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

const DEFAULT_PASTE_WINDOW_MS = 15;

type RawModeCapable = {
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
};

/** Reaches into `readline`'s private-but-stable `.history` array, if present. */
function rlHistory(rl: readline.Interface): string[] | undefined {
  const history = (rl as unknown as { history?: unknown }).history;
  return Array.isArray(history) ? (history as string[]) : undefined;
}

export function createInputManager(options: InputManagerOptions): InputManager {
  const pasteWindowMs = options.pasteWindowMs ?? DEFAULT_PASTE_WINDOW_MS;

  const rl = readline.createInterface({
    input: options.input,
    output: options.output,
    terminal: true,
    history: options.history ? [...options.history] : [],
    historySize: 200,
    ...(options.completer ? { completer: options.completer } : {}),
  });

  let closed = false;

  // readMessage state
  let readPending:
    | {
        readonly resolve: (value: InputReadResult) => void;
        assembly: AssemblyState;
        promptText: string;
        coalesceTimer: ReturnType<typeof setTimeout> | undefined;
        coalesced: string | undefined;
      }
    | undefined;

  // question state
  let questionPending:
    | {
        readonly resolve: (
          value: string | typeof INPUT_SIGINT | undefined,
        ) => void;
      }
    | undefined;

  function clearCoalesceTimer(): void {
    if (readPending?.coalesceTimer !== undefined) {
      clearTimeout(readPending.coalesceTimer);
      readPending.coalesceTimer = undefined;
    }
  }

  /** Replace whatever partial lines readline auto-recorded with one entry. */
  function fixupHistoryFor(message: string): void {
    const entry = historyEntryFor(message);
    if (entry === "") return;
    options.onHistoryAppend?.(entry);

    const history = rlHistory(rl);
    if (history === undefined) return;

    // Drop the partial/continuation lines this block's `line` events pushed
    // onto readline's own history (one per line typed), then record the
    // single recall-safe form instead.
    const linesTyped = message.split("\n").length;
    history.splice(0, Math.min(linesTyped, history.length));
    if (history[0] !== entry) {
      history.unshift(entry);
    }
  }

  function resolveRead(value: InputReadResult): void {
    if (readPending === undefined) return;
    clearCoalesceTimer();
    const { resolve } = readPending;
    readPending = undefined;
    resolve(value);
  }

  function scheduleCoalesceFlush(): void {
    if (readPending === undefined) return;
    clearCoalesceTimer();
    readPending.coalesceTimer = setTimeout(() => {
      if (readPending === undefined) return;
      const message = readPending.coalesced ?? "";
      readPending.assembly = initialAssembly();
      fixupHistoryFor(message);
      resolveRead(message);
    }, pasteWindowMs);
  }

  rl.on("line", (line: string) => {
    if (questionPending !== undefined) {
      // readline routes lines to the question callback while a question is
      // pending, not to this listener — nothing to do here in that case.
      return;
    }
    if (readPending === undefined) return;

    const action = reduceAssemblyLine(readPending.assembly, line);
    if (action.type === "continue") {
      readPending.assembly = action.state;
      rl.setPrompt(CONTINUATION_PROMPT);
      rl.prompt();
      return;
    }

    // A complete message landed. Rather than resolve immediately, fold it
    // into whatever's already been coalesced this read and (re)start the
    // paste window: another `line` arriving before it fires means more of
    // the same pasted block, joined with "\n".
    readPending.assembly = initialAssembly();
    readPending.coalesced =
      readPending.coalesced === undefined
        ? action.text
        : `${readPending.coalesced}\n${action.text}`;
    scheduleCoalesceFlush();
  });

  rl.on("SIGINT", () => {
    if (questionPending !== undefined) {
      const { resolve } = questionPending;
      questionPending = undefined;
      resolve(INPUT_SIGINT);
      return;
    }
    if (readPending !== undefined) {
      readPending.assembly = initialAssembly();
      resolveRead(INPUT_SIGINT);
      return;
    }
    options.onIdleSigint?.();
  });

  rl.on("close", () => {
    closed = true;
    if (questionPending !== undefined) {
      const { resolve } = questionPending;
      questionPending = undefined;
      resolve(undefined);
    }
    resolveRead(undefined);
  });

  return {
    readMessage(promptText: string): Promise<InputReadResult> {
      if (closed) return Promise.resolve(undefined);
      if (readPending !== undefined || questionPending !== undefined) {
        throw new Error(
          "InputManager.readMessage: a read is already in progress",
        );
      }
      return new Promise<InputReadResult>((resolve) => {
        readPending = {
          resolve,
          assembly: initialAssembly(),
          promptText,
          coalesceTimer: undefined,
          coalesced: undefined,
        };
        rl.setPrompt(promptText);
        rl.prompt();
      });
    },

    question(query: string): Promise<string | typeof INPUT_SIGINT | undefined> {
      if (closed) return Promise.resolve(undefined);
      if (readPending !== undefined || questionPending !== undefined) {
        throw new Error("InputManager.question: a read is already in progress");
      }
      return new Promise<string | typeof INPUT_SIGINT | undefined>(
        (resolve) => {
          questionPending = { resolve };
          rl.question(query, (answer) => {
            if (questionPending === undefined) return;
            questionPending = undefined;

            // readline records question answers into its own history;
            // scrub the answer back out so it never pollutes ↑-recall.
            const history = rlHistory(rl);
            if (history !== undefined && history[0] === answer) {
              history.shift();
            }

            resolve(answer);
          });
        },
      );
    },

    async withSuspended<T>(fn: () => Promise<T>): Promise<T> {
      const input = options.input as unknown as RawModeCapable;
      const wasRaw = input.isRaw === true;
      rl.pause();
      input.setRawMode?.(false);
      try {
        return await fn();
      } finally {
        const isTty = (options.input as unknown as { isTTY?: boolean }).isTTY;
        input.setRawMode?.(wasRaw || isTty === true);
        rl.resume();
        if (readPending !== undefined) {
          rl.setPrompt(readPending.promptText);
          rl.prompt();
        }
      }
    },

    close(): void {
      if (closed) return;
      rl.close();
    },
  };
}
