import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  annotateMentions,
  completeMention,
  createFileLister,
  type FileLister,
  fuzzyScore,
  imageAnnotation,
  MAX_MENTION_IMAGE_BYTES,
  MAX_MENTION_IMAGES,
  MAX_WALK_DEPTH,
  type MentionImageReader,
  mentionAnnotation,
  mentionTokenAt,
  prepareMentions,
  rankMentionMatches,
  resolveMentions,
  workspaceFileExists,
  workspaceImagePathReader,
  workspaceImageReader,
} from "../src/mention.js";

const execFileAsync = promisify(execFile);

/** Sandboxed runs point the fixtures at a writable scratch directory. */
const TEST_TMP_ROOT = process.env.AGENT_TEST_TMPDIR || tmpdir();

const created: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP_ROOT, prefix));
  created.push(dir);
  return dir;
}

async function write(
  root: string,
  relative: string,
  body = "x",
): Promise<void> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- fuzzy ranking (pure) ---------------------------------------------------

describe("fuzzyScore", () => {
  it("returns undefined when the query is not a subsequence", () => {
    expect(fuzzyScore("apps/cli/src/input.ts", "zzz")).toBeUndefined();
    // Right characters, wrong order — a subsequence is ordered.
    expect(fuzzyScore("input.ts", "tupni")).toBeUndefined();
  });

  it("scores an empty query as a neutral match, so a bare @ lists everything", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });

  it("is case-insensitive in both directions", () => {
    expect(fuzzyScore("README.md", "readme")).toBe(
      fuzzyScore("readme.md", "README"),
    );
  });

  it("prefers a tight run over the same characters spread out", () => {
    const tight = fuzzyScore("src/input.ts", "input");
    const loose = fuzzyScore("i-n-p-u-t-x.ts", "input");
    expect(tight).toBeDefined();
    expect(loose).toBeDefined();
    expect(tight as number).toBeGreaterThan(loose as number);
  });

  it("rewards characters landing on a path-segment boundary", () => {
    const onBoundary = fuzzyScore("apps/cli/src/x.ts", "cs");
    const insideWords = fuzzyScore("apxxcxxsxx.ts", "cs");
    expect(onBoundary as number).toBeGreaterThan(insideWords as number);
  });

  it("does not charge for the run-up to the first matched character", () => {
    // Same match quality, different depth: the deep path is not penalised for
    // being deep — that is the ranking's tiebreak, not the score's job.
    expect(fuzzyScore("a/b/c/d/input.ts", "input")).toBe(
      fuzzyScore("input.ts", "input"),
    );
  });

  it("caps a single gap so one huge hole cannot swamp the rest", () => {
    const short = fuzzyScore(`a${"z".repeat(20)}b`, "ab");
    const long = fuzzyScore(`a${"z".repeat(200)}b`, "ab");
    expect(short).toBe(long);
  });
});

describe("rankMentionMatches", () => {
  const paths = [
    "apps/cli/src/input.ts",
    "apps/cli/src/interactive.ts",
    "apps/cli/test/input.test.ts",
    "packages/core/src/index.ts",
    "README.md",
  ];

  it("puts the tightest match first — @clisrc finds apps/cli/src", () => {
    expect(rankMentionMatches(paths, "clisrc")[0]).toBe(
      "apps/cli/src/input.ts",
    );
  });

  it("drops everything the query is not a subsequence of", () => {
    expect(rankMentionMatches(paths, "readme")).toEqual(["README.md"]);
    expect(rankMentionMatches(paths, "nothinghere")).toEqual([]);
  });

  it("breaks ties on the shorter path, then alphabetically", () => {
    // An empty query scores everything 0, so the order is pure tiebreak.
    expect(rankMentionMatches(paths, "")).toEqual([
      "README.md",
      "apps/cli/src/input.ts",
      "packages/core/src/index.ts",
      "apps/cli/src/interactive.ts",
      "apps/cli/test/input.test.ts",
    ]);
  });

  it("honours the limit", () => {
    expect(rankMentionMatches(paths, "", 2)).toEqual([
      "README.md",
      "apps/cli/src/input.ts",
    ]);
  });

  it("ranks a whole-path prefix above a scattered match", () => {
    const ranked = rankMentionMatches(paths, "apps/cli/src/in");
    expect(ranked[0]).toBe("apps/cli/src/input.ts");
    expect(ranked[1]).toBe("apps/cli/src/interactive.ts");
  });
});

