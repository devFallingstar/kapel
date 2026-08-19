import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelRequest, ToolChoice } from "../src/index.js";
import { OpenAIProvider, ProviderError } from "../src/index.js";
import {
  openaiModel,
  requestBody,
  requestHeaders,
  sseResponse,
} from "./helpers.js";

const TEXT_TURN = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,' +
    '"prompt_tokens_details":{"cached_tokens":96}}}\n\n',
  "data: [DONE]\n\n",
];

const TOOL_TURN = [
  'data: {"choices":[{"index":0,"delta":{"content":"Checking."}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
    '"type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,' +
    '"function":{"arguments":"{\\"loc"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,' +
    '"function":{"arguments":"ation\\":\\"Paris\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2",' +
    '"type":"function","function":{"name":"broken","arguments":"not json"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":20}}\n\n',
  "data: [DONE]\n\n",
];

function stubFetch(chunks: readonly string[]) {
  const mock = vi.fn(() => Promise.resolve(sseResponse(chunks)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function provider(baseUrl?: string): OpenAIProvider {
  return new OpenAIProvider(
    baseUrl === undefined
      ? { apiKey: "sk-test" }
      : { apiKey: "sk-test", baseUrl },
  );
}

async function drain(
  iterable: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const simpleRequest: ModelRequest = {
  model: openaiModel,
  messages: [{ role: "user", content: "hi" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIProvider", () => {
  it("identifies itself and claims openai + openai-compatible models", () => {
    const p = provider();
    expect(p.id).toBe("openai");
    expect(p.supports(openaiModel)).toBe(true);
    expect(p.supports({ ...openaiModel, provider: "openai-compatible" })).toBe(
      true,
    );
    expect(p.supports({ ...openaiModel, provider: "anthropic" })).toBe(false);
  });

  it("emits text deltas, usage and done for a plain text turn", async () => {
    stubFetch(TEXT_TURN);
    const events = await drain(provider().stream(simpleRequest));
    expect(events).toEqual([
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      {
        type: "usage",
        inputTokens: 120,
        outputTokens: 7,
        cachedInputTokens: 96,
      },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("omits cachedInputTokens when the provider reports none", async () => {
    stubFetch([
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"length"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await drain(provider().stream(simpleRequest));
    expect(events).toEqual([
      { type: "text.delta", text: "x" },
      { type: "usage", inputTokens: 3, outputTokens: 1 },
      { type: "done", finishReason: "length" },
    ]);
  });

  it("accumulates chunked tool-call arguments and emits one event per call", async () => {
    stubFetch(TOOL_TURN);
    const events = await drain(provider().stream(simpleRequest));
    expect(events).toEqual([
      { type: "text.delta", text: "Checking." },
      {
        type: "tool.call",
        id: "call_1",
        name: "get_weather",
        input: { location: "Paris" },
      },
      { type: "tool.call", id: "call_2", name: "broken", input: "not json" },
      { type: "usage", inputTokens: 40, outputTokens: 20 },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });

  it("still emits tool calls when the stream ends without a finish_reason", async () => {
    stubFetch([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x",' +
        '"type":"function","function":{"name":"noop","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await drain(provider().stream(simpleRequest));
    expect(events).toEqual([
      { type: "tool.call", id: "call_x", name: "noop", input: {} },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("maps messages, tools and sampling params onto the Chat Completions body", async () => {
    const mock = stubFetch(TEXT_TURN);
    const request: ModelRequest = {
      model: openaiModel,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "get_weather", input: { location: "Paris" } },
          ],
        },
        { role: "tool", content: "18C", toolCallId: "call_1" },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather",
          inputSchema: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      ],
      temperature: 0.25,
      maxOutputTokens: 512,
    };
    await drain(provider().stream(request));

    const call = mock.mock.calls[0] as unknown as readonly unknown[];
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(requestHeaders(call).authorization).toBe("Bearer sk-test");

    expect(requestBody(call)).toEqual({
      model: "gpt-test",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.25,
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        { role: "tool", content: "18C", tool_call_id: "call_1" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
    });
  });

  it("serializes image parts as data: image_url blocks, text first", async () => {
    const mock = stubFetch(TEXT_TURN);
    const request: ModelRequest = {
      model: openaiModel,
      messages: [
        {
          role: "user",
          content: "what is in this screenshot?",
          images: [{ mediaType: "image/png", base64: "cG5nLWJ5dGVz" }],
        },
      ],
    };
    await drain(provider().stream(request));

    const body = requestBody(
      mock.mock.calls[0] as unknown as readonly unknown[],
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this screenshot?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,cG5nLWJ5dGVz" },
          },
        ],
      },
    ]);
  });

  it("sends a plain string user message when there are no images (unchanged behavior)", async () => {
    const mock = stubFetch(TEXT_TURN);
    await drain(provider().stream(simpleRequest));
    const body = requestBody(
      mock.mock.calls[0] as unknown as readonly unknown[],
    );
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps every tool_choice variant, and omits tool_choice when unset", async () => {
    const cases: readonly (readonly [ToolChoice, unknown])[] = [
      [{ type: "auto" }, "auto"],
      [{ type: "any" }, "required"],
      [
        { type: "tool", name: "emit_policy" },
        { type: "function", function: { name: "emit_policy" } },
      ],
    ];

    for (const [toolChoice, wire] of cases) {
      const mock = stubFetch(TEXT_TURN);
      await drain(provider().stream({ ...simpleRequest, toolChoice }));
      const body = requestBody(
        mock.mock.calls[0] as unknown as readonly unknown[],
      );
      expect(body.tool_choice).toEqual(wire);
      vi.unstubAllGlobals();
    }

    const unset = stubFetch(TEXT_TURN);
    await drain(provider().stream(simpleRequest));
    expect(
      requestBody(unset.mock.calls[0] as unknown as readonly unknown[]),
    ).not.toHaveProperty("tool_choice");
  });

  it("honours a custom baseUrl for OpenAI-compatible servers", async () => {
    const mock = stubFetch(TEXT_TURN);
    await drain(provider("http://localhost:1234/v1/").stream(simpleRequest));
    expect(mock.mock.calls[0]?.[0]).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
  });

  it("throws a ProviderError on a non-2xx response", async () => {
    const mock = vi.fn(() =>
      Promise.resolve(
        new Response('{"error":{"message":"nope"}}', { status: 429 }),
      ),
    );
    vi.stubGlobal("fetch", mock);

    const error = await drain(provider().stream(simpleRequest)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.provider).toBe("openai");
    expect(providerError.status).toBe(429);
    expect(providerError.body).toBe('{"error":{"message":"nope"}}');
  });

  it("stops iteration when the signal aborts mid-stream", async () => {
    stubFetch(TOOL_TURN);
    const controller = new AbortController();
    const events: ModelEvent[] = [];
    for await (const event of provider().stream(
      simpleRequest,
      controller.signal,
    )) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([{ type: "text.delta", text: "Checking." }]);
  });
});
