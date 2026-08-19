import * as readline from "node:readline";
import {
  describeSessionRule,
  type PermissionPrompter,
  type PermissionRequest,
  type SessionRule,
  sessionRuleFor,
} from "@agent/coding-agent";
import { formatToolPreview, previewInput } from "./preview.js";

export { previewInput } from "./preview.js";

/** Carriage return plus "erase the whole line" — the status line's own idiom. */
const ERASE_LINE = "\u001b[2K\r";

/** Shared flag so the process-level SIGINT handler can defer to an in-flight prompt. */
export interface PromptState {
  active: boolean;
}

export function createPromptState(): PromptState {
  return { active: false };
}

/** What one answer to a permission question means. */
export type PermissionAnswer = "once" | "always" | "deny";

/**
 * Parses an answer to the `[y/n/a]` question.
 *
 * `y`/`yes` allow this call, `a`/`always` allow it and remember the rule for
 * the session, and *everything else* denies: `n`, a typo, an empty line, a
 * closed stream (`undefined`) and a SIGINT symbol all mean no. Case and
 * surrounding whitespace are ignored.
 */
export function parsePermissionAnswer(
  answer: string | undefined | symbol,
): PermissionAnswer {
  if (typeof answer !== "string") return "deny";
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return "once";
  if (normalized === "a" || normalized === "always") return "always";
  return "deny";
}

/** The part of a session allowlist the prompter needs: somewhere to write to. */
export interface SessionMemory {
  remember(request: PermissionRequest): SessionRule | undefined;
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
   * Where an "always" answer is recorded. Without one, `a` still allows the
   * call but nothing is remembered — and the prompt does not offer it.
   */
  readonly allowlist?: SessionMemory;
  /** Overrides the TTY probe for ANSI colour. Only tests should pass this. */
  readonly color?: boolean;
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
  const allowlist = options.allowlist;
  // One probe answers two questions: a terminal is what can show colour, and
  // what may be holding a status line on the row the prompt is about to use.
  const color = options.color ?? (output as { isTTY?: boolean }).isTTY === true;

  return {
    ask: async (request: PermissionRequest): Promise<boolean> => {
      state.active = true;
      try {
        const prompt = formatPermissionPrompt(request, { color });
        // The preview goes to the screen ahead of the question: the question
        // itself stays one line, which is the only shape a readline prompt
        // can measure — and the only shape that redraws correctly.
        const lines = previewBlockLines(request, prompt, {
          color,
          offerAlways: allowlist !== undefined,
        });
        // Take the row back from the renderer's status line before writing on
        // it (`state.active` stops it repainting, but whatever it painted last
        // is still there), then write the whole block in one go so nothing can
        // interleave into it. Off a terminal neither applies.
        if (color) output.write(ERASE_LINE);
        if (lines.length > 0) output.write(`${lines.join("\n")}\n`);

        const raw =
          ask === undefined
            ? await askOnce(prompt.query, input, output)
            : await ask(prompt.query);
        const answer = parsePermissionAnswer(raw);
        if (answer === "deny") return false;
        if (answer === "always" && allowlist !== undefined) {
          const rule = allowlist.remember(request);
          output.write(
            `${dim(
              rule === undefined
                ? "  (allowed once — a compound command cannot be remembered)"
                : `  (remembered for this session: ${describeSessionRule(rule)})`,
              color,
            )}\n`,
          );
        }
        return true;
      } finally {
        state.active = false;
      }
    },
  };
}

function dim(text: string, enabled: boolean): string {
  return enabled ? `[2m${text}[0m` : text;
}

/** The preview block plus the "what `a` would remember" hint, as lines. */
function previewBlockLines(
  request: PermissionRequest,
  prompt: PermissionPromptText,
  options: { readonly color: boolean; readonly offerAlways: boolean },
): string[] {
  const lines = prompt.block === undefined ? [] : prompt.block.split("\n");
  if (!options.offerAlways) return lines;
  const rule = sessionRuleFor(request);
  if (rule === undefined) return lines;
  return [
    ...lines,
    dim(
      `  a = always allow ${describeSessionRule(rule)} this session`,
      options.color,
    ),
  ];
}

/** The text of one permission prompt: an optional preview block, and the question. */
export interface PermissionPromptText {
  /** Multi-line preview of what the tool will do, or `undefined` for none. */
  readonly block: string | undefined;
  /** The one-line question, always ending in `[y/n/a] `. */
  readonly query: string;
}

/**
 * Splits a permission request into what is *shown* and what is *asked*.
 *
 * Tools with a real preview (`bash`, `edit_file`, `write_file`) put it in the
 * block and keep the question bare; everything else keeps the compact JSON
 * one-liner inside the question, exactly as before.
 */
export function formatPermissionPrompt(
  request: PermissionRequest,
  options: { readonly color?: boolean } = {},
): PermissionPromptText {
  const block = formatToolPreview(request.tool, request.input, {
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const query =
    block === undefined
      ? `allow ${request.tool}? ${previewInput(request.input)} [y/n/a] `
      : `allow ${request.tool}? [y/n/a] `;
  return { block, query };
}

/**
 * The exact question text shown for a permission request, shared by both
 * `askOnce`'s private readline and the injected `ask` path so the two can
 * never drift apart.
 */
export function formatPermissionQuery(request: PermissionRequest): string {
  return formatPermissionPrompt(request).query;
}

/** Resolves the raw answer, or `undefined` for a SIGINT or a closed stream. */
function askOnce(
  query: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  const rl = readline.createInterface({ input, output, terminal: true });

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };

    rl.on("SIGINT", () => finish(undefined));
    rl.question(query, (answer) => finish(answer));
  });
}
