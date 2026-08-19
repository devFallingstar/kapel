import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  resolveImageAttachments,
} from "../src/images.js";

const SCRATCHPAD = process.env.AGENT_TEST_TMPDIR || tmpdir();

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(SCRATCHPAD, "kapel-images-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeImage(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

describe("resolveImageAttachments", () => {
  it("returns an empty list for no paths", async () => {
    const result = await resolveImageAttachments([], dir);
    expect(result).toEqual({ ok: true, images: [] });
  });

  it("reads, base64-encodes and sniffs the media type of each image", async () => {
    const png = await writeImage("a.png", PNG_BYTES);
    const jpeg = await writeImage("b.jpg", JPEG_BYTES);

    const result = await resolveImageAttachments([png, jpeg], dir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.images).toEqual([
      {
        mediaType: "image/png",
        base64: PNG_BYTES.toString("base64"),
        path: png,
      },
      {
        mediaType: "image/jpeg",
        base64: JPEG_BYTES.toString("base64"),
        path: jpeg,
      },
    ]);
  });

  it("resolves relative paths against cwd", async () => {
    await writeImage("rel.png", PNG_BYTES);
    const result = await resolveImageAttachments(["rel.png"], dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.images[0]?.path).toBe(path.join(dir, "rel.png"));
  });

  it("prefers magic bytes over a misleading extension", async () => {
    const mislabeled = await writeImage("actually-jpeg.png", JPEG_BYTES);
    const result = await resolveImageAttachments([mislabeled], dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.images[0]?.mediaType).toBe("image/jpeg");
  });

  it("rejects more than MAX_IMAGE_COUNT paths without touching the filesystem", async () => {
    const paths = Array.from(
      { length: MAX_IMAGE_COUNT + 1 },
      (_, i) => `missing-${i}.png`,
    );
    const result = await resolveImageAttachments(paths, dir);
    expect(result).toEqual({
      ok: false,
      error: `Too many images: got ${MAX_IMAGE_COUNT + 1}, but at most ${MAX_IMAGE_COUNT} are allowed per run.`,
    });
  });

  it("accepts exactly MAX_IMAGE_COUNT images", async () => {
    const paths: string[] = [];
    for (let i = 0; i < MAX_IMAGE_COUNT; i++) {
      paths.push(await writeImage(`img-${i}.png`, PNG_BYTES));
    }
    const result = await resolveImageAttachments(paths, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.images).toHaveLength(MAX_IMAGE_COUNT);
  });

  it("reports a friendly error for a missing file", async () => {
    const result = await resolveImageAttachments(["nope.png"], dir);
    expect(result).toEqual({
      ok: false,
      error: 'Image not found: "nope.png"',
    });
  });

  it("reports a friendly error for a path that is a directory, not a file", async () => {
    const subdir = path.join(dir, "sub");
    await mkdir(subdir);
    const result = await resolveImageAttachments(["sub"], dir);
    expect(result).toEqual({ ok: false, error: 'Not a file: "sub"' });
  });

  it("rejects a single file over the per-image size cap", async () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_BYTES, 0x00)]);
    const file = await writeImage("big.png", big);
    const result = await resolveImageAttachments([file], dir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an error");
    expect(result.error).toContain("over the 5.0 MiB per-image limit");
  });

  it("accepts a combined total sitting exactly on MAX_TOTAL_IMAGE_BYTES (MAX_IMAGE_COUNT files each at MAX_IMAGE_BYTES)", async () => {
    // With the shipped defaults, MAX_IMAGE_COUNT * MAX_IMAGE_BYTES equals
    // MAX_TOTAL_IMAGE_BYTES exactly, so this is the largest a run can ever
    // be — it must still be accepted (the total check is `>`, not `>=`).
    expect(MAX_IMAGE_COUNT * MAX_IMAGE_BYTES).toBe(MAX_TOTAL_IMAGE_BYTES);

    const chunk = Buffer.concat([
      PNG_BYTES,
      Buffer.alloc(MAX_IMAGE_BYTES - PNG_BYTES.length, 0x00),
    ]);
    const files: string[] = [];
    for (let i = 0; i < MAX_IMAGE_COUNT; i++) {
      files.push(await writeImage(`chunk-${i}.png`, chunk));
    }
    const result = await resolveImageAttachments(files, dir);
    expect(result.ok).toBe(true);
  });

  it("reports a friendly error for an unrecognized image format", async () => {
    const file = await writeImage("mystery.bin", Buffer.from([1, 2, 3, 4]));
    const result = await resolveImageAttachments([file], dir);
    expect(result).toEqual({
      ok: false,
      error: `Unrecognized image format for "${file}": expected PNG, JPEG, GIF or WEBP.`,
    });
  });
});