// --- the token under the cursor ---------------------------------------------

describe("mentionTokenAt", () => {
  it("finds the @token being typed at the end of the line", () => {
    expect(mentionTokenAt("look at @apps/cl")).toBe("@apps/cl");
    expect(mentionTokenAt("@")).toBe("@");
  });

  it("ignores an @ that is not at the start of the word", () => {
    expect(mentionTokenAt("mail me@example.com")).toBeUndefined();
  });

  it("ignores a line whose last word is not a mention", () => {
    expect(mentionTokenAt("look at @apps/cl and ")).toBeUndefined();
    expect(mentionTokenAt("plain words")).toBeUndefined();
    expect(mentionTokenAt("")).toBeUndefined();
  });

  it("keeps only the last word, so an earlier mention does not win", () => {
    expect(mentionTokenAt("@one and @two")).toBe("@two");
  });
});

// --- listing the workspace --------------------------------------------------

describe("createFileLister — git source", () => {
  it("lists tracked and unignored-untracked files, and respects .gitignore", async () => {
    const root = await tempDir("kapel-mention-git-");
    await write(root, ".gitignore", "ignored.txt\nbuild/\n");
    await write(root, "tracked.ts");
    await write(root, "src/nested.ts");
    await write(root, "ignored.txt");
    await write(root, "build/out.js");
    await write(root, "untracked.md");

    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["add", "tracked.ts", "src/nested.ts"], {
      cwd: root,
    });

    const listed = await createFileLister({ workspacePath: root }).list();

    expect(listed).toContain("tracked.ts");
    expect(listed).toContain("src/nested.ts");
    // `--others --exclude-standard`: untracked but not ignored.
    expect(listed).toContain("untracked.md");
    expect(listed).not.toContain("ignored.txt");
    expect(listed).not.toContain("build/out.js");
  });
});

describe("createFileLister — non-git fallback", () => {
  /** Forces the fallback by declaring "no git here". */
  const noGit = (): Promise<undefined> => Promise.resolve(undefined);

  it("walks the directory when there is no git repo", async () => {
    const root = await tempDir("kapel-mention-walk-");
    await write(root, "a.txt");
    await write(root, "one/b.txt");

    const listed = await createFileLister({
      workspacePath: root,
      listTracked: noGit,
    }).list();

    expect([...listed].sort()).toEqual(["a.txt", "one/b.txt"]);
  });

  it("skips node_modules, .git and dist", async () => {
    const root = await tempDir("kapel-mention-skip-");
    await write(root, "keep.ts");
    await write(root, "node_modules/pkg/index.js");
    await write(root, ".git/HEAD");
    await write(root, "dist/bundle.js");

    const listed = await createFileLister({
      workspacePath: root,
      listTracked: noGit,
    }).list();

    expect(listed).toEqual(["keep.ts"]);
  });

  it("stops descending past the depth bound", async () => {
    const root = await tempDir("kapel-mention-depth-");
    const deep = Array.from({ length: MAX_WALK_DEPTH + 2 }, (_, i) => `d${i}`);
    for (let i = 0; i < deep.length; i += 1) {
      await write(root, `${deep.slice(0, i + 1).join("/")}/file.ts`);
    }

    const listed = await createFileLister({
      workspacePath: root,
      listTracked: noGit,
    }).list();

    const depths = listed.map((entry) => entry.split("/").length - 1);
    expect(Math.max(...depths)).toBeLessThanOrEqual(MAX_WALK_DEPTH);
    expect(listed).toContain("d0/file.ts");
  });

  it("stops at the entry ceiling", async () => {
    const root = await tempDir("kapel-mention-cap-");
    for (let i = 0; i < 12; i += 1) await write(root, `f${i}.txt`);

    const listed = await createFileLister({
      workspacePath: root,
      listTracked: noGit,
      maxEntries: 5,
    }).list();

    expect(listed).toHaveLength(5);
  });

  it("yields nothing (rather than throwing) for a directory that is not there", async () => {
    const listed = await createFileLister({
      workspacePath: path.join(TEST_TMP_ROOT, "kapel-mention-absent-dir"),
      listTracked: noGit,
    }).list();
    expect(listed).toEqual([]);
  });
});

