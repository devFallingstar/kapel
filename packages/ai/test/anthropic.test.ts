import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelRequest, ToolChoice } from "../src/index.js";
import { AnthropicProvider, ProviderError } from "../src/index.js";
import {
  anthropicModel,
  requestBody,
  requestHeaders,
  sseResponse,
} from "./helpers.js";

const TEXT_TURN = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":' +
    '{"input_tokens":210,"output_tokens":1,"cache_read_input_tokens":180}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
    '"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
    '"delta":{"type":"text_delta","text":"Bon"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
    '"delta":{"type":"text_delta","text":"jour"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},' +
    '"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const TOOL_TURN = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":' +
    '{"input_tokens":50,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
    '"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
    '"delta":{"type":"text_delta","text":"Let me check."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,' +
    '"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,' +
    '"delta":{"type":"input_json_delta","partial_json":"{\\"loca"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,' +
    '"delta":{"type":"input_json_delta","partial_json":"tion\\":\\"Paris\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,' +
    '"content_block":{"type":"tool_use","id":"toolu_2","name":"now","input":{}}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},' +
    '"usage":{"output_tokens":64}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function stubFetch(chunks: readonly string[]) {
  const mock = vi.fn(() => Promise.resolve(sseResponse(chunks)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function provider(baseUrl?: string): AnthropicProvider {
  return new AnthropicProvider(
    baseUrl === undefined
      ? { apiKey: "k-test" }
      : { apiKey: "k-test", baseUrl },
  );
}

function oauthProvider(baseUrl?: string): AnthropicProvider {
  return new AnthropicProvider(
    baseUrl === undefined
      ? { authToken: "t-test" }
      : { authToken: "t-test", baseUrl },
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
  model: anthropicModel,
  messages: [{ role: "user", content: "hi" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnthropicProvider", () => {
  it("identifies itself and claims only anthropic models", () => {
    const p = provider();
    expect(p.id).toBe("anthropic");
    expect(p.supports(anthropicModel)).toBe(true);
    expect(p.supports({ ...anthropicModel, provider: "openai" })).toBe(false);
  });

  it("throws when constructed with neither apiKey nor authToken", () => {
    expect(() => new AnthropicProvider({})).toThrow(
      /pass either `apiKey` or `authToken`/,
    );
  });

  it("throws when constructed with both apiKey and authToken", () => {
    expect(
      () => new AnthropicProvider({ apiKey: "k", authToken: "t" }),
    ).toThrow(/pass either `apiKey` or `authToken`, not both/);
  });

  it("sends x-api-key and no Authorization header in apiKey mode", async () => {
    const mock = stubFetch(TEXT_TURN);
    await drain(provider().stream(simpleRequest));
    const headers = requestHeaders(
      mock.mock.calls[0] as unknown as readonly unknown[],
    );
    expect(headers["x-api-key"]).toBe("k-test");
    expect(headers.authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("sends a Bearer Authorization header and the OAuth beta flag, and no x-api-key, in authToken mode", async () => {
    const mock = stubFetch(TEXT_TURN);
    await drain(oauthProvider().stream(simpleRequest));
    const headers = requestHeaders(
      mock.mock.calls[0] as unknown as readonly unknown[],
    );
    expect(headers.authorization).toBe("Bearer t-test");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("emits text deltas, one consolidated usage event and done", async () => {
    stubFetch(TEXT_TURN);
    const events = await drain(provider().stream(simpleRequest));
    expect(events).toEqual([
      { type: "text.delta", text: "Bon" },
      { type: "text.delta", text: "jour" },
      {
        type: "usage",
        inputTokens: 210,
        outputTokens: 9,
        cachedInputTokens: 180,
      },
      { type: "done", finishReason: "end_turn" },
    ]);
  });

  it("accumulates input_json_delta chunks and defaults empty tool input to {}", async () => {
    stubFetch(TOOL_TURN);
    const events = await drain(provider().stream(simpleRequest));
    expect(events).toEqual([
      { type: "text.delta", text: "Let me check." },
      {
        type: "tool.call",
        id: "toolu_1",
        name: "get_weather",
        input: { location: "Paris" },
      },
      { type: "tool.call", id: "toolu_2", name: "now", input: {} },
      { type: "usage", inputTokens: 50, outputTokens: 64 },
      { type: "done", finishReason: "tool_use" },
    ]);
  });

  it("maps system, tool results and tool definitions onto the Messages body", async () => {
    const mock = stubFetch(TEXT_TURN);
    const request: ModelRequest = {
      model: anthropicModel,
      messages: [
        { role: "system", content: "be terse" },
        { role: "system", content: "cite sources" },
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "Checking.",
          toolCalls: [
            {
              id: "toolu_1",
              name: "get_weather",
              input: { location: "Paris" },
            },
          ],
        },
        { role: "tool", content: "boom", toolCallId: "toolu_1", isError: true },
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
    };
    await drain(provider().stream(request));

    const call = mock.mock.calls[0] as unknown as readonly unknown[];
    expect(call[0]).toBe("https://api.anthropic.com/v1/messages");
    const headers = requestHeaders(call);
    expect(headers["x-api-key"]).toBe("k-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    expect(requestBody(call)).toEqual({
      model: "claude-opus-5",
      max_tokens: 8192,
      stream: true,
      system: "be terse\n\ncite sources",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { location: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "boom",
              is_error: true,
            },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      ],
    });
  });

  it("maps every tool_choice variant, and omits tool_choice when unset", async () => {
    const cases: readonly (readonly [ToolChoice, unknown])[] = [
      [{ type: "auto" }, { type: "auto" }],
      [{ type: "any" }, { type: "any" }],
      [
        { type: "tool", name: "emit_policy" },
        { type: "tool", name: "emit_policy" },
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

  it("prefers request.maxOutputTokens, then model.maxOutputTokens, then a default", async () => {
    const withRequest = stubFetch(TEXT_TURN);
    await drain(provider().stream({ ...simpleRequest, maxOutputTokens: 111 }));
    expect(
      requestBody(withRequest.mock.calls[0] as unknown as readonly unknown[])
        .max_tokens,
    ).toBe(111);
    vi.unstubAllGlobals();

    const fromModel = stubFetch(TEXT_TURN);
    await drain(provider().stream(simpleRequest));
    expect(
      requestBody(fromModel.mock.calls[0] as unknown as readonly unknown[])
        .max_tokens,
    ).toBe(8192);
    vi.unstubAllGlobals();

    const fallback = stubFetch(TEXT_TURN);
    const bare = { ...anthropicModel };
    delete (bare as { maxOutputTokens?: number }).maxOutputTokens;
    await drain(
      provider().stream({ model: bare, messages: simpleRequest.messages }),
    );
    expect(
      requestBody(fallback.mock.calls[0] as unknown as readonly unknown[])
        .max_tokens,
    ).toBe(4096);
  });

  it("honours a custom baseUrl", async () => {
    const mock = stubFetch(TEXT_TURN);
    await drain(
      provider("https://gateway.internal/anthropic/").stream(simpleRequest),
    );
    expect(mock.mock.calls[0]?.[0]).toBe(
      "https://gateway.internal/anthropic/v1/messages",
    );
  });

  it("throws a ProviderError on a non-2xx response", async () => {
    const mock = vi.fn(() =>
      Promise.resolve(
        new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
          status: 529,
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);

    const error = await drain(provider().stream(simpleRequest)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.provider).toBe("anthropic");
    expect(providerError.status).toBe(529);
    expect(providerError.body).toBe(
      '{"type":"error","error":{"type":"overloaded_error"}}',
    );
  });

  it("throws a ProviderError when the stream carries an error event", async () => {
    stubFetch([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":' +
        '{"input_tokens":1,"output_tokens":1}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error",' +
        '"message":"Overloaded"}}\n\n',
    ]);
    const error = await drain(provider().stream(simpleRequest)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe("Overloaded");
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
    expect(events).toEqual([{ type: "text.delta", text: "Let me check." }]);
  });
});
