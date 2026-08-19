import path from "node:path";
import { UsageTracker } from "@agent/ai";
import { ClaudeCodeBackend } from "@agent/coding-agent";
import type { AgentImageAttachment } from "@agent/core";
import {
  claudeCodeInstallGuidance,
  claudeCodeLoginGuidance,
} from "./backend.js";
import { loadDotEnvFile } from "./env.js";
import { JsonRenderer, type Renderer, TextRenderer } from "./render.js";

export interface RunClaudeCodeObjectiveOptions {
  readonly cwd: string;
  /** Only set when a human chose a model; see `delegatedModelOverride`. */
  readonly model?: string;
  readonly timeoutSeconds?: number;
  readonly json: boolean;
  /**
   * `-i/--image` attachments, already validated and read; see `images.ts`
   * (P1-9). Claude Code's headless `-p` mode has no flag for these — passing
   * any through here makes `ClaudeCodeBackend.run` fail immediately with a
   * clear explanation instead of silently dropping them.
   */
  readonly images?: readonly AgentImageAttachment[];
}

/**
 * Runs one objective through the Claude Code CLI backend. Returns the process
 * exit code, using the same success/partial/failed → 0/2/1 mapping as
 * `runObjective` and `runCodexObjective`.
 *
 * Like the Codex path, this skips model/provider credential resolution and the
 * `PermissionEngine` entirely: Claude Code authenticates itself with the user's
 * subscription login and enforces its own approvals. `.env` is still loaded,
 * since it may carry unrelated configuration (e.g. a workspace-local
 * `AGENT_BACKEND`).
 */
export async function runClaudeCodeObjective(
  objective: string,
  options: RunClaudeCodeObjectiveOptions,
): Promise<number> {
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const availability = await ClaudeCodeBackend.checkAvailability();
  if (!availability.installed) {
    console.error(claudeCodeInstallGuidance(availability));
    return 1;
  }
  if (!availability.loggedIn) {
    console.error(claudeCodeLoginGuidance(availability));
    return 1;
  }

  const renderer: Renderer = options.json
    ? new JsonRenderer()
    : new TextRenderer();

  const backend = new ClaudeCodeBackend({
    ...(options.model === undefined ? {} : { model: options.model }),
    events: renderer,
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutMs: options.timeoutSeconds * 1000 }),
  });

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    const result = await backend.run(
      {
        instruction: objective,
        ...(options.images !== undefined && options.images.length > 0
          ? { images: options.images }
          : {}),
      },
      {
        runId: crypto.randomUUID(),
        workspacePath,
        signal: controller.signal,
      },
    );

    // No model call goes through the native UsageTracker on this route, so its
    // totals are always zero; the renderer prefers the result's own `usage`.
    renderer.result(result, new UsageTracker().totals());

    if (result.status === "success") return 0;
    if (result.status === "partial") return 2;
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