describe("createFileLister — caching", () => {
  function counting(paths: readonly string[]): {
    calls: number;
    listTracked: () => Promise<readonly string[]>;
  } {
    const state = {
      calls: 0,
      listTracked: async (): Promise<readonly string[]> => {
        state.calls += 1;
        return paths;
      },
    };
    return state;
  }

  it("reuses the listing inside the TTL and reloads after it", async () => {
    const source = counting(["a.ts"]);
    let clock = 1_000;
    const lister = createFileLister({
      workspacePath: "/nowhere",
      ttlMs: 5_000,
      now: () => clock,
      listTracked: source.listTracked,
    });

    await lister.list();
    await lister.list();
    expect(source.calls).toBe(1);

    clock += 4_999;
    await lister.list();
    expect(source.calls).toBe(1);

    clock += 2;
    await lister.list();
    expect(source.calls).toBe(2);
  });

  it("reloads after invalidate, without waiting for the TTL", async () => {
    const source = counting(["a.ts"]);
    const lister = createFileLister({
      workspacePath: "/nowhere",
      now: () => 0,
      listTracked: source.listTracked,
    });

    await lister.list();
    lister.invalidate();
    await lister.list();
    expect(source.calls).toBe(2);
  });

  it("shares one in-flight listing between overlapping calls", async () => {
    const source = counting(["a.ts"]);
    const lister = createFileLister({
      workspacePath: "/nowhere",
      now: () => 0,
      listTracked: source.listTracked,
    });

    await Promise.all([lister.list(), lister.list(), lister.list()]);
    expect(source.calls).toBe(1);
  });

  it("reports no files when the source fails, instead of rejecting", async () => {
    const lister = createFileLister({
      workspacePath: "/nowhere",
      now: () => 0,
      listTracked: () => Promise.reject(new Error("boom")),
    });
    await expect(lister.list()).resolves.toEqual([]);
  });
});

// --- completion --------------------------------------------------------------

function fakeLister(paths: readonly string[]): FileLister {
  return {
    list: () => Promise.resolve(paths),
    invalidate: () => undefined,
  };
}

describe("completeMention", () => {
  const files = fakeLister([
    "apps/cli/src/input.ts",
    "apps/cli/src/interactive.ts",
    "README.md",
  ]);

  it("returns @-prefixed hits and the token they replace", async () => {
    const [hits, completeOn] = await completeMention(files, "@clisrcinp");
    expect(completeOn).toBe("@clisrcinp");
    expect(hits).toEqual(["@apps/cli/src/input.ts"]);
  });

  it("keeps every match when several are plausible, best first", async () => {
    const [hits] = await completeMention(files, "@in");
    expect(hits).toEqual([
      "@apps/cli/src/input.ts",
      "@apps/cli/src/interactive.ts",
    ]);
  });

  it("offers the workspace for a bare @", async () => {
    const [hits] = await completeMention(files, "@");
    expect(hits).toHaveLength(3);
    expect(hits[0]).toBe("@README.md");
  });

  it("returns no hits when nothing matches", async () => {
    const [hits, completeOn] = await completeMention(files, "@zzzz");
    expect(hits).toEqual([]);
    expect(completeOn).toBe("@zzzz");
  });

  it("honours the limit", async () => {
    const [hits] = await completeMention(files, "@", 1);
    expect(hits).toEqual(["@README.md"]);
  });
});

// --- send-time annotation ----------------------------------------------------

