import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHistoryAppender,
  HISTORY_LIMIT,
  historyFilePath,
  loadHistory,
} from "../src/history.js";

let dir: string;
let env: NodeJS.ProcessEnv;

/** Polls a condition until it holds, for waiting out the appender's serialized write chain. */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil: condition never became true");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kapel-history-"));
  env = { KAPEL_CONFIG_DIR: dir };
});

afterEach(async () => {
  // A second attempt covers any straggling write finishing mid-removal.
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- historyFilePath ---------------------------------------------------------

describe("historyFilePath", () => {
  it("lives under the kapel config dir", () => {
    expect(historyFilePath(env)).toBe(path.join(dir, "history"));
  });
});

// --- loadHistory --------------------------------------------------------------

describe("loadHistory", () => {
  it("returns [] when the file doesn't exist", async () => {
    await expect(loadHistory(env)).resolves.toEqual([]);
  });

  it("round-trips an appended entry, newest first", async () => {
    const append = createHistoryAppender(env);
    append("first");
    append("second");
    append("third");
    // Let the serialized append chain settle.
    await waitUntil(async () => (await loadHistory(env)).length === 3);

    await expect(loadHistory(env)).resolves.toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("skips blank lines", async () => {
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(dir, { recursive: true }).then(() =>
        writeFile(historyFilePath(env), "a\n\nb\n\n\nc\n"),
      ),
    );
    await expect(loadHistory(env)).resolves.toEqual(["c", "b", "a"]);
  });

  it("caps the returned list at HISTORY_LIMIT", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const lines = Array.from(
      { length: HISTORY_LIMIT + 50 },
      (_, i) => `entry-${i}`,
    );
    await writeFile(historyFilePath(env), `${lines.join("\n")}\n`);

    const loaded = await loadHistory(env);
    expect(loaded.length).toBe(HISTORY_LIMIT);
    // Newest-first: the last line written is the first entry returned.
    expect(loaded[0]).toBe(`entry-${HISTORY_LIMIT + 49}`);
  });
});

// --- createHistoryAppender ----------------------------------------------------

describe("createHistoryAppender", () => {
  it("creates the config dir on first append", async () => {
    const append = createHistoryAppender(env);
    append("hello");
    await waitUntil(async () => {
      try {
        return (await readFile(historyFilePath(env), "utf8")).includes("hello");
      } catch {
        return false;
      }
    });

    const raw = await readFile(historyFilePath(env), "utf8");
    expect(raw).toBe("hello\n");
  });

  it("skips only consecutive duplicates", async () => {
    const append = createHistoryAppender(env);
    append("a");
    append("a");
    append("b");
    append("a");
    await waitUntil(async () => (await loadHistory(env)).length === 3);

    await expect(loadHistory(env)).resolves.toEqual(["a", "b", "a"]);
  });

  it("never throws even if given odd input", async () => {
    const append = createHistoryAppender(env);
    expect(() => append("")).not.toThrow();
    expect(() => append("normal")).not.toThrow();
    // Wait out the serialized write chain so afterEach's directory removal
    // can't race a write still in flight (ENOTEMPTY on rmdir).
    await waitUntil(async () => {
      try {
        return (await readFile(historyFilePath(env), "utf8")).includes(
          "normal",
        );
      } catch {
        return false;
      }
    });
  });

  it("trims the file back to HISTORY_LIMIT once it exceeds 2x the limit", async () => {
    const append = createHistoryAppender(env);
    const total = HISTORY_LIMIT * 2 + 1;
    for (let i = 0; i < total; i += 1) {
      append(`e${i}`);
    }
    // Let the whole serialized chain of appends (and the trim it triggers)
    // settle — poll rather than a fixed sleep since the chain length here
    // is a couple thousand writes.
    await waitUntil(async () => {
      try {
        const raw = await readFile(historyFilePath(env), "utf8");
        return raw.includes(`e${total - 1}`);
      } catch {
        return false;
      }
    });

    const raw = await readFile(historyFilePath(env), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(HISTORY_LIMIT);

    const loaded = await loadHistory(env);
    expect(loaded.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    // The newest entry survives the trim.
    expect(loaded[0]).toBe(`e${total - 1}`);
  });
});
