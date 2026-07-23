import { describe, it, expect } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent } from "../src/types.js";
import { ModelHttpError } from "../src/model-clients.js";
import { CircuitOpenError } from "../src/circuit-breaker.js";
import { FallbackModelClient, type FallbackEvent } from "../src/fallback-model-client.js";

class QueueModelClient implements ModelClient {
  readonly protocol: string;
  readonly requests: ModelRequest[] = [];
  readonly events: ModelStreamEvent[][] = [];

  constructor(
    protocol: string,
    private readonly responses: Array<ModelResponse | Error>,
  ) {
    this.protocol = protocol;
  }

  async complete(
    request: ModelRequest,
    onEvent?: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response instanceof Error) throw response;
    if (response.content && onEvent) {
      const captured: ModelStreamEvent[] = [];
      captured.push({ type: "text_delta", delta: response.content });
      this.events.push(captured);
      for (const ev of captured) onEvent(ev);
    }
    return response;
  }
}

function successResponse(content: string, protocol = "primary"): ModelResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "stop",
    ...(protocol ? {} : {}),
  };
}

function errorResponse(): ModelResponse {
  return {
    content: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "error",
  };
}

describe("FallbackModelClient", () => {
  it("switches to secondary when primary returns stopReason=error", async () => {
    const primary = new QueueModelClient("openai-chat", [errorResponse()]);
    const secondary = new QueueModelClient("anthropic-messages", [successResponse("ok")]);
    const fallbacks: FallbackEvent[] = [];
    const client = new FallbackModelClient(primary, [secondary], {
      onFallback: (e) => fallbacks.push(e),
    });

    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });

    expect(response.content).toBe("ok");
    expect(response.stopReason).toBe("stop");
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(1);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toEqual({
      from: "primary",
      to: "fallback[0]",
      reason: "stopReason=error",
    });
  });

  it("switches to secondary when primary throws ModelHttpError 429", async () => {
    const primary = new QueueModelClient("openai-chat", [
      new ModelHttpError("rate limited", 429, "{}"),
    ]);
    const secondary = new QueueModelClient("openai-chat", [successResponse("recovered")]);
    const fallbacks: FallbackEvent[] = [];
    const client = new FallbackModelClient(primary, [secondary], {
      onFallback: (e) => fallbacks.push(e),
    });

    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });

    expect(response.content).toBe("recovered");
    expect(fallbacks[0]?.reason).toBe("HTTP 429");
  });

  it("switches to secondary when primary throws ModelHttpError 503", async () => {
    const primary = new QueueModelClient("openai-chat", [
      new ModelHttpError("unavailable", 503, "{}"),
    ]);
    const secondary = new QueueModelClient("openai-chat", [successResponse("ok")]);
    const client = new FallbackModelClient(primary, [secondary]);

    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });

    expect(response.content).toBe("ok");
  });

  it("switches to secondary when primary throws CircuitOpenError", async () => {
    const primary = new QueueModelClient("openai-chat", [
      new CircuitOpenError("openai/gpt-test", 30_000),
    ]);
    const secondary = new QueueModelClient("openai-chat", [successResponse("ok")]);
    const fallbacks: FallbackEvent[] = [];
    const client = new FallbackModelClient(primary, [secondary], {
      onFallback: (e) => fallbacks.push(e),
    });

    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });

    expect(response.content).toBe("ok");
    expect(fallbacks[0]?.reason).toMatch(/circuit open/i);
  });

  it("does not invoke secondary when primary succeeds", async () => {
    const primary = new QueueModelClient("openai-chat", [successResponse("primary-ok")]);
    const secondary = new QueueModelClient("anthropic-messages", [successResponse("secondary-ok")]);
    const fallbacks: FallbackEvent[] = [];
    const client = new FallbackModelClient(primary, [secondary], {
      onFallback: (e) => fallbacks.push(e),
    });

    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });

    expect(response.content).toBe("primary-ok");
    expect(secondary.requests).toHaveLength(0);
    expect(fallbacks).toHaveLength(0);
  });

  it("propagates the last error when all fallbacks fail", async () => {
    const primary = new QueueModelClient("openai-chat", [
      new ModelHttpError("primary down", 500, "{}"),
    ]);
    const secondary = new QueueModelClient("openai-chat", [
      new ModelHttpError("secondary down", 503, "{}"),
    ]);
    const client = new FallbackModelClient(primary, [secondary]);

    await expect(
      client.complete({
        model: "test",
        systemPrompt: "",
        messages: [],
        tools: [],
        temperature: 0,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/secondary down/);
  });

  it("tries multiple fallbacks in order until one succeeds", async () => {
    const primary = new QueueModelClient("openai-chat", [errorResponse()]);
    const fb1 = new QueueModelClient("openai-chat", [errorResponse()]);
    const fb2 = new QueueModelClient("openai-chat", [errorResponse()]);
    const fb3 = new QueueModelClient("anthropic-messages", [successResponse("third-fallback")]);
    const fallbacks: FallbackEvent[] = [];
    const client = new FallbackModelClient(primary, [fb1, fb2, fb3], {
      onFallback: (e) => fallbacks.push(e),
    });

    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });

    expect(response.content).toBe("third-fallback");
    expect(fallbacks).toHaveLength(3);
    expect(fallbacks[0]).toEqual({
      from: "primary",
      to: "fallback[0]",
      reason: "stopReason=error",
    });
    expect(fallbacks[1]).toEqual({
      from: "fallback[0]",
      to: "fallback[1]",
      reason: "stopReason=error",
    });
    expect(fallbacks[2]).toEqual({
      from: "fallback[1]",
      to: "fallback[2]",
      reason: "stopReason=error",
    });
  });

  it("does not fall back on non-retryable HTTP errors (e.g. 400)", async () => {
    const primary = new QueueModelClient("openai-chat", [
      new ModelHttpError("bad request", 400, "{}"),
    ]);
    const secondary = new QueueModelClient("openai-chat", [successResponse("ok")]);
    const client = new FallbackModelClient(primary, [secondary]);

    await expect(
      client.complete({
        model: "test",
        systemPrompt: "",
        messages: [],
        tools: [],
        temperature: 0,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/bad request/);
    expect(secondary.requests).toHaveLength(0);
  });

  it("does not fall back on caller abort", async () => {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    const primary = new QueueModelClient("openai-chat", [abortError]);
    const secondary = new QueueModelClient("openai-chat", [successResponse("ok")]);
    const client = new FallbackModelClient(primary, [secondary]);

    await expect(
      client.complete({
        model: "test",
        systemPrompt: "",
        messages: [],
        tools: [],
        temperature: 0,
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/Request aborted/);
    expect(secondary.requests).toHaveLength(0);
  });

  it("forwards onEvent stream events from the winning client", async () => {
    const primary = new QueueModelClient("openai-chat", [errorResponse()]);
    const secondary = new QueueModelClient("anthropic-messages", [successResponse("streamed")]);
    const client = new FallbackModelClient(primary, [secondary]);
    const events: ModelStreamEvent[] = [];

    await client.complete(
      {
        model: "test",
        systemPrompt: "",
        messages: [],
        tools: [],
        temperature: 0,
        maxOutputTokens: 100,
      },
      (ev) => events.push(ev),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "text_delta", delta: "streamed" });
  });

  it("protocol property reflects the primary client", () => {
    const primary = new QueueModelClient("openai-chat", []);
    const secondary = new QueueModelClient("anthropic-messages", []);
    const client = new FallbackModelClient(primary, [secondary]);
    expect(client.protocol).toBe("openai-chat");
  });
});
