import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ContextCompiler, buildRepoProfile } from "@focuscode/context-compiler";
import {
  createTestDirectory,
  fixtureExecution,
  fixtureTask,
  fixtureTool,
} from "@focuscode/testkit";
import {
  GatewayDecisionPort,
  OpenAICompatibleTransport,
  assertPackBinding,
  createDevelopmentModelRef,
  loadModelPack,
  type ModelTransport,
} from "../src/index.js";

describe("Model Gateway", () => {
  it("loads, digests and binds a declarative Model Pack", async () => {
    const loaded = await loadModelPack(resolve("model-packs/generic-openai/pack.json"));
    const model = createDevelopmentModelRef(loaded, "fixture-model");
    expect(model.modelPack).toBe(loaded.digest);
    expect(model.riskLevel).toBe("sandbox-only");
    expect(() => assertPackBinding(loaded, model)).not.toThrow();
    await expect(
      loadModelPack(resolve("model-packs/fixtures-invalid/missing-envelope.json")),
    ).rejects.toThrow(/contextEnvelope/);
  });

  it("compiles canonical context and parses a transport decision", async () => {
    const root = await createTestDirectory("gateway");
    await writeFile(join(root, "package.json"), '{"name":"gateway"}\n');
    const loaded = await loadModelPack(resolve("model-packs/generic-openai/pack.json"));
    let observedSystem = "";
    const transport: ModelTransport = {
      async complete(request) {
        observedSystem = request.messages[0]?.content ?? "";
        return {
          chunks: [
            JSON.stringify({
              kind: "completion_candidate",
              summary: "ready",
              evidence: [],
              residualRisks: [],
            }),
          ],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    const gateway = new GatewayDecisionPort({
      loadedPack: loaded,
      contextCompiler: new ContextCompiler(await buildRepoProfile(root)),
      transport,
    });
    const model = createDevelopmentModelRef(loaded, "fixture-model");
    const result = await gateway.decide(
      {
        schemaVersion: "turn-input.v1",
        task: fixtureTask(),
        execution: fixtureExecution("gateway-task"),
        state: "RUNNING",
        turn: 1,
        publicPlan: [],
        tools: [fixtureTool()],
        recentEvents: [],
        recentEffects: [],
      },
      model,
    );
    expect(result.status).toBe("complete");
    expect(result.decision?.kind).toBe("completion_candidate");
    expect(observedSystem).toContain("tools.schemas");
    expect(observedSystem).toContain("gateway-task");
  });

  it("implements the OpenAI-compatible transport and maps usage", async () => {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) void _chunk;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  kind: "completion_candidate",
                  summary: "ok",
                  evidence: [],
                  residualRisks: [],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const transport = new OpenAICompatibleTransport({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
      });
      const response = await transport.complete({
        model: "fixture",
        messages: [{ role: "user", content: "test" }],
        responseFormat: "json",
        timeoutMs: 5_000,
      });
      expect(response.finishReason).toBe("stop");
      expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
