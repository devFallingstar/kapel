import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "@agent/core";
import { z } from "zod";
import {
  detachedSpawnOptions,
  killProcessTree,
  shellInvocationFor,
} from "../platform/shell.js";
import { toInputSchema } from "./json-schema.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;
const KILL_GRACE_MS = 2000;

const InputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .describe(
        "Shell command to run in the workspace (bash -lc on POSIX, cmd.exe /c on Windows).",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        "Maximum time to allow the command to run, in milliseconds. Defaults to 120000, max 600000.",
      ),
  })
  .strict();

export type BashInput = z.infer<typeof InputSchema>;

export interface BashOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

function capText(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${text.length - MAX_OUTPUT_CHARS} more characters]`;
}

export class BashTool implements Tool<BashInput, BashOutput> {
  readonly name = "bash";
  readonly description =
    "Runs a shell command in the workspace directory through the platform shell (bash -lc on " +
    "POSIX, cmd.exe on Windows) and returns its stdout, stderr, and exit code. On Windows, " +
    "cmd syntax applies: && and || work, but export, backticks, and $(...) do not. Has a " +
    "timeout (default 120s, max 600s) and is cancellable via the run's abort signal; " +
    "stdout/stderr are each capped at 100,000 characters.";
  readonly inputSchema = toInputSchema(InputSchema);

  definition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  async execute(rawInput: unknown, context: ToolContext): Promise<BashOutput> {
    const input = InputSchema.parse(rawInput);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("aborted");
    }

    return new Promise<BashOutput>((resolvePromise, reject) => {
      const shell = shellInvocationFor(input.command);
      const child = spawn(shell.command, [...shell.args], {
        cwd: context.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOptions(),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const killGroup = (signal: NodeJS.Signals): void => {
        killProcessTree(child, signal);
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs);
      timeoutTimer.unref();

      const onAbort = (): void => {
        aborted = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        context.signal.removeEventListener("abort", onAbort);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (aborted && !timedOut) {
          reject(context.signal.reason ?? new Error("aborted"));
          return;
        }
        resolvePromise({
          stdout: capText(stdout),
          stderr: capText(stderr),
          exitCode: code ?? -1,
          timedOut,
        });
      });
    });
  }
}