describe("workspaceFileExists", () => {
  it("accepts a file inside the workspace", async () => {
    const root = await tempDir("kapel-mention-exists-");
    await write(root, "src/a.ts");
    await expect(workspaceFileExists(root, "src/a.ts")).resolves.toBe(true);
  });

  it("rejects a directory, a missing path, and an escape upward", async () => {
    const root = await tempDir("kapel-mention-escape-");
    await write(root, "src/a.ts");
    await write(path.dirname(root), "outside.txt");

    await expect(workspaceFileExists(root, "src")).resolves.toBe(false);
    await expect(workspaceFileExists(root, "nope.ts")).resolves.toBe(false);
    await expect(workspaceFileExists(root, "../outside.txt")).resolves.toBe(
      false,
    );
  });
});

describe("resolveMentions", () => {
  const exists = (relativePath: string): boolean =>
    ["a.ts", "docs/b.md", "notes.md"].includes(relativePath);

  it("finds every mention that names a real file, in order", async () => {
    await expect(
      resolveMentions("compare @a.ts with @docs/b.md please", exists),
    ).resolves.toEqual(["a.ts", "docs/b.md"]);
  });

  it("ignores tokens that name nothing — @here is prose, not a path", async () => {
    await expect(
      resolveMentions("hey @here and @nope.ts", exists),
    ).resolves.toEqual([]);
  });

  it("ignores an email address", async () => {
    await expect(
      resolveMentions("mail me@example.com about a.ts", exists),
    ).resolves.toEqual([]);
  });

  it("trims trailing prose punctuation off a mention", async () => {
    await expect(resolveMentions("read @notes.md.", exists)).resolves.toEqual([
      "notes.md",
    ]);
    await expect(resolveMentions("read (@notes.md)", exists)).resolves.toEqual([
      "notes.md",
    ]);
  });

  it("prefers the longest form that exists", async () => {
    const dotted = (relativePath: string): boolean => relativePath === "a.ts.";
    await expect(resolveMentions("odd @a.ts.", dotted)).resolves.toEqual([
      "a.ts.",
    ]);
  });

  it("mentions the same file only once", async () => {
    await expect(resolveMentions("@a.ts and @a.ts", exists)).resolves.toEqual([
      "a.ts",
    ]);
  });
});

describe("annotateMentions", () => {
  const exists = (relativePath: string): boolean => relativePath === "a.ts";

  it("keeps the message verbatim and appends the mentioned-files line", async () => {
    await expect(annotateMentions("look at @a.ts", exists)).resolves.toBe(
      "look at @a.ts\n\n[mentioned files: a.ts]",
    );
  });

  it("leaves a message with no resolvable mention untouched", async () => {
    await expect(annotateMentions("look at @ghost.ts", exists)).resolves.toBe(
      "look at @ghost.ts",
    );
    await expect(annotateMentions("no mentions here", exists)).resolves.toBe(
      "no mentions here",
    );
  });

  it("never inlines the file's contents — only its path", async () => {
    const root = await tempDir("kapel-mention-inline-");
    await write(root, "secret.ts", "const SECRET = 42;");
    const annotated = await annotateMentions("read @secret.ts", (relative) =>
      workspaceFileExists(root, relative),
    );
    expect(annotated).toContain("[mentioned files: secret.ts]");
    expect(annotated).not.toContain("SECRET");
  });
});

describe("mentionAnnotation", () => {
  it("joins the paths on one line", () => {
    expect(mentionAnnotation(["a.ts", "b.ts"])).toBe(
      "[mentioned files: a.ts, b.ts]",
    );
    expect(imageAnnotation(["shot.png"])).toBe("[attached images: shot.png]");
  });
});

// --- image mentions ----------------------------------------------------------

/** A minimal well-formed-enough PNG: the magic bytes plus a little payload. */
function pngBytes(payload = "pixels"): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(payload, "utf8"),
  ]);
}

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);

