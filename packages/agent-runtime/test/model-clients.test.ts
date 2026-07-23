import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AnthropicMessagesClient,
  ModelHttpError,
  OpenAIChatClient,
  consumeAnthropicStream,
  consumeOpenAIStream,
  createModelClient,
  type ModelRequest,
} from "../src/index.js";

const request: ModelRequest = {
  model: "fixture",
  systemPrompt: "system",
  messages: [{ role: "user", content: "hello" }],
  tools: [
    {
      name: "read",
      label: "Read",
      description: "read",
      parameters: { type: "object" },
      effect: "read",
    },
  ],
  temperature: 0,
  maxOutputTokens: 100,
};

describe("streaming model clients", () => {
  it("assembles OpenAI text, reasoning, fragmented tool arguments and usage", async () => {
    const stream = sse([
      { choices: [{ delta: { content: "Hi", reasoning_content: "think" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_", function: { name: "re", arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [{ index: 0, id: "1", function: { name: "ad", arguments: '"a.ts"}' } }],
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ]);
    const events: string[] = [];
    const response = await consumeOpenAIStream(stream, (event) => events.push(event.type));
    expect(response).toMatchObject({
      content: "Hi",
      reasoning: "think",
      stopReason: "tool_use",
      toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }],
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 },
    });
    expect(events).toContain("tool_call_delta");
  });

  it("assembles Anthropic content blocks and usage", async () => {
    const stream = sse([
      { type: "message_start", message: { usage: { input_tokens: 9 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "inspect first" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed-state" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 },
      },
    ]);
    const response = await consumeAnthropicStream(stream, () => undefined);
    expect(response.toolCalls).toMatchObject([
      { id: "tool_1", name: "read", arguments: { path: "a.ts" } },
    ]);
    expect(response.providerState?.thinkingBlocks).toEqual([
      { type: "thinking", thinking: "inspect first", signature: "signed-state" },
    ]);
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("enables and replays complete Anthropic thinking blocks for MiniMax-style profiles", async () => {
    let captured: Record<string, unknown> = {};
    let capturedUrl = "";
    const client = new AnthropicMessagesClient({
      baseUrl: "https://api.minimax.example/anthropic",
      authType: "bearer",
      apiKey: "fixture",
      compatibility: { anthropicThinking: "adaptive" },
      fetchImplementation: async (url, init) => {
        capturedUrl = String(url);
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          content: [
            { type: "thinking", thinking: "next thought", signature: "next-signature" },
            { type: "text", text: "done" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      },
    });
    const response = await client.complete({
      ...request,
      reasoningEffort: "high",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.ts" } }],
          providerState: {
            thinkingBlocks: [
              { type: "thinking", thinking: "prior thought", signature: "prior-signature" },
            ],
          },
        },
        { role: "tool", content: "ok", toolCallId: "c1", toolName: "read" },
      ],
    });
    expect(captured).toMatchObject({ thinking: { type: "adaptive" } });
    expect(capturedUrl).toBe("https://api.minimax.example/anthropic/v1/messages");
    expect(JSON.stringify(captured)).toContain("prior-signature");
    expect(response).toMatchObject({
      content: "done",
      reasoning: "next thought",
      providerState: {
        thinkingBlocks: [
          { type: "thinking", thinking: "next thought", signature: "next-signature" },
        ],
      },
    });
  });

  it("maps JSON fallbacks and provider errors", async () => {
    let capturedBody = "";
    const openai = new OpenAIChatClient({
      baseUrl: "http://fixture/v1",
      apiKey: "secret",
      fetchImplementation: async (_url, init) => {
        capturedBody = String(init?.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "done" } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(await openai.complete(request)).toMatchObject({ content: "done", stopReason: "stop" });
    expect(JSON.parse(capturedBody)).toMatchObject({ model: "fixture", stream: true });

    const anthropic = new AnthropicMessagesClient({
      baseUrl: "http://fixture/v1",
      fetchImplementation: async () =>
        new Response("bad", { status: 429, headers: { "content-type": "text/plain" } }),
    });
    await expect(anthropic.complete(request)).rejects.toBeInstanceOf(ModelHttpError);
    expect(createModelClient({ protocol: "openai-chat", baseUrl: "x" }).protocol).toBe(
      "openai-chat",
    );
  });

  it("applies provider-specific reasoning, replay and tool compatibility", async () => {
    let captured: Record<string, unknown> = {};
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      compatibility: {
        thinkingFormat: "zai",
        supportsReasoningEffort: true,
        supportsParallelToolCalls: false,
        supportsStreamUsage: false,
        requiresReasoningContentOnAssistantMessages: true,
        requiresAssistantContentForToolCalls: true,
        requiresToolResultName: true,
        zaiToolStream: true,
        maxTokensField: "max_completion_tokens",
        reasoningEffortMap: { high: "max" },
      },
      fetchImplementation: async (_url, init) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "done", reasoning_content: "private state" },
            },
          ],
        });
      },
    });
    const response = await client.complete({
      ...request,
      reasoningEffort: "high",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }],
          providerState: { reasoningContent: "prior reasoning" },
        },
        { role: "tool", content: "ok", toolCallId: "c1", toolName: "read" },
      ],
    });
    expect(captured).toMatchObject({
      max_completion_tokens: 100,
      tool_stream: true,
      reasoning_effort: "max",
      thinking: { type: "enabled", clear_thinking: false },
    });
    expect(captured).not.toHaveProperty("parallel_tool_calls");
    expect(captured).not.toHaveProperty("stream_options");
    expect(JSON.stringify(captured)).toContain("prior reasoning");
    expect(JSON.stringify(captured)).toContain('"content":""');
    expect(JSON.stringify(captured)).toContain('"name":"read"');
    expect(response.reasoning).toBe("private state");
  });

  it("retries throttled requests according to the profile policy", async () => {
    let requests = 0;
    const events: string[] = [];
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      reliability: {
        timeoutMs: 2_000,
        maxRetries: 1,
        retryBaseDelayMs: 10,
        retryMaximumDelayMs: 10,
      },
      fetchImplementation: async () => {
        requests += 1;
        return requests === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
          : Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
      },
    });
    const response = await client.complete(request, (event) => events.push(event.type));
    expect(response.content).toBe("ok");
    expect(requests).toBe(2);
    expect(events).toContain("model_retry");
  });
});

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      const midpoint = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, midpoint)));
      controller.enqueue(encoder.encode(text.slice(midpoint)));
      controller.close();
    },
  });
}

