import * as readline from "node:readline";
import {
  type AskOutcome,
  describeSessionRule,
  type PermissionPrompter,
  type PermissionRequest,
  type SessionRule,
  sessionRuleFor,
} from "@agent/coding-agent";
import { formatToolPreview, previewInput } from "./preview.js";
import { createStyles } from "./styles.js";

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
export type PermissionAnswer = "once" | "always" | "deny" | "feedback";

/**
 * Parses an answer to the permission question.
 *
 * Four answers, not three:
 *
 * - `y`/`yes` allow this call once;
 * - `a`/`always` allow it and remember the rule for the session;
 * - `n`/`no`, an empty line, a closed stream (`undefined`) and a SIGINT symbol
 *   deny it, saying nothing;
 * - **anything else** — a sentence, a question, an instruction — denies it
 *   *and speaks*: the call does not run and the typed text goes to the model
 *   as the user's own words (see {@link permissionFeedback}). This is the
 *   whole point of being able to answer a prompt in prose: "왜 이 파일을
 *   지우려는 거야?" is a better answer than `n`, and the agent can act on it.
 *
 * Case and surrounding whitespace are ignored for the four letters.
 */
export function parsePermissionAnswer(
  answer: string | undefined | symbol,
): PermissionAnswer {
  if (typeof answer !== "string") return "deny";
  const normalized = answer.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return "once";
  if (normalized === "a" || normalized === "always") return "always";
  if (normalized === "" || normalized === "n" || normalized === "no") {
    return "deny";
  }
  return "feedback";
}

/**
 * The user's own words from an answer that was none of `y`, `n` or `a` —
 * trimmed, and `undefined` for every answer that was one of them (or was no
 * answer at all).
 */
export function permissionFeedback(
  answer: string | undefined | symbol,
): string | undefined {
  if (parsePermissionAnswer(answer) !== "feedback") return undefined;
  // Only a string can parse as "feedback"; the guard is for the type checker.
  return typeof answer === "string" ? answer.trim() : undefined;
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
 *
 * The interactive prompter answers with a bare `true`/`false` for `y`, `a`,
 * `n` and every silent no (empty line, closed stream, Ctrl-C). It returns an
 * `AskOutcome` only for the fourth answer — a refusal the user typed words
 * into — so nothing downstream of `y/n/a` sees a shape it did not see before.
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
    ask: async (request: PermissionRequest): Promise<boolean | AskOutcome> => {
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

        // The question is the one line here that has to be *acted* on, so it
        // is the one line that is bold — never coloured, because a permission
        // ask is not an error and must not read as one.
        const query = createStyles(color).heading(prompt.query);
        const raw =
          ask === undefined
            ? await askOnce(query, input, output)
            : await ask(query);
        const answer = parsePermissionAnswer(raw);
        // A refusal in prose is still a refusal — nothing is remembered and
        // nothing runs — but it carries the words back to the model, which is
        // what lets the turn go on as a conversation. `y`/`n`/`a` keep
        // answering with the bare boolean they always did.
        if (answer === "feedback") {
          const feedback = permissionFeedback(raw);
          return feedback === undefined
            ? false
            : { allowed: false as const, feedback };
        }
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

/** The prompt's asides — what `a` would remember, what it just remembered. */
function dim(text: string, enabled: boolean): string {
  return createStyles(enabled).tool(text);
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

/**
 * The answers the question advertises.
 *
 * The three letters come first because they are what a hurried human types;
 * the clause after them is there because the fourth answer has no key to
 * name — you just say the thing — and an option nobody is told about may as
 * well not exist.
 */
export const PERMISSION_ANSWER_HINT = "[y/n/a, or say what to do instead]";

/** The text of one permission prompt: an optional preview block, and the question. */
export interface PermissionPromptText {
  /** Multi-line preview of what the tool will do, or `undefined` for none. */
  readonly block: string | undefined;
  /** The one-line question, always ending in {@link PERMISSION_ANSWER_HINT}. */
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
      ? `allow ${request.tool}? ${previewInput(request.input)} ${PERMISSION_ANSWER_HINT} `
      : `allow ${request.tool}? ${PERMISSION_ANSWER_HINT} `;
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
