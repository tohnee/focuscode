import { describe, expect, it } from "vitest";
import {
  GeminiClient,
  OpenAIResponsesClient,
  consumeGeminiStream,
  consumeResponsesStream,
  createModelClient,
  type ModelRequest,
} from "../src/index.js";

const image = {
  type: "image" as const,
  id: "image_1",
  name: "screen.png",
  mediaType: "image/png" as const,
  sizeBytes: 8,
  source: { type: "base64" as const, data: "iVBORw0KGgo=" },
};

const request: ModelRequest = {
  model: "fixture",
  systemPrompt: "system",
  messages: [{ role: "user", content: "inspect", attachments: [image] }],
  tools: [
    {
      name: "read",
      label: "Read",
      description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      effect: "read",
    },
  ],
  temperature: 0,
  maxOutputTokens: 100,
};

describe("OpenAI Responses native client", () => {
  it("maps multimodal input, tools and JSON output", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const client = new OpenAIResponsesClient({
      baseUrl: "https://api.example/v1",
      apiKey: "secret",
      fetchImplementation: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          status: "completed",
          output: [
            { type: "message", content: [{ type: "output_text", text: "done" }] },
            {
              type: "function_call",
              call_id: "call_1",
              name: "read",
              arguments: '{"path":"a.ts"}',
            },
          ],
          usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } },
        });
      },
    });
    const response = await client.complete(request);
    expect(capturedUrl).toBe("https://api.example/v1/responses");
    expect(JSON.stringify(capturedBody)).toContain("input_image");
    expect(JSON.stringify(capturedBody)).toContain("function");
    expect(response).toMatchObject({
      content: "done",
      stopReason: "tool_use",
      toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }],
      usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 2 },
    });
  });

  it("assembles streamed text, reasoning and function arguments", async () => {
    const response = await consumeResponsesStream(
      sse([
        { type: "response.output_text.delta", delta: "Hi" },
        { type: "response.reasoning_summary_text.delta", delta: "Think" },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call_1", name: "read" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"path":"a.ts"}',
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 3 } },
        },
      ]),
      () => undefined,
    );
    expect(response).toMatchObject({
      content: "Hi",
      reasoning: "Think",
      stopReason: "tool_use",
      toolCalls: [{ name: "read", arguments: { path: "a.ts" } }],
    });
  });
});

describe("Gemini native client", () => {
  it("maps inline images and function declarations with API-key auth", async () => {
    let headers: HeadersInit | undefined;
    let body = "";
    const client = new GeminiClient({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gemini-key",
      fetchImplementation: async (_input, init) => {
        headers = init?.headers;
        body = String(init?.body);
        return Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  { text: "checking" },
                  { functionCall: { id: "g1", name: "read", args: { path: "a.ts" } } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
        });
      },
    });
    const response = await client.complete(request);
    expect(headers).toMatchObject({ "x-goog-api-key": "gemini-key" });
    expect(body).toContain("inlineData");
    expect(body).toContain("functionDeclarations");
    expect(response.toolCalls[0]).toMatchObject({ id: "g1", arguments: { path: "a.ts" } });
  });

  it("assembles streamed thought, text, calls and usage", async () => {
    const response = await consumeGeminiStream(
      sse([
        {
          candidates: [
            {
              content: { parts: [{ text: "plan", thought: true }, { text: "done" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
        },
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "read", args: { path: "b.ts" } } }],
              },
            },
          ],
        },
      ]),
      () => undefined,
    );
    expect(response).toMatchObject({
      content: "done",
      reasoning: "plan",
      stopReason: "tool_use",
      toolCalls: [{ name: "read", arguments: { path: "b.ts" } }],
      usage: { inputTokens: 8, outputTokens: 2 },
    });
    expect(
      createModelClient({ protocol: "google-gemini", baseUrl: "https://example.com" }),
    ).toBeInstanceOf(GeminiClient);
  });
});

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events)
        controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
