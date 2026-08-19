import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageMediaType } from "@agent/ai";
import { resolveImageMediaType } from "@agent/ai";
import type { AgentImageAttachment } from "@agent/core";

/**
 * `-i/--image` accepts at most this many attachments per run (P1-9). Kept
 * small: each one rides inline in the request body (native) or as its own
 * CLI flag (Codex), and a coding objective rarely needs more than a
 * screenshot or two.
 */
export const MAX_IMAGE_COUNT = 4;

/** Per-file cap, checked from `stat` before the file is ever read into memory. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Cap on the combined size of every attached image's *decoded* (on-disk)
 * bytes. Base64 inflates payload size by ~4/3 on the wire, so 20 MiB of
 * source bytes here is already ~26.7 MiB once base64-encoded into the
 * request body — deliberately conservative given that body also carries the
 * rest of the conversation.
 */
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export type ResolveImagesResult =
  | { readonly ok: true; readonly images: readonly AgentImageAttachment[] }
  | { readonly ok: false; readonly error: string };

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Validates and reads every `-i/--image` path into a base64 attachment ready
 * to ride with the objective's first user message (native) or be forwarded
 * as a CLI flag (Codex). Relative paths resolve against `cwd`, matching how
 * `--cwd` resolves the workspace itself.
 *
 * Never throws: filesystem and format problems come back as a friendly
 * `error` string rather than a stack trace, matching `--max-iterations`/
 * `--timeout` validation elsewhere in the CLI. Checks run in the order a
 * user would want to hear about them — count, then per-file existence/size,
 * then the running total — so the first problem reported is also the first
 * one to fix.
 */
export async function resolveImageAttachments(
  paths: readonly string[],
  cwd: string,
): Promise<ResolveImagesResult> {
  if (paths.length === 0) return { ok: true, images: [] };
  if (paths.length > MAX_IMAGE_COUNT) {
    return {
      ok: false,
      error: `Too many images: got ${paths.length}, but at most ${MAX_IMAGE_COUNT} are allowed per run.`,
    };
  }

  const images: AgentImageAttachment[] = [];
  let totalBytes = 0;

  for (const raw of paths) {
    const resolved = path.resolve(cwd, raw);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch {
      return { ok: false, error: `Image not found: "${raw}"` };
    }
    if (!info.isFile()) {
      return { ok: false, error: `Not a file: "${raw}"` };
    }
    if (info.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Image "${raw}" is ${formatBytes(info.size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} per-image limit.`,
      };
    }
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Attached images total ${formatBytes(totalBytes)}, over the ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} combined limit.`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(resolved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not read image "${raw}": ${detail}` };
    }

    const mediaType: ImageMediaType | undefined = resolveImageMediaType(
      bytes,
      resolved,
    );
    if (mediaType === undefined) {
      return {
        ok: false,
        error: `Unrecognized image format for "${raw}": expected PNG, JPEG, GIF or WEBP.`,
      };
    }

    images.push({
      mediaType,
      base64: bytes.toString("base64"),
      path: resolved,
    });
  }

  return { ok: true, images };
}