const chunkSizes = fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 80 });

function sseChunked(events: unknown[], sizes: number[]): ReadableStream<Uint8Array> {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.subarray(offset));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("SSE assembly under arbitrary chunk boundaries", () => {
  // Multi-byte characters in reasoning and arguments prove the decoder tolerates
  // chunk splits at any byte offset, not just between SSE events.
  const openAiEvents = [
    { choices: [{ delta: { content: "Hi", reasoning_content: "think 思考" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_", function: { name: "re", arguments: '{"path":' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "tool_calls",
          delta: {
            tool_calls: [
              { index: 0, id: "1", function: { name: "ad", arguments: '"résumé.ts"}' } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    },
  ];

  it("assembles identical OpenAI responses for any chunking", async () => {
    const whole = await consumeOpenAIStream(
      sseChunked(openAiEvents, [Number.MAX_SAFE_INTEGER]),
      () => undefined,
    );
    expect(whole).toMatchObject({
      content: "Hi",
      reasoning: "think 思考",
      stopReason: "tool_use",
      toolCalls: [{ id: "call_1", name: "read", arguments: { path: "résumé.ts" } }],
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 },
    });
    await fc.assert(
      fc.asyncProperty(chunkSizes, async (sizes) => {
        const response = await consumeOpenAIStream(
          sseChunked(openAiEvents, sizes),
          () => undefined,
        );
        expect(response).toEqual(whole);
      }),
    );
  });

  const anthropicEvents = [
    { type: "message_start", message: { usage: { input_tokens: 9 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "inspect 思考 first" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signed-state" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"résumé.ts"}' },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    },
  ];

  it("assembles identical Anthropic responses for any chunking", async () => {
    const whole = await consumeAnthropicStream(
      sseChunked(anthropicEvents, [Number.MAX_SAFE_INTEGER]),
      () => undefined,
    );
    expect(whole.toolCalls).toMatchObject([
      { id: "tool_1", name: "read", arguments: { path: "résumé.ts" } },
    ]);
    expect(whole.providerState?.thinkingBlocks).toEqual([
      { type: "thinking", thinking: "inspect 思考 first", signature: "signed-state" },
    ]);
    expect(whole.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    await fc.assert(
      fc.asyncProperty(chunkSizes, async (sizes) => {
        const response = await consumeAnthropicStream(
          sseChunked(anthropicEvents, sizes),
          () => undefined,
        );
        expect(response).toEqual(whole);
      }),
    );
  });
});

describe("reliability defaults and system fingerprint drift", () => {
  it("defaults to two retries when no reliability policy is provided", async () => {
    let requests = 0;
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      reliability: {
        timeoutMs: 2_000,
        // maxRetries intentionally omitted: the direct-client default must
        // match the resolved-config default of 2.
        retryBaseDelayMs: 1,
        retryMaximumDelayMs: 1,
      },
      fetchImplementation: async () => {
        requests += 1;
        return requests < 3
          ? new Response("overloaded", { status: 503 })
          : Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
      },
    });
    const response = await client.complete(request);
    expect(response.content).toBe("ok");
    expect(requests).toBe(3);
  });

  it("passes when the streamed system_fingerprint matches the expectation", async () => {
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      expectedSystemFingerprint: "fp_abc123",
      systemFingerprintPolicy: "fail",
      fetchImplementation: async () =>
        new Response(
          sse([
            { system_fingerprint: "fp_abc123", choices: [{ delta: { content: "ok" } }] },
            {
              choices: [{ finish_reason: "stop", delta: {} }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await client.complete(request);
    expect(response.content).toBe("ok");
    expect(response.systemFingerprint).toBe("fp_abc123");
  });

  it("fails closed on fingerprint drift when the policy is fail", async () => {
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      expectedSystemFingerprint: "fp_expected",
      systemFingerprintPolicy: "fail",
      fetchImplementation: async () =>
        Response.json({
          system_fingerprint: "fp_other",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        }),
    });
    await expect(client.complete(request)).rejects.toThrow(/system_fingerprint drift/);
  });

  it("treats a missing fingerprint as drift evidence", async () => {
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      expectedSystemFingerprint: "fp_expected",
      systemFingerprintPolicy: "fail",
      fetchImplementation: async () =>
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
    });
    await expect(client.complete(request)).rejects.toThrow(/<absent>/);
  });

  it("warns without failing when the policy is warn", async () => {
    const warnings: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const client = new OpenAIChatClient({
        baseUrl: "https://provider.example/v1",
        expectedSystemFingerprint: "fp_expected",
        systemFingerprintPolicy: "warn",
        fetchImplementation: async () =>
          Response.json({
            system_fingerprint: "fp_other",
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          }),
      });
      const response = await client.complete(request);
      expect(response.content).toBe("ok");
    } finally {
      process.stderr.write = original;
    }
    expect(warnings.join("")).toContain("system_fingerprint drift");
  });

  it("skips the check when the policy is off", async () => {
    const client = new OpenAIChatClient({
      baseUrl: "https://provider.example/v1",
      expectedSystemFingerprint: "fp_expected",
      systemFingerprintPolicy: "off",
      fetchImplementation: async () =>
        Response.json({
          system_fingerprint: "fp_other",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        }),
    });
    expect((await client.complete(request)).content).toBe("ok");
  });
});
