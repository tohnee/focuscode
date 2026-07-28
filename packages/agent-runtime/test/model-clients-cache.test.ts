import { describe, expect, it, afterEach, vi } from "vitest";
import type { ModelRequest, ProviderCompatibility } from "../src/index.js";
import {
  anthropicSystemField,
  buildOpenAIRequest,
  compatibilityPolicy,
  openAIUsage,
  anthropicUsage,
} from "../src/model-clients.js";

/**
 * D7（多 Provider cache_control）TDD 测试用例。
 *
 * 覆盖：
 * - A. ProviderCompatibility 配置（6 例，通过 compatibilityPolicy 默认值与显式配置）
 * - B. anthropicSystemField 缓存断点（4 例）
 * - C. buildOpenAIRequest 缓存路径（5 例）
 * - D. usage 解析（3 例）
 * - E. 日志埋点（4 例）
 */

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "fixture",
    systemPrompt: "default system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    temperature: 0,
    maxOutputTokens: 100,
    ...overrides,
  };
}

function fullCompatibility(
  overrides: Partial<ProviderCompatibility> = {},
): Required<ProviderCompatibility> {
  return compatibilityPolicy({ compatibility: overrides, protocol: "openai-chat", baseUrl: "" });
}

describe("D7 cache_control · A. ProviderCompatibility 配置", () => {
  it("TC-D7-01: anthropic-ephemeral 模式被 compatibilityPolicy 接受", () => {
    const policy = fullCompatibility({ cacheControl: { mode: "anthropic-ephemeral" } });
    expect(policy.cacheControl.mode).toBe("anthropic-ephemeral");
  });

  it("TC-D7-02: minimax 风格配置（anthropicThinking + cacheControl）共存", () => {
    const policy = fullCompatibility({
      anthropicThinking: "adaptive",
      cacheControl: { mode: "anthropic-ephemeral" },
    });
    expect(policy.anthropicThinking).toBe("adaptive");
    expect(policy.cacheControl.mode).toBe("anthropic-ephemeral");
  });

  it("TC-D7-03: openai-prefix 模式带 minPrefixTokens", () => {
    const policy = fullCompatibility({
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    expect(policy.cacheControl.mode).toBe("openai-prefix");
    expect(policy.cacheControl.minPrefixTokens).toBe(1024);
  });

  it("TC-D7-04: cacheControl 未设置时回退到 none（向后兼容）", () => {
    const policy = fullCompatibility({});
    expect(policy.cacheControl.mode).toBe("none");
  });

  it("TC-D7-05: qwen 风格配置（thinkingFormat + cacheControl）共存", () => {
    const policy = fullCompatibility({
      thinkingFormat: "qwen",
      supportsReasoningEffort: true,
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    expect(policy.thinkingFormat).toBe("qwen");
    expect(policy.cacheControl.mode).toBe("openai-prefix");
  });

  it("TC-D7-06: deepseek 风格配置（thinkingFormat + cacheControl）共存", () => {
    const policy = fullCompatibility({
      thinkingFormat: "deepseek",
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    expect(policy.thinkingFormat).toBe("deepseek");
    expect(policy.cacheControl.mode).toBe("openai-prefix");
  });
});

describe("D7 cache_control · B. anthropicSystemField", () => {
  it("TC-D7-07: systemPromptParts 存在时 stable block 含 cache_control ephemeral", () => {
    const request = baseRequest({
      systemPromptParts: { stable: "stable part", dynamic: "dynamic part" },
    });
    const result = anthropicSystemField(request);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0]!.text).toBe("stable part");
  });

  it("TC-D7-08: dynamic 非空时 dynamic block 不含 cache_control", () => {
    const request = baseRequest({
      systemPromptParts: { stable: "stable", dynamic: "dynamic" },
    });
    const result = anthropicSystemField(request) as Array<{
      cache_control?: { type: string };
    }>;
    expect(result[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(result[1]!.cache_control).toBeUndefined();
  });

  it("TC-D7-09: systemPromptParts 不存在时返回纯字符串（向后兼容）", () => {
    const request = baseRequest({ systemPrompt: "plain prompt" });
    const result = anthropicSystemField(request);
    expect(typeof result).toBe("string");
    expect(result).toBe("plain prompt");
  });

  it("TC-D7-10: dynamic 为空字符串时仅返回 stable block", () => {
    const request = baseRequest({
      systemPromptParts: { stable: "stable only", dynamic: "" },
    });
    const result = anthropicSystemField(request) as unknown[];
    expect(result).toHaveLength(1);
  });
});

describe("D7 cache_control · C. buildOpenAIRequest 缓存路径", () => {
  it("TC-D7-11: openai-prefix 模式下首条 message 为 system role 含 stable", () => {
    const request = baseRequest({
      systemPrompt: "ignored",
      systemPromptParts: { stable: "stable prefix", dynamic: "dynamic suffix" },
    });
    const compatibility = fullCompatibility({
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    const body = buildOpenAIRequest(request, compatibility);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "stable prefix" });
  });

  it("TC-D7-12: openai-prefix 模式下 dynamic 作为第二条 system message", () => {
    const request = baseRequest({
      systemPrompt: "ignored",
      systemPromptParts: { stable: "stable", dynamic: "dynamic" },
    });
    const compatibility = fullCompatibility({
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    const body = buildOpenAIRequest(request, compatibility);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[1]).toEqual({ role: "system", content: "dynamic" });
  });

  it("TC-D7-13: none 模式下 systemPrompt 作为单一字符串注入（向后兼容）", () => {
    const request = baseRequest({ systemPrompt: "single prompt" });
    const compatibility = fullCompatibility({ cacheControl: { mode: "none" } });
    const body = buildOpenAIRequest(request, compatibility);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "single prompt" });
  });

  it("TC-D7-14: cacheControl 未设置时回退到 none（向后兼容）", () => {
    const request = baseRequest({ systemPrompt: "fallback prompt" });
    const compatibility = fullCompatibility({});
    const body = buildOpenAIRequest(request, compatibility);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "fallback prompt" });
  });

  it("TC-D7-15: openai-prefix 模式但 systemPromptParts 缺失时使用 systemPrompt", () => {
    const request = baseRequest({ systemPrompt: "legacy prompt" });
    const compatibility = fullCompatibility({
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    const body = buildOpenAIRequest(request, compatibility);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "legacy prompt" });
  });
});

describe("D7 cache_control · D. usage 解析", () => {
  it("TC-D7-16: OpenAI prompt_tokens_details.cached_tokens 映射到 cachedInputTokens", () => {
    const usage = openAIUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(usage.cachedInputTokens).toBe(40);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it("TC-D7-17: Anthropic cache_read_input_tokens 映射到 cachedInputTokens", () => {
    const usage = anthropicUsage({
      input_tokens: 80,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 10,
    });
    expect(usage.cachedInputTokens).toBe(30);
    expect(usage.inputTokens).toBe(130); // 80 + 20 + 30
    expect(usage.outputTokens).toBe(10);
  });

  it("TC-D7-18: cached_tokens 为 0 时不设置 cachedInputTokens", () => {
    const usage = openAIUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(usage.cachedInputTokens).toBeUndefined();
  });
});

describe("D7 cache_control · E. 日志埋点", () => {
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  afterEach(() => {
    stderrSpy.mockClear();
  });

  it("TC-D7-19: buildOpenAIRequest 在 openai-prefix 模式输出 [cache:openai-prefix] 日志", () => {
    const request = baseRequest({
      systemPromptParts: { stable: "stable", dynamic: "dynamic" },
    });
    const compatibility = fullCompatibility({
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    buildOpenAIRequest(request, compatibility);
    const calls = stderrSpy.mock.calls.map((call) => String(call[0]));
    const cacheLog = calls.find((line) => line.includes("[cache:openai-prefix]"));
    expect(cacheLog).toBeDefined();
  });

  it("TC-D7-20: anthropicSystemField 输出 [cache:anthropic-ephemeral] 日志", () => {
    const request = baseRequest({
      systemPromptParts: { stable: "stable", dynamic: "dynamic" },
    });
    anthropicSystemField(request);
    const calls = stderrSpy.mock.calls.map((call) => String(call[0]));
    const cacheLog = calls.find((line) => line.includes("[cache:anthropic-ephemeral]"));
    expect(cacheLog).toBeDefined();
  });

  it("TC-D7-21: openAIUsage 在 cached>0 时输出 [cache:hit] 日志含 ratio", () => {
    openAIUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    const calls = stderrSpy.mock.calls.map((call) => String(call[0]));
    const hitLog = calls.find((line) => line.includes("[cache:hit]"));
    expect(hitLog).toBeDefined();
    expect(hitLog).toMatch(/ratio=/);
  });

  it("TC-D7-22: stderr 日志不影响正常返回值", () => {
    const request = baseRequest({
      systemPromptParts: { stable: "stable", dynamic: "dynamic" },
    });
    const compatibility = fullCompatibility({
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    });
    const body = buildOpenAIRequest(request, compatibility);
    expect(body.model).toBe("fixture");
    expect(body.stream).toBe(true);
  });
});
