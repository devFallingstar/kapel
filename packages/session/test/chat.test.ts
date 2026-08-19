import type { ModelMessage } from "@agent/ai";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatSessionRecord,
  chatTitleFrom,
  type NewChatSession,
  type PersistedChatMessage,
  SqliteSessionStore,
} from "../src/index.js";
import { cleanupDbDirs, makePolicy, tempDbPath } from "./helpers.js";

afterAll(() => {
  cleanupDbDirs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CREATED_AT = 1_700_000_000_000;

function memoryStore(): SqliteSessionStore {
  return new SqliteSessionStore({ path: ":memory:" });
}

function chatSession(overrides: Partial<NewChatSession> = {}): NewChatSession {
  const { modelAlias, ...rest } = overrides;
  return {
    id: "chat-1",
    workspacePath: "/work/repo",
    title: "add persistence",
    createdAt: CREATED_AT,
    ...rest,
    ...(modelAlias === undefined ? {} : { modelAlias }),
  };
}

function turns(...contents: readonly string[]): PersistedChatMessage[] {
  return contents.map((content, index) => ({
    seq: index,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content,
    } satisfies ModelMessage,
  }));
}

/** Pins `Date.now` so `updatedAt` ordering is exact instead of clock-raced. */
function pinClock(...values: readonly number[]): void {
  let index = 0;
  vi.spyOn(Date, "now").mockImplementation(() => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  });
}

describe("chat session round-trip", () => {
  it("creates, lists and loads a session with its transcript", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession({ modelAlias: "sonnet" }));
    await store.appendChatMessages("chat-1", turns("hello", "hi there"));

    const listed = await store.listChatSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "chat-1",
      workspacePath: "/work/repo",
      title: "add persistence",
      modelAlias: "sonnet",
      createdAt: CREATED_AT,
      messageCount: 2,
    });
    expect(listed[0]?.updatedAt).toBeGreaterThanOrEqual(CREATED_AT);

    const loaded = await store.loadChatSession("chat-1");
    expect(loaded?.record.id).toBe("chat-1");
    expect(loaded?.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    store.close();
  });

  it("omits modelAlias when the session has none", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());

    const record = (await store.listChatSessions())[0] as ChatSessionRecord;
    expect("modelAlias" in record).toBe(false);
    expect((await store.loadChatSession("chat-1"))?.record.messageCount).toBe(
      0,
    );
    store.close();
  });

  it("survives a JSON round-trip of tool calls, tool results and errors", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());

    const transcript: readonly ModelMessage[] = [
      { role: "system", content: "you are kapel" },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "reading",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            input: { path: "src/index.ts", nested: { deep: [1, 2, 3] } },
          },
        ],
      },
      { role: "tool", content: "boom", toolCallId: "call-1", isError: true },
      { role: "tool", content: "ok", toolCallId: "call-2", isError: false },
    ];
    await store.appendChatMessages(
      "chat-1",
      transcript.map((message, seq) => ({ seq, message })),
    );

    const loaded = await store.loadChatSession("chat-1");
    expect(loaded?.messages).toEqual(transcript);
    expect(loaded?.record.messageCount).toBe(5);
    store.close();
  });

  it("returns undefined for an unknown session", async () => {
    const store = memoryStore();
    expect(await store.loadChatSession("nope")).toBeUndefined();
    store.close();
  });
});

