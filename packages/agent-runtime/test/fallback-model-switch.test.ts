import { describe, it, expect } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent } from "../src/types.js";
import { ModelHttpError } from "../src/model-clients.js";
import { FallbackModelClient } from "../src/fallback-model-client.js";

/**
 * Recording stand-in for a ModelClient. Captures every request it receives
 * (so tests can assert the `model` field was rewritten per chain link) and
 * optionally emits scripted stream events before returning its response.
 */
class RecordingModelClient implements ModelClient {
  readonly protocol: string;
  readonly receivedRequests: ModelRequest[] = [];

  constructor(
    protocol: string,
    private readonly behaviour: {
      response?: ModelResponse;
      error?: Error;
      events?: ModelStreamEvent[];
    },
  ) {
    this.protocol = protocol;
  }

  async complete(
    request: ModelRequest,
    onEvent?: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse> {
    this.receivedRequests.push(request);
    if (this.behaviour.events && onEvent) {
      for (const ev of this.behaviour.events) onEvent(ev);
    }
    if (this.behaviour.error) throw this.behaviour.error;
    if (!this.behaviour.response) throw new Error("no scripted response");
    return this.behaviour.response;
  }
}

function successResponse(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "stop",
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

const baseRequest: ModelRequest = {
  model: "primary-model",
  systemPrompt: "",
  messages: [],
  tools: [],
  temperature: 0,
  maxOutputTokens: 100,
};

describe("FallbackModelClient model switching (P1-1)", () => {
  it("TC-P1-1-01: rewrites request.model to the fallback profile's model when primary fails", async () => {
    const primary = new RecordingModelClient("openai-chat", { response: errorResponse() });
    const secondary = new RecordingModelClient("openai-chat", { response: successResponse("ok") });
    const client = new FallbackModelClient(primary, [secondary], {
      primaryModel: "primary-model",
      fallbackModels: ["fallback-model"],
    });

    const response = await client.complete({ ...baseRequest });

    expect(response.content).toBe("ok");
    expect(primary.receivedRequests[0]!.model).toBe("primary-model");
    // The fallback client must receive ITS OWN model id, not the primary's.
    expect(secondary.receivedRequests[0]!.model).toBe("fallback-model");
  });

  it("TC-P1-1-02: does not invoke the fallback client when primary succeeds", async () => {
    const primary = new RecordingModelClient("openai-chat", {
      response: successResponse("primary-ok"),
    });
    const secondary = new RecordingModelClient("openai-chat", {
      response: successResponse("secondary-ok"),
    });
    const client = new FallbackModelClient(primary, [secondary], {
      primaryModel: "primary-model",
      fallbackModels: ["fallback-model"],
    });

    const response = await client.complete({ ...baseRequest });

    expect(response.content).toBe("primary-ok");
    expect(secondary.receivedRequests).toHaveLength(0);
  });

  it("TC-P1-1-03: suppresses stream events from a failed attempt (no partial delta leak)", async () => {
    const primary = new RecordingModelClient("openai-chat", {
      response: errorResponse(),
      events: [{ type: "text_delta", delta: "LEAKED-PARTIAL" }],
    });
    const secondary = new RecordingModelClient("openai-chat", {
      response: successResponse("ok"),
      events: [{ type: "text_delta", delta: "ok-delta" }],
    });
    const client = new FallbackModelClient(primary, [secondary], {
      primaryModel: "primary-model",
      fallbackModels: ["fallback-model"],
    });
    const events: ModelStreamEvent[] = [];

    await client.complete({ ...baseRequest }, (ev) => events.push(ev));

    // The primary's partial delta must never reach the consumer.
    expect(
      events.find((e) => e.type === "text_delta" && e.delta === "LEAKED-PARTIAL"),
    ).toBeUndefined();
    expect(events).toEqual([{ type: "text_delta", delta: "ok-delta" }]);
  });

  it("TC-P1-1-04: forwards stream events from the successful attempt", async () => {
    const primary = new RecordingModelClient("openai-chat", { response: errorResponse() });
    const secondary = new RecordingModelClient("openai-chat", {
      response: successResponse("streamed"),
      events: [
        { type: "text_delta", delta: "hel" },
        { type: "text_delta", delta: "lo" },
      ],
    });
    const client = new FallbackModelClient(primary, [secondary], {
      primaryModel: "primary-model",
      fallbackModels: ["fallback-model"],
    });
    const events: ModelStreamEvent[] = [];

    await client.complete({ ...baseRequest }, (ev) => events.push(ev));

    expect(events).toEqual([
      { type: "text_delta", delta: "hel" },
      { type: "text_delta", delta: "lo" },
    ]);
  });

  it("TC-P1-1-05: throws the last error when every client in the chain fails", async () => {
    const primary = new RecordingModelClient("openai-chat", {
      error: new ModelHttpError("primary down", 503, "{}"),
    });
    const secondary = new RecordingModelClient("openai-chat", {
      error: new ModelHttpError("secondary down", 503, "{}"),
    });
    const client = new FallbackModelClient(primary, [secondary], {
      primaryModel: "primary-model",
      fallbackModels: ["fallback-model"],
    });

    await expect(client.complete({ ...baseRequest })).rejects.toThrow(/secondary down/);
    expect(primary.receivedRequests[0]!.model).toBe("primary-model");
    expect(secondary.receivedRequests[0]!.model).toBe("fallback-model");
  });
});
