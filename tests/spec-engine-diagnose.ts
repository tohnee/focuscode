/**
 * SpecEngine Drafter Diagnosis — 捕获 drafter 阶段的实际错误
 *
 * Usage:
 *   ARK_API_KEY=<key> npx tsx tests/spec-engine-diagnose.ts
 */
import { createModelClient, type ModelProfile, type ModelRequest } from "@focuscode/agent-runtime";

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ARK_MODEL = "glm-5.2";

async function main(): Promise<void> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    process.stderr.write("[SKIP] ARK_API_KEY not set\n");
    process.exit(2);
  }

  const profile: ModelProfile = {
    provider: "ark",
    model: ARK_MODEL,
    protocol: "openai-chat",
    baseUrl: ARK_BASE_URL,
    apiKey,
    apiKeyEnv: "ARK_API_KEY",
    authType: "bearer",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    temperature: 0.2,
    toolMode: "native",
    reasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "openai",
      supportsReasoningEffort: false,
    },
    reliability: {
      timeoutMs: 120_000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
      retryMaximumDelayMs: 10_000,
    },
  };

  const client = createModelClient({
    protocol: "openai-chat",
    baseUrl: ARK_BASE_URL,
    apiKey,
    reliability: profile.reliability,
    timeoutMs: 60_000,
  });

  const request: ModelRequest = {
    model: ARK_MODEL,
    systemPrompt: "You are a helpful assistant. Reply with valid JSON only.",
    messages: [
      {
        role: "user",
        content: 'Return this JSON: {"topic":"test","status":"ok"}',
      },
    ],
    tools: [],
    temperature: 0,
    maxOutputTokens: 256,
  };

  process.stderr.write("\n=== Diagnosing ARK API ===\n");
  process.stderr.write(`URL: ${ARK_BASE_URL}\n`);
  process.stderr.write(`Model: ${ARK_MODEL}\n\n`);

  try {
    process.stderr.write("Calling client.complete()...\n");
    const response = await client.complete(request);
    process.stderr.write("\n--- Response ---\n");
    process.stderr.write(`stopReason: ${response.stopReason}\n`);
    process.stderr.write(`content length: ${response.content.length}\n`);
    process.stderr.write(`content (first 500 chars):\n${response.content.slice(0, 500)}\n`);
    if (response.usage) {
      process.stderr.write(`usage: ${JSON.stringify(response.usage)}\n`);
    }
    process.stderr.write("\nResult: PASS\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write("\n--- Error ---\n");
    if (error instanceof Error) {
      process.stderr.write(`name: ${error.name}\n`);
      process.stderr.write(`message: ${error.message}\n`);
      if (error.stack) {
        process.stderr.write(`stack (first 1000 chars):\n${error.stack.slice(0, 1000)}\n`);
      }
      // @ts-expect-error — inspect extra fields
      if (error.status) process.stderr.write(`status: ${error.status}\n`);
      // @ts-expect-error — inspect extra fields
      if (error.body) process.stderr.write(`body: ${JSON.stringify(error.body).slice(0, 500)}\n`);
    } else {
      process.stderr.write(`String: ${String(error)}\n`);
    }
    process.stderr.write("\nResult: FAIL\n");
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
