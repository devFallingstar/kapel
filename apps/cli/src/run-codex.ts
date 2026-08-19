import path from "node:path";
import { UsageTracker } from "@agent/ai";
import { CodexBackend } from "@agent/coding-agent";
import {
  codexInstallGuidance,
  codexLoginGuidance,
  type SandboxMode,
} from "./backend.js";
import { loadDotEnvFile } from "./env.js";
import { JsonRenderer, type Renderer, TextRenderer } from "./render.js";

export interface RunCodexObjectiveOptions {
  readonly cwd: string;
  /** Only set when the user explicitly passed `-m`/`--model`; see `codexModelOverride`. */
  readonly model?: string;
  readonly timeoutSeconds?: number;
  readonly json: boolean;
  readonly sandbox: SandboxMode;
  readonly fullAuto: boolean;
}

/**
 * Runs one objective through the Codex CLI backend. Returns the process exit
 * code, using the same success/partial/failed → 0/2/1 mapping as
 * `runObjective`.
 *
 * Unlike the native path, this skips model/provider credential resolution
 * and the `PermissionEngine` entirely: Codex authenticates itself (`codex
 * login`) and enforces its own approvals via `--sandbox`/`--full-auto`.
 * `.env` is still loaded since it's harmless and may carry unrelated
 * configuration (e.g. a workspace-local `AGENT_BACKEND`).
 */
export async function runCodexObjective(
  objective: string,
  options: RunCodexObjectiveOptions,
): Promise<number> {
  const workspacePath = path.resolve(options.cwd);
  await loadDotEnvFile(workspacePath);

  const availability = await CodexBackend.checkAvailability();
  if (!availability.installed) {
    console.error(codexInstallGuidance(availability));
    return 1;
  }
  if (!availability.loggedIn) {
    console.error(codexLoginGuidance(availability));
    return 1;
  }

  const renderer: Renderer = options.json
    ? new JsonRenderer()
    : new TextRenderer();

  const backend = new CodexBackend({
    ...(options.model === undefined ? {} : { model: options.model }),
    sandbox: options.sandbox,
    fullAuto: options.fullAuto,
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
      { instruction: objective },
      {
        runId: crypto.randomUUID(),
        workspacePath,
        signal: controller.signal,
      },
    );

    // The native path's UsageTracker never sees any model calls on this
    // route, so its totals are always zero; the renderer prefers the
    // result's own `usage` (see `TextRenderer#result`).
    renderer.result(result, new UsageTracker().totals());

    if (result.status === "success") return 0;
    if (result.status === "partial") return 2;
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