describe("chat session listing", () => {
  it("orders by most recently touched, with appends acting as a touch", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession({ id: "a", createdAt: 1 }));
    await store.createChatSession(chatSession({ id: "b", createdAt: 2 }));
    await store.createChatSession(chatSession({ id: "c", createdAt: 3 }));
    expect((await store.listChatSessions()).map((s) => s.id)).toEqual([
      "c",
      "b",
      "a",
    ]);

    pinClock(50);
    await store.appendChatMessages("a", turns("still here"));
    const listed = await store.listChatSessions();
    expect(listed.map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(listed[0]?.updatedAt).toBe(50);
    store.close();
  });

  it("filters by workspace path verbatim", async () => {
    const store = memoryStore();
    await store.createChatSession(
      chatSession({ id: "a", workspacePath: "/work/repo" }),
    );
    await store.createChatSession(
      chatSession({ id: "b", workspacePath: "/work/other" }),
    );
    await store.createChatSession(
      chatSession({ id: "c", workspacePath: "/work/repo" }),
    );

    expect(
      (await store.listChatSessions("/work/repo")).map((s) => s.id).sort(),
    ).toEqual(["a", "c"]);
    expect(
      (await store.listChatSessions("/work/other")).map((s) => s.id),
    ).toEqual(["b"]);
    // No normalization happens in the store: a non-canonical spelling of the
    // same directory is simply a different key.
    expect(await store.listChatSessions("/work/repo/")).toEqual([]);
    expect(await store.listChatSessions("/work/missing")).toEqual([]);
    store.close();
  });

  it("honours a limit, and combines it with the workspace filter", async () => {
    const store = memoryStore();
    for (let index = 0; index < 5; index += 1) {
      await store.createChatSession(
        chatSession({
          id: `s${index}`,
          createdAt: 100 + index,
          workspacePath: index % 2 === 0 ? "/work/repo" : "/work/other",
        }),
      );
    }

    expect(
      (await store.listChatSessions(undefined, { limit: 2 })).map((s) => s.id),
    ).toEqual(["s4", "s3"]);
    expect(
      (await store.listChatSessions("/work/repo", { limit: 2 })).map(
        (s) => s.id,
      ),
    ).toEqual(["s4", "s2"]);
    expect(await store.listChatSessions(undefined, { limit: 0 })).toEqual([]);
    store.close();
  });
});

describe("chat message appends", () => {
  it("is idempotent when the same snapshot is re-saved", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());
    const snapshot = turns("one", "two", "three");

    await store.appendChatMessages("chat-1", snapshot);
    await store.appendChatMessages("chat-1", snapshot);

    const loaded = await store.loadChatSession("chat-1");
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.record.messageCount).toBe(3);
    store.close();
  });

  it("lets the last write win for a re-sent seq", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());
    await store.appendChatMessages("chat-1", turns("draft", "reply"));
    await store.appendChatMessages("chat-1", [
      { seq: 0, message: { role: "user", content: "final" } },
    ]);

    const loaded = await store.loadChatSession("chat-1");
    expect(loaded?.messages.map((m) => m.content)).toEqual(["final", "reply"]);
    expect(loaded?.record.messageCount).toBe(2);
    store.close();
  });

  it("counts incremental appends by highest seq", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());
    await store.appendChatMessages("chat-1", turns("a", "b", "c"));
    expect((await store.loadChatSession("chat-1"))?.record.messageCount).toBe(
      3,
    );

    await store.appendChatMessages("chat-1", [
      { seq: 3, message: { role: "assistant", content: "d" } },
      { seq: 4, message: { role: "user", content: "e" } },
      { seq: 5, message: { role: "assistant", content: "f" } },
    ]);

    const loaded = await store.loadChatSession("chat-1");
    expect(loaded?.record.messageCount).toBe(6);
    expect(loaded?.messages.map((m) => m.content)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    store.close();
  });

  it("treats an empty batch as a no-op", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());
    await store.appendChatMessages("chat-1", []);

    const record = (await store.listChatSessions())[0];
    expect(record?.messageCount).toBe(0);
    expect(record?.updatedAt).toBe(CREATED_AT);
    store.close();
  });

  it("skips a corrupt message row instead of failing the load", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    await store.createChatSession(chatSession());
    await store.appendChatMessages("chat-1", turns("first", "second", "third"));
    store.close();

    const raw = new Database(path);
    raw
      .prepare("UPDATE chat_messages SET message_json = ? WHERE seq = 1")
      .run("{not json");
    raw.close();

    const reopened = new SqliteSessionStore({ path });
    const loaded = await reopened.loadChatSession("chat-1");
    expect(loaded?.messages.map((m) => m.content)).toEqual(["first", "third"]);
    // The stored count still reflects what was written, corrupt row included.
    expect(loaded?.record.messageCount).toBe(3);
    reopened.close();
  });
});

