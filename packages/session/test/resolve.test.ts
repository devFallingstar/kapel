import { describe, expect, it } from "vitest";
import type { ChatSessionRecord } from "../src/index.js";
import { resolveChatSessionReference } from "../src/index.js";

/**
 * `resolveChatSessionReference` expects newest-first ordering (what
 * `listChatSessions` returns) — the fixtures below are built in that order so
 * "most recent wins" reads correctly off array position.
 */
function record(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspacePath: "/work/repo",
    title: "untitled",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    ...overrides,
  };
}

describe("resolveChatSessionReference", () => {
  it("matches an exact id", () => {
    const records = [
      record({ id: "abc123", title: "a" }),
      record({ id: "def456", title: "b" }),
    ];
    const result = resolveChatSessionReference(records, "def456");
    expect("record" in result && result.record.title).toBe("b");
  });

  it("matches a unique id prefix", () => {
    const records = [record({ id: "abcdef00" }), record({ id: "112233" })];
    const result = resolveChatSessionReference(records, "abcd");
    expect("record" in result && result.record.id).toBe("abcdef00");
  });

  it("errors on an ambiguous id prefix, listing the short ids", () => {
    const records = [record({ id: "abc111" }), record({ id: "abc222" })];
    const result = resolveChatSessionReference(records, "abc");
    expect("error" in result).toBe(true);
    expect("error" in result && result.error).toMatch(/matches 2 sessions/);
    expect("error" in result && result.error).toMatch(/abc111/);
    expect("error" in result && result.error).toMatch(/abc222/);
  });

  it("matches an exact name when no id matches", () => {
    const records = [
      record({ id: "abc111", name: "other" }),
      record({ id: "def222", name: "release notes" }),
    ];
    const result = resolveChatSessionReference(records, "release notes");
    expect("record" in result && result.record.id).toBe("def222");
  });

  it("prefers an id-prefix match over a same-string name match", () => {
    // "abc" is both session B's exact name and session A's id prefix; the id
    // wins, per the ambiguity carve-out.
    const records = [
      record({ id: "abc111", name: "unrelated" }),
      record({ id: "zzz999", name: "abc" }),
    ];
    const result = resolveChatSessionReference(records, "abc");
    expect("record" in result && result.record.id).toBe("abc111");
  });

  it("picks the most recently updated session when names collide, and notes it", () => {
    // Newest-first, as listChatSessions would return them.
    const records = [
      record({ id: "newer", name: "shared", updatedAt: 200 }),
      record({ id: "older", name: "shared", updatedAt: 100 }),
    ];
    const notes: string[] = [];
    const result = resolveChatSessionReference(records, "shared", {
      onNote: (note) => notes.push(note),
    });
    expect("record" in result && result.record.id).toBe("newer");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Multiple sessions/);
    expect(notes[0]).toMatch(/newer/);
  });

  it("does not call onNote when a name is unique", () => {
    const records = [record({ id: "abc111", name: "solo" })];
    const notes: string[] = [];
    resolveChatSessionReference(records, "solo", {
      onNote: (note) => notes.push(note),
    });
    expect(notes).toEqual([]);
  });

  it("errors with a hint when nothing matches", () => {
    const records = [record({ id: "abc111" }), record({ id: "def222" })];
    const result = resolveChatSessionReference(records, "nope");
    expect("error" in result).toBe(true);
    expect("error" in result && result.error).toMatch(
      /No chat session matches "nope"/,
    );
    expect("error" in result && result.error).toMatch(/Available:/);
  });

  it("gives a hint-free error for an empty session list", () => {
    const result = resolveChatSessionReference([], "anything");
    expect("error" in result && result.error).toBe(
      'No chat session matches "anything".',
    );
  });

  it("does not match a name against a session that has none", () => {
    const records = [record({ id: "abc111" })];
    const result = resolveChatSessionReference(records, "abc111-name");
    expect("error" in result).toBe(true);
  });
});
