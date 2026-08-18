import type { ModelDefinition } from "../src/index.js";

/** Build a ReadableStream that emits the given strings as UTF-8 chunks. */
export function byteStream(
  chunks: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A 200 SSE response whose body streams the given chunks. */
export function sseResponse(chunks: readonly string[]): Response {
  return new Response(byteStream(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export const capabilities = {
  tools: true,
  reasoning: true,
  vision: true,
  structuredOutput: true,
} as const;

export const openaiModel: ModelDefinition = {
  provider: "openai",
  id: "gpt-test",
  capabilities,
};

export const anthropicModel: ModelDefinition = {
  provider: "anthropic",
  id: "claude-opus-5",
  maxOutputTokens: 8192,
  capabilities,
};

/** Parse the JSON body of the Nth recorded fetch call. */
export function requestBody(
  call: readonly unknown[] | undefined,
): Record<string, unknown> {
  if (call === undefined) throw new Error("fetch was not called");
  const init = call[1] as RequestInit | undefined;
  if (init === undefined || typeof init.body !== "string") {
    throw new Error("fetch call had no string body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

/** Headers of the Nth recorded fetch call. */
export function requestHeaders(
  call: readonly unknown[] | undefined,
): Record<string, string> {
  if (call === undefined) throw new Error("fetch was not called");
  const init = call[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}