describe("chat session mutation", () => {
  it("tolerates a duplicate create without clobbering the transcript", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession({ modelAlias: "sonnet" }));
    await store.appendChatMessages("chat-1", turns("hello"));

    await store.createChatSession(
      chatSession({ title: "different", modelAlias: "opus", createdAt: 42 }),
    );

    const loaded = await store.loadChatSession("chat-1");
    expect(loaded?.record).toMatchObject({
      title: "add persistence",
      modelAlias: "sonnet",
      createdAt: CREATED_AT,
      messageCount: 1,
    });
    expect(loaded?.messages).toHaveLength(1);
    expect(await store.listChatSessions()).toHaveLength(1);
    store.close();
  });

  it("renames a session and touches it", async () => {
    const store = memoryStore();
    await store.createChatSession(chatSession());
    pinClock(9_999);
    await store.setChatSessionTitle("chat-1", "renamed");

    const record = (await store.loadChatSession("chat-1"))?.record;
    expect(record?.title).toBe("renamed");
    expect(record?.updatedAt).toBe(9_999);

    // Renaming something that is not there is a silent no-op.
    await store.setChatSessionTitle("ghost", "nothing");
    expect(await store.listChatSessions()).toHaveLength(1);
    store.close();
  });

  it("deletes the record and its messages together", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    await store.createChatSession(chatSession());
    await store.createChatSession(chatSession({ id: "chat-2" }));
    await store.appendChatMessages("chat-1", turns("a", "b"));
    await store.appendChatMessages("chat-2", turns("c"));

    await store.deleteChatSession("chat-1");
    expect(await store.loadChatSession("chat-1")).toBeUndefined();
    expect((await store.listChatSessions()).map((s) => s.id)).toEqual([
      "chat-2",
    ]);
    // Deleting again is harmless.
    await store.deleteChatSession("chat-1");
    store.close();

    const raw = new Database(path);
    const rows = raw
      .prepare("SELECT session_id FROM chat_messages")
      .all() as readonly { session_id: string }[];
    expect(rows.map((row) => row.session_id)).toEqual(["chat-2"]);
    raw.close();
  });
});

describe("chat persistence across store instances", () => {
  it("keeps sessions and transcripts on disk between opens", async () => {
    const path = tempDbPath();
    const first = new SqliteSessionStore({ path });
    await first.createChatSession(chatSession({ modelAlias: "opus" }));
    await first.appendChatMessages("chat-1", turns("hello", "hi"));
    first.close();

    const second = new SqliteSessionStore({ path });
    const loaded = await second.loadChatSession("chat-1");
    expect(loaded?.record.modelAlias).toBe("opus");
    expect(loaded?.messages.map((m) => m.content)).toEqual(["hello", "hi"]);

    await second.appendChatMessages("chat-1", [
      { seq: 2, message: { role: "user", content: "again" } },
    ]);
    second.close();

    const third = new SqliteSessionStore({ path });
    expect((await third.loadChatSession("chat-1"))?.record.messageCount).toBe(
      3,
    );
    third.close();
  });

  it("re-runs the chat DDL against a populated file without error", async () => {
    const path = tempDbPath();
    const first = new SqliteSessionStore({ path });
    await first.createChatSession(chatSession());
    first.close();

    // Third open proves the CREATE ... IF NOT EXISTS bootstrap stays a no-op
    // no matter how often a workspace is reopened.
    const second = new SqliteSessionStore({ path });
    second.close();
    const third = new SqliteSessionStore({ path });
    expect((await third.listChatSessions()).map((s) => s.id)).toEqual([
      "chat-1",
    ]);
    third.close();
  });

  it("shares one database file with runs and events", async () => {
    const path = tempDbPath();
    const store = new SqliteSessionStore({ path });
    await store.createRun({
      id: "run-1",
      objective: "ship the thing",
      createdAt: CREATED_AT,
      policySnapshot: makePolicy(),
    });
    await store.createChatSession(chatSession());
    store.close();

    const raw = new Database(path);
    const tables = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as readonly { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "runs",
        "events",
        "task_results",
        "chat_sessions",
        "chat_messages",
      ]),
    );
    raw.close();

    const reopened = new SqliteSessionStore({ path });
    expect((await reopened.getRun("run-1"))?.objective).toBe("ship the thing");
    expect(await reopened.listChatSessions()).toHaveLength(1);
    reopened.close();
  });
});

describe("chatTitleFrom", () => {
  it("takes the trimmed first line", () => {
    expect(chatTitleFrom("  add chat persistence  \nand more\nlines")).toBe(
      "add chat persistence",
    );
    expect(chatTitleFrom("single line")).toBe("single line");
  });

  it("truncates long lines to 60 characters including the ellipsis", () => {
    const title = chatTitleFrom("x".repeat(120));
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);

    const exact = "y".repeat(60);
    expect(chatTitleFrom(exact)).toBe(exact);
    expect(chatTitleFrom("z".repeat(61))).toHaveLength(60);
  });

  it("handles empty and whitespace-only instructions", () => {
    expect(chatTitleFrom("")).toBe("");
    expect(chatTitleFrom("\n\nsecond line")).toBe("");
    expect(chatTitleFrom("   \n x")).toBe("");
  });
});
