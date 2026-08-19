import type { ImageMediaType } from "./index.js";

/**
 * Media types a provider's vision input accepts (P1-9's `-i/--image`).
 * Anthropic's Messages API and OpenAI's Chat Completions both draw the line
 * at this same set.
 */
export const SUPPORTED_IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

function matchesMagic(
  bytes: Uint8Array,
  offset: number,
  magic: readonly number[],
): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF87_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50];

/**
 * Sniffs an image's media type from its leading bytes, ignoring whatever
 * extension the file happened to be given. Returns `undefined` for anything
 * this sniffer does not recognize — callers fall back to
 * {@link mediaTypeFromExtension} rather than treating that as fatal, since a
 * format outside this list (e.g. bmp) is still legitimately "unsupported"
 * either way.
 */
export function sniffImageMediaType(
  bytes: Uint8Array,
): ImageMediaType | undefined {
  if (matchesMagic(bytes, 0, PNG_MAGIC)) return "image/png";
  if (matchesMagic(bytes, 0, JPEG_MAGIC)) return "image/jpeg";
  if (
    matchesMagic(bytes, 0, GIF87_MAGIC) ||
    matchesMagic(bytes, 0, GIF89_MAGIC)
  ) {
    return "image/gif";
  }
  if (
    matchesMagic(bytes, 0, RIFF_MAGIC) &&
    matchesMagic(bytes, 8, WEBP_MAGIC)
  ) {
    return "image/webp";
  }
  return undefined;
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Media type implied by a file's extension alone, case-insensitively. */
export function mediaTypeFromExtension(
  filePath: string,
): ImageMediaType | undefined {
  const match = /\.[^./\\]+$/.exec(filePath);
  const ext = match?.[0]?.toLowerCase();
  return ext === undefined ? undefined : EXTENSION_MEDIA_TYPES[ext];
}

/**
 * Resolves the media type kapel will declare to a provider for an attached
 * image. Magic bytes are authoritative when recognized — a `.png` that is
 * actually a renamed JPEG is sent as `image/jpeg`, matching what the bytes
 * really are rather than what the filename claims. The extension is only a
 * fallback for a well-formed file this sniffer's small magic-byte table does
 * not cover.
 */
export function resolveImageMediaType(
  bytes: Uint8Array,
  filePath: string,
): ImageMediaType | undefined {
  return sniffImageMediaType(bytes) ?? mediaTypeFromExtension(filePath);
}