describe("prepareMentions — images", () => {
  const exists = (): boolean => true;
  /** Every image reads back as a PNG whose payload is its own path. */
  const readImage: MentionImageReader = async (relativePath) => ({
    bytes: pngBytes(relativePath),
    path: `/repo/${relativePath}`,
  });
  const reader =
    (bytes: Buffer): MentionImageReader =>
    async (relativePath) => ({ bytes, path: `/repo/${relativePath}` });

  it("attaches an image mention as base64 and names it on its own line", async () => {
    const prepared = await prepareMentions("look at @shot.png", {
      exists,
      readImage,
    });

    expect(prepared.images).toEqual([
      {
        mediaType: "image/png",
        base64: pngBytes("shot.png").toString("base64"),
        path: "/repo/shot.png",
      },
    ]);
    expect(prepared.instruction).toBe(
      "look at @shot.png\n\n[attached images: shot.png]",
    );
    expect(prepared.imageMentions).toEqual(["shot.png"]);
    expect(prepared.imagePaths).toEqual(["/repo/shot.png"]);
    expect(prepared.notices).toEqual([]);
  });

  it("keeps text mentions on the paths line and images on the images line", async () => {
    const prepared = await prepareMentions("compare @src/a.ts with @shot.png", {
      exists,
      readImage,
    });

    expect(prepared.instruction).toBe(
      "compare @src/a.ts with @shot.png\n\n" +
        "[mentioned files: src/a.ts]\n[attached images: shot.png]",
    );
  });

  it("declares what the bytes really are, not what the extension claims", async () => {
    const prepared = await prepareMentions("look at @renamed.png", {
      exists,
      readImage: reader(JPEG_BYTES),
    });
    expect(prepared.images[0]?.mediaType).toBe("image/jpeg");
  });

  it("falls back to the extension when the sniffer recognizes nothing", async () => {
    const prepared = await prepareMentions("look at @odd.webp", {
      exists,
      readImage: reader(Buffer.from("not really an image", "utf8")),
    });
    expect(prepared.images[0]?.mediaType).toBe("image/webp");
  });

  it("attaches at most the per-turn count, and the rest stay paths", async () => {
    const mentions = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    expect(mentions).toHaveLength(MAX_MENTION_IMAGES + 1);

    const prepared = await prepareMentions(
      mentions.map((name) => `@${name}`).join(" "),
      { exists, readImage },
    );

    expect(prepared.images).toHaveLength(MAX_MENTION_IMAGES);
    expect(prepared.imageMentions).toEqual(mentions);
    expect(prepared.notices).toEqual([
      "note: @e.png was not attached — at most 4 images can ride with one message.",
    ]);
    expect(prepared.instruction).toContain("[mentioned files: e.png]");
    expect(prepared.instruction).toContain(
      "[attached images: a.png, b.png, c.png, d.png]",
    );
  });

  it("turns an unreadable image into a note and an ordinary path mention", async () => {
    const prepared = await prepareMentions("look at @broken.png", {
      exists,
      readImage: async () => ({ error: "EACCES: permission denied" }),
    });

    expect(prepared.images).toEqual([]);
    expect(prepared.notices).toEqual([
      "note: @broken.png was not attached — EACCES: permission denied.",
    ]);
    expect(prepared.instruction).toBe(
      "look at @broken.png\n\n[mentioned files: broken.png]",
    );
  });

  it("attaches by path when the reader carries no bytes", async () => {
    const readPath: MentionImageReader = async (relativePath) => ({
      path: `/repo/${relativePath}`,
    });
    const prepared = await prepareMentions("look at @shot.png and @notes.md", {
      exists,
      readImage: readPath,
    });

    // Nothing was read, but the mention is still *attached*: the REPL says the
    // same thing on every backend.
    expect(prepared.images).toEqual([]);
    expect(prepared.imagePaths).toEqual(["/repo/shot.png"]);
    expect(prepared.imageMentions).toEqual(["shot.png"]);
    expect(prepared.notices).toEqual([]);
    expect(prepared.instruction).toBe(
      "look at @shot.png and @notes.md\n\n" +
        "[mentioned files: notes.md]\n[attached images: shot.png]",
    );
  });

  it("applies the per-turn count to path attachments too", async () => {
    const mentions = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    const prepared = await prepareMentions(
      mentions.map((name) => `@${name}`).join(" "),
      {
        exists,
        readImage: async (relativePath) => ({ path: `/repo/${relativePath}` }),
      },
    );

    expect(prepared.imagePaths).toHaveLength(MAX_MENTION_IMAGES);
    expect(prepared.notices).toEqual([
      "note: @e.png was not attached — at most 4 images can ride with one message.",
    ]);
  });

  it("leaves images as paths, silently, when nothing can read them", async () => {
    const prepared = await prepareMentions("look at @shot.png", { exists });

    expect(prepared.images).toEqual([]);
    expect(prepared.imagePaths).toEqual([]);
    expect(prepared.notices).toEqual([]);
    // Still reported as an image mention, which is how the caller knows to say
    // that this backend cannot carry it.
    expect(prepared.imageMentions).toEqual(["shot.png"]);
    expect(prepared.instruction).toBe(
      "look at @shot.png\n\n[mentioned files: shot.png]",
    );
  });

  it("honors a lowered count limit", async () => {
    const prepared = await prepareMentions("@a.png @b.png", {
      exists,
      readImage,
      maxImages: 1,
    });
    expect(prepared.images).toHaveLength(1);
    expect(prepared.notices).toEqual([
      "note: @b.png was not attached — at most 1 image can ride with one message.",
    ]);
  });
});

