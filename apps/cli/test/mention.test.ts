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
  MAX_WALK_DEPTH,
  mentionAnnotation,
  mentionTokenAt,
  rankMentionMatches,
  resolveMentions,
  workspaceFileExists,
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
  });
});
