import { describe, expect, it } from "vitest";
import {
  CircuitBreakingModelClient,
  CircuitOpenError,
  createCircuitBreakerRegistry,
} from "../src/circuit-breaker.js";
import { OpenAIChatClient } from "../src/model-clients.js";
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent } from "../src/types.js";

const request: ModelRequest = {
  model: "fixture-model",
  systemPrompt: "system",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  temperature: 0,
  maxOutputTokens: 64,
};

function response(
  content: string,
  stopReason: ModelResponse["stopReason"] = "stop",
): ModelResponse {
  return { content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason };
}

function stubClient(complete: ModelClient["complete"]): ModelClient {
  return { protocol: "openai-chat", complete };
}

function failingClient(): { client: ModelClient; calls: () => number } {
  let calls = 0;
  return {
    client: stubClient(async () => {
      calls += 1;
      throw new Error("provider down");
    }),
    calls: () => calls,
  };
}

describe("CircuitBreakingModelClient", () => {
  it("opens after the failure threshold and fails fast while open", async () => {
    const { client, calls } = failingClient();
    let now = 1_000;
    const wrapped = new CircuitBreakingModelClient(client, {
      provider: "fixture",
      circuitThreshold: 3,
      circuitCooldownMs: 30_000,
      now: () => now,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(wrapped.complete(request)).rejects.toThrow("provider down");
    }
    expect(calls()).toBe(3);
    expect(wrapped.state("fixture/fixture-model")).toBe("open");
    // Open circuit: fail fast without touching the provider.
    await expect(wrapped.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(wrapped.complete(request)).rejects.toThrow(/Circuit open/);
    expect(calls()).toBe(3);
    // Still cooling down.
    now += 29_999;
    await expect(wrapped.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls()).toBe(3);
  });

  it("half-opens after the cooldown and closes on a successful probe", async () => {
    let now = 0;
    let fail = true;
    let calls = 0;
    const wrapped = new CircuitBreakingModelClient(
      stubClient(async () => {
        calls += 1;
        if (fail) throw new Error("provider down");
        return response("ok");
      }),
      { provider: "fixture", circuitThreshold: 2, circuitCooldownMs: 30_000, now: () => now },
    );
    await expect(wrapped.complete(request)).rejects.toThrow("provider down");
    await expect(wrapped.complete(request)).rejects.toThrow("provider down");
    expect(wrapped.state("fixture/fixture-model")).toBe("open");
    now += 30_000;
    fail = false;
    const probe = await wrapped.complete(request);
    expect(probe.content).toBe("ok");
    expect(wrapped.state("fixture/fixture-model")).toBe("closed");
    expect(calls).toBe(3);
  });

  it("reopens on a failed probe and admits only one probe at a time", async () => {
    let now = 0;
    const wrapped = new CircuitBreakingModelClient(
      stubClient(async () => {
        throw new Error("provider down");
      }),
      { provider: "fixture", circuitThreshold: 1, circuitCooldownMs: 30_000, now: () => now },
    );
    await expect(wrapped.complete(request)).rejects.toThrow("provider down");
    expect(wrapped.state("fixture/fixture-model")).toBe("open");
    now += 30_000;
    await expect(wrapped.complete(request)).rejects.toThrow("provider down");
    expect(wrapped.state("fixture/fixture-model")).toBe("open");

    // Concurrent calls during a probe: exactly one is admitted.
    let behavior: "fail" | "wait" = "fail";
    let releaseProbe!: () => void;
    const slow = new CircuitBreakingModelClient(
      stubClient(async () => {
        if (behavior === "fail") throw new Error("provider down");
        return new Promise<ModelResponse>((resolve) => {
          releaseProbe = () => resolve(response("late"));
        });
      }),
      { provider: "fixture", circuitThreshold: 1, circuitCooldownMs: 30_000, now: () => now },
    );
    await expect(slow.complete(request)).rejects.toThrow("provider down");
    expect(slow.state("fixture/fixture-model")).toBe("open");
    now += 30_000;
    behavior = "wait";
    const probe = slow.complete(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(slow.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    releaseProbe();
    expect((await probe).content).toBe("late");
    expect(slow.state("fixture/fixture-model")).toBe("closed");
  });

  it("does not count caller aborts as provider failures", async () => {
    const controller = new AbortController();
    const wrapped = new CircuitBreakingModelClient(
      stubClient(async ({ signal }) => {
        controller.abort();
        throw signal?.reason ?? new Error("aborted");
      }),
      { provider: "fixture", circuitThreshold: 1 },
    );
    const aborted = { ...request, signal: controller.signal };
    await expect(wrapped.complete(aborted)).rejects.toThrow();
    expect(wrapped.state("fixture/fixture-model")).toBe("closed");
  });

  it("counts error stop reasons as failures without swallowing the response", async () => {
    let calls = 0;
    const wrapped = new CircuitBreakingModelClient(
      stubClient(async () => {
        calls += 1;
        return response("", "error");
      }),
      { provider: "fixture", circuitThreshold: 2 },
    );
    expect((await wrapped.complete(request)).stopReason).toBe("error");
    expect((await wrapped.complete(request)).stopReason).toBe("error");
    expect(wrapped.state("fixture/fixture-model")).toBe("open");
    await expect(wrapped.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
  });

  it("queues calls beyond the per-provider concurrency limit instead of rejecting", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const wrapped = new CircuitBreakingModelClient(
      stubClient(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return response("ok");
      }),
      { provider: "fixture", maxConcurrency: 2 },
    );
    const pending = [0, 1, 2, 3].map(() => wrapped.complete(request));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maxInFlight).toBe(2);
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maxInFlight).toBe(2);
    // Freeing a slot lets exactly one queued call in; yield so it can
    // register its own release before the next iteration.
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect((await Promise.all(pending)).map((item) => item.content)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("shares circuit state across clients through a common registry", async () => {
    const registry = createCircuitBreakerRegistry();
    const { client, calls } = failingClient();
    const options = { provider: "fixture", circuitThreshold: 2, registry };
    const first = new CircuitBreakingModelClient(client, options);
    const second = new CircuitBreakingModelClient(client, options);
    await expect(first.complete(request)).rejects.toThrow("provider down");
    await expect(second.complete(request)).rejects.toThrow("provider down");
    // The shared key opened, so both wrappers now fail fast.
    await expect(first.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(second.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls()).toBe(2);
  });

  it("applies jitter to exponential backoff within [0.5, 1.0] of the capped delay", async () => {
    const delays: number[] = [];
    for (let iteration = 0; iteration < 25; iteration += 1) {
      let requests = 0;
      const client = new OpenAIChatClient({
        baseUrl: "https://provider.example/v1",
        reliability: {
          timeoutMs: 5_000,
          maxRetries: 1,
          retryBaseDelayMs: 100,
          retryMaximumDelayMs: 100,
        },
        fetchImplementation: async () => {
          requests += 1;
          return requests === 1
            ? new Response("slow down", { status: 429 })
            : Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
        },
      });
      await client.complete(request, (event: ModelStreamEvent) => {
        if (event.type === "model_retry") delays.push(event.delayMs);
      });
    }
    expect(delays).toHaveLength(25);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });
});