describe("workspaceImageReader", () => {
  it("reads an image inside the workspace, with its absolute path", async () => {
    const root = await tempDir("kapel-mention-image-");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "shot.png"), pngBytes());

    const read = await workspaceImageReader(root)("docs/shot.png");
    expect("error" in read).toBe(false);
    if ("error" in read) return;
    expect(
      read.bytes === undefined ? undefined : Buffer.from(read.bytes),
    ).toEqual(pngBytes());
    expect(read.path).toBe(path.join(root, "docs", "shot.png"));
  });

  it("refuses a file over the per-image limit without reading it", async () => {
    const root = await tempDir("kapel-mention-big-");
    await writeFile(path.join(root, "big.png"), pngBytes("x".repeat(2048)));

    const read = await workspaceImageReader(root, 1024)("big.png");
    expect(read).toEqual({
      error: "it is 2.0 KiB, over the 1.0 KiB per-image limit",
    });
    expect(MAX_MENTION_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("refuses a directory, a missing file, and an escape upward", async () => {
    const root = await tempDir("kapel-mention-image-escape-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(path.dirname(root), "outside.png"), pngBytes());

    const reader = workspaceImageReader(root);
    expect(await reader("assets")).toEqual({ error: "it is not a file" });
    expect(await reader("../outside.png")).toEqual({
      error: "it is outside this workspace",
    });
    const missing = await reader("nope.png");
    expect("error" in missing && missing.error).toContain("ENOENT");
  });
});

describe("workspaceImagePathReader", () => {
  it("answers with the absolute path and reads no bytes", async () => {
    const root = await tempDir("kapel-mention-path-");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "shot.png"), pngBytes());

    const read = await workspaceImagePathReader(root)("docs/shot.png");
    expect(read).toEqual({ path: path.join(root, "docs", "shot.png") });
  });

  it("enforces the same limits as the byte reader", async () => {
    const root = await tempDir("kapel-mention-path-limits-");
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "big.png"), pngBytes("x".repeat(2048)));
    await writeFile(path.join(path.dirname(root), "outside.png"), pngBytes());

    const reader = workspaceImagePathReader(root, 1024);
    // The cap still applies even though nothing is embedded: `@huge.png`
    // behaves the same on a delegated backend as on the native one.
    expect(await reader("big.png")).toEqual({
      error: "it is 2.0 KiB, over the 1.0 KiB per-image limit",
    });
    expect(await reader("assets")).toEqual({ error: "it is not a file" });
    expect(await reader("../outside.png")).toEqual({
      error: "it is outside this workspace",
    });
    const missing = await reader("nope.png");
    expect("error" in missing && missing.error).toContain("ENOENT");
  });
});
