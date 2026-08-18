/** One dispatched Server-Sent Events message. */
export interface SseMessage {
  /** The `event:` field, when the server sent one. */
  readonly event?: string | undefined;
  /** The joined `data:` field(s); multi-line data is joined with `\n`. */
  readonly data: string;
}

/**
 * Parse an SSE byte stream into messages.
 *
 * Handles CRLF and LF line endings, comment lines, multi-line `data:` fields
 * and chunk boundaries that split a line in half. The `[DONE]` sentinel used by
 * some providers is *not* interpreted here — callers decide what it means.
 *
 * Iteration ends cleanly when `signal` aborts.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const takePending = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const message: SseMessage = {
      event: eventName,
      data: dataLines.join("\n"),
    };
    eventName = undefined;
    dataLines = [];
    return message;
  };

  const consumeLine = (rawLine: string): SseMessage | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return takePending();
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    return undefined;
  };

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = consumeLine(rawLine);
        if (message !== undefined) yield message;
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer !== "") {
      const message = consumeLine(buffer);
      if (message !== undefined) yield message;
      buffer = "";
    }
    const trailing = takePending();
    if (trailing !== undefined) yield trailing;
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored; nothing to clean up.
    }
  }
}
