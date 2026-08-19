import { describe, expect, it } from "vitest";
import {
  mediaTypeFromExtension,
  resolveImageMediaType,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  sniffImageMediaType,
} from "../src/index.js";

function bytes(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

const PNG_BYTES = bytes(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  0,
);
const JPEG_BYTES = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0);
const GIF87_BYTES = Uint8Array.from(ascii("GIF87a").concat([0, 0, 0]));
const GIF89_BYTES = Uint8Array.from(ascii("GIF89a").concat([0, 0, 0]));
const WEBP_BYTES = Uint8Array.from(
  ascii("RIFF").concat([0x24, 0, 0, 0]).concat(ascii("WEBP")),
);

describe("sniffImageMediaType", () => {
  it("recognizes a PNG signature", () => {
    expect(sniffImageMediaType(PNG_BYTES)).toBe("image/png");
  });

  it("recognizes a JPEG signature", () => {
    expect(sniffImageMediaType(JPEG_BYTES)).toBe("image/jpeg");
  });

  it("recognizes GIF87a and GIF89a signatures", () => {
    expect(sniffImageMediaType(GIF87_BYTES)).toBe("image/gif");
    expect(sniffImageMediaType(GIF89_BYTES)).toBe("image/gif");
  });

  it("recognizes a RIFF/WEBP signature", () => {
    expect(sniffImageMediaType(WEBP_BYTES)).toBe("image/webp");
  });

  it("returns undefined for unrecognized bytes", () => {
    expect(sniffImageMediaType(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
  });

  it("returns undefined for a RIFF file that isn't WEBP (e.g. WAV)", () => {
    const wav = Uint8Array.from(
      ascii("RIFF").concat([0, 0, 0, 0]).concat(ascii("WAVE")),
    );
    expect(sniffImageMediaType(wav)).toBeUndefined();
  });

  it("does not crash on buffers shorter than a signature", () => {
    expect(sniffImageMediaType(bytes(0x89, 0x50))).toBeUndefined();
  });
});

describe("mediaTypeFromExtension", () => {
  it("maps every supported extension, case-insensitively", () => {
    expect(mediaTypeFromExtension("photo.png")).toBe("image/png");
    expect(mediaTypeFromExtension("photo.PNG")).toBe("image/png");
    expect(mediaTypeFromExtension("photo.jpg")).toBe("image/jpeg");
    expect(mediaTypeFromExtension("photo.JPEG")).toBe("image/jpeg");
    expect(mediaTypeFromExtension("photo.gif")).toBe("image/gif");
    expect(mediaTypeFromExtension("photo.webp")).toBe("image/webp");
  });

  it("returns undefined for an unsupported or missing extension", () => {
    expect(mediaTypeFromExtension("photo.bmp")).toBeUndefined();
    expect(mediaTypeFromExtension("photo")).toBeUndefined();
    expect(mediaTypeFromExtension("/dir/.hidden")).toBeUndefined();
  });

  it("resolves an extension out of a full path", () => {
    expect(mediaTypeFromExtension("/home/user/shots/diagram.webp")).toBe(
      "image/webp",
    );
  });
});

describe("resolveImageMediaType", () => {
  it("prefers magic bytes over a mismatched extension", () => {
    // Real JPEG bytes behind a misleading ".png" name: the sniffed type wins.
    expect(resolveImageMediaType(JPEG_BYTES, "mislabeled.png")).toBe(
      "image/jpeg",
    );
  });

  it("falls back to the extension when the bytes are not recognized", () => {
    const unrecognized = bytes(1, 2, 3, 4, 5, 6, 7, 8);
    expect(resolveImageMediaType(unrecognized, "photo.webp")).toBe(
      "image/webp",
    );
  });

  it("returns undefined when neither bytes nor extension resolve", () => {
    const unrecognized = bytes(1, 2, 3, 4);
    expect(resolveImageMediaType(unrecognized, "photo.bmp")).toBeUndefined();
  });
});

describe("SUPPORTED_IMAGE_MEDIA_TYPES", () => {
  it("lists exactly png, jpeg, gif and webp", () => {
    expect([...SUPPORTED_IMAGE_MEDIA_TYPES].sort()).toEqual(
      ["image/gif", "image/jpeg", "image/png", "image/webp"].sort(),
    );
  });
});
