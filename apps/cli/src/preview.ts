/**
 * Human previews of a tool call, for the permission prompt.
 *
 * A permission question is only worth answering if it says what is about to
 * happen, and `{"path":"calc.js","oldText":"a - b",…}` truncated at 120
 * characters does not: the thing being approved is a *change*, so it is shown
 * as one. `bash` shows the command it will run, `edit_file` shows a unified
 * diff of the replacement, `write_file` shows the head of the new file, and
 * everything else keeps the compact JSON one-liner.
 *
 * Everything here is pure — text in, text out — so the prompter (and, later,
 * the renderer) can share it without sharing a stream.
 */

const PREVIEW_MAX = 120;

/** Most lines any single preview block may occupy, tail line included. */
export const PREVIEW_MAX_LINES = 40;

/** Unchanged lines kept on each side of a change in a diff. */
const DIFF_CONTEXT = 3;

/**
 * Above this many lines on either side of a change, the quadratic LCS is
 * skipped and the hunk is reported as a plain "all of this out, all of that
 * in" replacement. Edit hunks are small in practice; this only bounds the
 * pathological case.
 */
const LCS_MAX_LINES = 300;

/** Leading lines of a `write_file` body shown before truncating. */
const WRITE_PREVIEW_LINES = 20;

const RED = "31";
const GREEN = "32";
const DIM = "2";

function ansi(code: string, text: string, enabled: boolean): string {
  return enabled ? `[${code}m${text}[0m` : text;
}

export interface PreviewOptions {
  /** ANSI colouring. Off unless the caller knows it is writing to a TTY. */
  readonly color?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
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

// --- line diff ---------------------------------------------------------------

export type DiffMarker = "-" | "+" | " ";

export interface DiffLine {
  readonly marker: DiffMarker;
  readonly text: string;
}

/** Longest-common-subsequence diff of two line arrays, unbounded in cost. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // dp[i * width + j] = length of the LCS of a[i..] and b[j..].
  const dp = new Array<number>((n + 1) * width).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ marker: " ", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      out.push({ marker: "-", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ marker: "+", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push({ marker: "-", text: a[i] ?? "" });
  for (; j < m; j += 1) out.push({ marker: "+", text: b[j] ?? "" });
  return out;
}

/**
 * Line-based diff of two texts.
 *
 * Common leading and trailing lines are matched off first (cheap, and it is
 * what makes the quadratic middle small for a typical edit); the remaining
 * middle goes through an LCS unless it is large enough to be worth avoiding,
 * in which case it degrades to "everything removed, then everything added" —
 * still correct, just less pretty.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle =
    midA.length > LCS_MAX_LINES || midB.length > LCS_MAX_LINES
      ? [
          ...midA.map((text): DiffLine => ({ marker: "-", text })),
          ...midB.map((text): DiffLine => ({ marker: "+", text })),
        ]
      : lcsDiff(midA, midB);

  return [
    ...a.slice(0, head).map((text): DiffLine => ({ marker: " ", text })),
    ...middle,
    ...a
      .slice(a.length - tail)
      .map((text): DiffLine => ({ marker: " ", text })),
  ];
}

function paint(line: DiffLine, color: boolean): string {
  const text = `  ${line.marker} ${line.text}`;
  if (line.marker === "-") return ansi(RED, text, color);
  if (line.marker === "+") return ansi(GREEN, text, color);
  return text;
}

/** `… (+N more)`, the tail every truncated preview ends with. */
function moreTail(count: number, color: boolean): string {
  return ansi(DIM, `  … (+${count} more)`, color);
}

function capLines(lines: readonly string[], color: boolean): string[] {
  if (lines.length <= PREVIEW_MAX_LINES) return [...lines];
  const kept = lines.slice(0, PREVIEW_MAX_LINES - 1);
  return [...kept, moreTail(lines.length - kept.length, color)];
}

/**
 * Renders a diff with at most {@link DIFF_CONTEXT} unchanged lines around each
 * change; longer runs of untouched lines collapse to a single `⋮`.
 */
export function renderDiff(
  lines: readonly DiffLine[],
  options: PreviewOptions = {},
): string[] {
  const color = options.color === true;
  const keep = lines.map((line) => line.marker !== " ");
  lines.forEach((line, index) => {
    if (line.marker === " ") return;
    const from = Math.max(0, index - DIFF_CONTEXT);
    const to = Math.min(lines.length - 1, index + DIFF_CONTEXT);
    for (let near = from; near <= to; near += 1) keep[near] = true;
  });

  const out: string[] = [];
  let elided = false;
  lines.forEach((line, index) => {
    if (keep[index] === true) {
      out.push(paint(line, color));
      elided = false;
      return;
    }
    if (!elided) {
      out.push(ansi(DIM, "  ⋮", color));
      elided = true;
    }
  });

  return capLines(out, color);
}

// --- per-tool previews -------------------------------------------------------

/**
 * The command a `bash` call will run, indented and shown in full — multi-line
 * commands keep their own line breaks.
 */
export function previewBash(
  input: unknown,
  options: PreviewOptions = {},
): string | undefined {
  const command = stringField(input, "command");
  if (command === undefined) return undefined;
  const lines = command.split("\n").map((line) => `  ${line}`);
  return capLines(lines, options.color === true).join("\n");
}

/**
 * A unified diff of an `edit_file` replacement, headed by the target path.
 *
 * The diff covers `oldText` → `newText` only — the snippet being replaced, not
 * the whole file — which is exactly the text the model asked to change.
 */
export function previewEdit(
  input: unknown,
  options: PreviewOptions = {},
): string | undefined {
  const path = stringField(input, "path");
  const oldText = stringField(input, "oldText");
  const newText = stringField(input, "newText");
  if (path === undefined || oldText === undefined || newText === undefined) {
    return undefined;
  }
  const replaceAll =
    isRecord(input) && input.replaceAll === true ? " (all occurrences)" : "";
  const header = ansi(DIM, `  ${path}${replaceAll}`, options.color === true);
  return [header, ...renderDiff(diffLines(oldText, newText), options)].join(
    "\n",
  );
}

/** The target path and the head of the content a `write_file` call will write. */
export function previewWrite(
  input: unknown,
  options: PreviewOptions = {},
): string | undefined {
  const path = stringField(input, "path");
  const content = stringField(input, "content");
  if (path === undefined || content === undefined) return undefined;

  const color = options.color === true;
  const lines = content.split("\n");
  const shown = lines.slice(0, WRITE_PREVIEW_LINES);
  const body = shown.map((text) => paint({ marker: "+", text }, color));
  if (lines.length > shown.length) {
    body.push(moreTail(lines.length - shown.length, color));
  }
  const header = ansi(
    DIM,
    `  ${path} (${lines.length} line${lines.length === 1 ? "" : "s"})`,
    color,
  );
  return [header, ...body].join("\n");
}

/**
 * The preview block shown above a permission question, or `undefined` when the
 * tool (or an input that does not match its schema) has nothing better to show
 * than the compact JSON the question line already carries.
 */
export function formatToolPreview(
  tool: string,
  input: unknown,
  options: PreviewOptions = {},
): string | undefined {
  switch (tool) {
    case "bash":
      return previewBash(input, options);
    case "edit_file":
      return previewEdit(input, options);
    case "write_file":
      return previewWrite(input, options);
    default:
      return undefined;
  }
}
