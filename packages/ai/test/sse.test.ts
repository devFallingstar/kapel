import { describe, expect, it } from "vitest";
import type { SseMessage } from "../src/index.js";
import { parseSse } from "../src/index.js";
import { byteStream } from "./helpers.js";

async function collect(
  chunks: readonly string[],
  signal?: AbortSignal,
): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSse(byteStream(chunks), signal))
    out.push(message);
  return out;
}

describe("parseSse", () => {
  it("parses a simple event/data pair", async () => {
    const messages = await collect(['event: ping\ndata: {"a":1}\n\n']);
    expect(messages).toEqual([{ event: "ping", data: '{"a":1}' }]);
  });

  it("reassembles lines split across chunk boundaries", async () => {
    const messages = await collect([
      "event: mes",
      "sage_start\nda",
      'ta: {"ty',
      'pe":"x"}\n',
      "\ndata: second\n\n",
    ]);
    expect(messages).toEqual([
      { event: "message_start", data: '{"type":"x"}' },
      { event: undefined, data: "second" },
    ]);
  });

  it("joins multi-line data fields with newlines", async () => {
    const messages = await collect([
      "data: line one\ndata: line two\ndata: line three\n\n",
    ]);
    expect(messages).toEqual([
      { event: undefined, data: "line one\nline two\nline three" },
    ]);
  });

  it("handles CRLF line endings, including across chunk boundaries", async () => {
    const messages = await collect([
      "event: tick\r\ndata: a\r",
      "\ndata: b\r\n\r\n",
      "data: c\r\n\r\n",
    ]);
    expect(messages).toEqual([
      { event: "tick", data: "a\nb" },
      { event: undefined, data: "c" },
    ]);
  });

  it("ignores comment lines and empty blocks", async () => {
    const messages = await collect([
      ": keep-alive\n\n",
      "data: real\n\n",
      "\n\n",
    ]);
    expect(messages).toEqual([{ event: undefined, data: "real" }]);
  });

  it("flushes a trailing message that has no terminating blank line", async () => {
    const messages = await collect(["data: tail"]);
    expect(messages).toEqual([{ event: undefined, data: "tail" }]);
  });

  it("treats a bare `data` field as an empty line and strips only one leading space", async () => {
    const messages = await collect(["data\ndata:  padded\n\n"]);
    expect(messages).toEqual([{ event: undefined, data: "\n padded" }]);
  });

  it("passes the [DONE] sentinel through to the caller", async () => {
    const messages = await collect(["data: [DONE]\n\n"]);
    expect(messages).toEqual([{ event: undefined, data: "[DONE]" }]);
  });

  it("terminates iteration when the signal aborts", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const message of parseSse(
      byteStream(["data: one\n\n", "data: two\n\n", "data: three\n\n"]),
      controller.signal,
    )) {
      seen.push(message.data);
      if (seen.length === 1) controller.abort();
    }
    expect(seen).toEqual(["one"]);
  });

  it("yields nothing when aborted before the first read", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await collect(["data: one\n\n"], controller.signal)).toEqual([]);
  });
});
