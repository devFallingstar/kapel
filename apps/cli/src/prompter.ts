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

  return {
    ask: async (request: PermissionRequest): Promise<boolean> => {
      state.active = true;
      try {
        return await askOnce(request, input, output);
      } finally {
        state.active = false;
      }
    },
  };
}

function askOnce(
  request: PermissionRequest,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<boolean> {
  const rl = readline.createInterface({ input, output, terminal: true });
  const preview = previewInput(request.input);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };

    rl.on("SIGINT", () => finish(false));
    rl.question(`allow ${request.tool}? ${preview} [y/N] `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      finish(normalized === "y" || normalized === "yes");
    });
  });
}
