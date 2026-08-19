import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import { CodexBackend } from "../../src/backends/codex.js";
import type { DelegatedBackendFactory } from "../../src/planning/delegated-cli.js";
import { writeFakeClaude, writeFakeCodex } from "../backends/test-helpers.js";

/**
 * The fake-binary harness both delegated steps are tested through: a real
 * `CodexBackend`/`ClaudeCodeBackend` pointed at a scripted shell script, so
 * the assertions still see the flags and the prompt the step itself chose.
 */

export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** The stdout a fake `claude` prints to deliver `reply` as its final text. */
export function claudeReply(reply: string): string {
  return `${json({ type: "result", subtype: "success", result: reply })}\n`;
}

/** The stdout a fake `codex` prints to deliver `reply` as its last message. */
export function codexReply(reply: string): string {
  return `${json({
    type: "item.completed",
    item: { type: "agent_message", text: reply },
  })}\n`;
}

export interface FakeCli {
  readonly binaryPath: string;
  /** Argv of the nth (1-based) invocation, NUL-separated on disk. */
  argv(attempt: number): Promise<string[]>;
  /** The prompt of the nth invocation: always the trailing argument. */
  prompt(attempt: number): Promise<string>;
}

/**
 * Writes a fake CLI that answers with `replies[n - 1]` on its nth invocation
 * (repeating the last one once exhausted) and dumps each invocation's argv.
 */
export async function writeScriptedCli(
  dir: string,
  backend: "codex" | "claude-code",
  replies: readonly string[],
): Promise<FakeCli> {
  const counter = join(dir, "count");
  const replyPaths: string[] = [];
  for (const [index, reply] of replies.entries()) {
    const replyPath = join(dir, `reply.${String(index + 1)}`);
    await writeFile(replyPath, reply, "utf8");
    replyPaths.push(replyPath);
  }

  const branches = replyPaths.map(
    (replyPath, index) =>
      `if [ "$n" -le ${String(index + 1)} ]; then cat ${replyPath}; exit 0; fi`,
  );
  const body = [
    `n=$(cat ${counter} 2>/dev/null || echo 0)`,
    "n=$((n+1))",
    `echo $n > ${counter}`,
    `printf '%s\\0' "$@" > ${join(dir, "argv.")}$n`,
    ...branches,
    `cat ${replyPaths.at(-1) ?? "/dev/null"}`,
    "exit 0",
  ].join("\n");

  const write = backend === "codex" ? writeFakeCodex : writeFakeClaude;
  const binaryPath = await write(
    dir,
    { body },
    backend === "codex" ? "codex" : "claude",
  );

  const argv = async (attempt: number): Promise<string[]> => {
    const raw = await readFile(join(dir, `argv.${String(attempt)}`), "utf8");
    return raw.split("\0").slice(0, -1);
  };
  return {
    binaryPath,
    argv,
    prompt: async (attempt) => (await argv(attempt)).at(-1) ?? "",
  };
}

/**
 * The step's own backend options, plus the fake binary. Everything the
 * assertions care about — sandboxing, `--model` — is still chosen by the
 * planner or the compiler, not by this factory.
 */
export function fakeBackendFactory(
  binaryPath: string,
): DelegatedBackendFactory {
  return (spec) =>
    spec.backend === "codex"
      ? new CodexBackend({ ...spec.options, binaryPath })
      : new ClaudeCodeBackend({ ...spec.options, binaryPath });
}
