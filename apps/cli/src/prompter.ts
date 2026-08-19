import * as readline from "node:readline";
import type {
  PermissionPrompter,
  PermissionRequest,
} from "@agent/coding-agent";

const PREVIEW_MAX = 120;

/** Shared flag so the process-level SIGINT handler can defer to an in-flight prompt. */
export interface PromptState {
  active: boolean;
}

export function createPromptState(): PromptState {
  return { active: false };
}

/** Compact single-line JSON preview of a tool input, truncated to ~120 chars. */
export function previewInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    text = String(input);
  }
  if (text.length <= PREVIEW_MAX) return text;
  return `${text.slice(0, PREVIEW_MAX - 3)}...`;
}

interface CreatePrompterOptions {
  /** --yes: auto-approve every ask without prompting. */
  readonly yes: boolean;
  /** Whether stdin is a TTY we can interactively prompt on. */
  readonly interactive: boolean;
  /** Toggled around each prompt so a bare SIGINT can be treated as "no". */
  readonly state: PromptState;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /**
   * When provided, permission questions go through this instead of a
   * private readline — the interactive REPL passes its `InputManager`'s
   * `question`, so one interface keeps owning stdin instead of a second
   * readline opening on top of it.
   */
  readonly ask?: (query: string) => Promise<string | undefined | symbol>;
}

/**
 * Builds the permission prompter for a run:
 *  - `--yes` always approves.
 *  - an interactive TTY asks via readline, answering "no" on Ctrl-C.
 *  - otherwise `undefined` — the permission engine denies asks itself.
 */
export function createPrompter(
  options: CreatePrompterOptions,
): PermissionPrompter | undefined {
  if (options.yes) {
    return { ask: async () => true };
  }
  if (!options.interactive) {
    return undefined;
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const state = options.state;
  const ask = options.ask;

  return {
    ask: async (request: PermissionRequest): Promise<boolean> => {
      state.active = true;
      try {
        return ask === undefined
          ? await askOnce(request, input, output)
          : await askVia(request, ask);
      } finally {
        state.active = false;
      }
    },
  };
}

/**
 * The exact question text shown for a permission request, shared by both
 * `askOnce`'s private readline and the injected `ask` path so the two can
 * never drift apart.
 */
export function formatPermissionQuery(request: PermissionRequest): string {
  const preview = previewInput(request.input);
  return `allow ${request.tool}? ${preview} [y/N] `;
}

/** "y"/"yes" (case-insensitive, trimmed) is approval; everything else — including a closed stream or a SIGINT symbol — is "no". */
async function askVia(
  request: PermissionRequest,
  ask: (query: string) => Promise<string | undefined | symbol>,
): Promise<boolean> {
  const answer = await ask(formatPermissionQuery(request));
  if (typeof answer !== "string") return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function askOnce(
  request: PermissionRequest,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<boolean> {
  const rl = readline.createInterface({ input, output, terminal: true });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };

    rl.on("SIGINT", () => finish(false));
    rl.question(formatPermissionQuery(request), (answer) => {
      const normalized = answer.trim().toLowerCase();
      finish(normalized === "y" || normalized === "yes");
    });
  });
}
