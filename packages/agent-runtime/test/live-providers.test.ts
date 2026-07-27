import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModelClient, resolveAgentConfig } from "../src/index.js";

// Opt-in live smoke tests against real provider endpoints. They are skipped
// unless FOCUSCODE_LIVE_PROVIDERS is set, so CI never depends on network or
// credentials. Each provider reads its usual API key environment variable
// (the same ones resolveAgentConfig consults); a provider without a key is
// skipped individually. Providers whose preset has no default model need an
// explicit FOCUSCODE_LIVE_MODEL_<PROVIDER> override.
//
//   FOCUSCODE_LIVE_PROVIDERS=1 DEEPSEEK_API_KEY=... npx vitest run packages/agent-runtime/test/live-providers.test.ts

const LIVE = process.env.FOCUSCODE_LIVE_PROVIDERS;

interface LiveProvider {
  provider: string;
  envKey: string;
  /** True when the built-in preset ships a defaultModel for this provider. */
  hasDefaultModel: boolean;
}

const PROVIDERS: LiveProvider[] = [
  { provider: "openai", envKey: "OPENAI_API_KEY", hasDefaultModel: false },
  { provider: "anthropic", envKey: "ANTHROPIC_API_KEY", hasDefaultModel: false },
  { provider: "gemini", envKey: "GEMINI_API_KEY", hasDefaultModel: false },
  { provider: "openrouter", envKey: "OPENROUTER_API_KEY", hasDefaultModel: false },
  { provider: "deepseek", envKey: "DEEPSEEK_API_KEY", hasDefaultModel: true },
  { provider: "qwen", envKey: "DASHSCOPE_API_KEY", hasDefaultModel: true },
  { provider: "kimi", envKey: "MOONSHOT_API_KEY", hasDefaultModel: true },
  { provider: "kimi-coding", envKey: "KIMI_API_KEY", hasDefaultModel: true },
  { provider: "glm", envKey: "ZAI_API_KEY", hasDefaultModel: true },
  { provider: "ark", envKey: "ARK_API_KEY", hasDefaultModel: true },
  { provider: "minimax", envKey: "MINIMAX_API_KEY", hasDefaultModel: true },
];

function modelOverrideEnv(provider: string): string {
  return `FOCUSCODE_LIVE_MODEL_${provider.toUpperCase().replaceAll("-", "_")}`;
}

describe.skipIf(!LIVE)("live providers", () => {
  for (const { provider, envKey, hasDefaultModel } of PROVIDERS) {
    const key = process.env[envKey];
    const modelOverride = process.env[modelOverrideEnv(provider)];
    const runnable = key && (hasDefaultModel || modelOverride);
    const testCase = runnable ? it : it.skip;
    testCase(
      `${provider} answers a short prompt (${runnable ? "live" : "skipped: no ${envKey} or model"})`,
      { timeout: 120_000 },
      async () => {
        const config = await resolveAgentConfig(process.cwd(), {
          provider,
          ...(modelOverride ? { model: modelOverride } : {}),
          // Keep live runs hermetic: never read the developer's real configs.
          globalConfigPath: join(tmpdir(), "focuscode-live-missing-global.json"),
          projectConfigPath: join(tmpdir(), "focuscode-live-missing-project.json"),
        });
        const client = createModelClient({ ...config.model });
        const response = await client.complete({
          model: config.model.model,
          systemPrompt: "You are a smoke test. Reply with one short sentence and nothing else.",
          messages: [{ role: "user", content: "Say hello in five words or fewer." }],
          tools: [],
          temperature: 0,
          maxOutputTokens: 1_024,
        });
        expect(response.stopReason).not.toBe("error");
        expect(response.content.trim().length).toBeGreaterThan(0);
        expect(response.usage.inputTokens + response.usage.outputTokens).toBeGreaterThan(0);
      },
    );
  }
});
