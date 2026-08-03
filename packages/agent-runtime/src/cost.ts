import type { ModelPricing } from "./config.js";
import type { TokenUsage } from "./types.js";

/** 缓存命中率与未命中输入 token 的派生指标。 */
export function cacheMetrics(usage: TokenUsage): { hitRatio: number; uncachedInputTokens: number } {
  const cached = usage.cachedInputTokens ?? 0;
  const hitRatio = usage.inputTokens > 0 ? cached / usage.inputTokens : 0;
  return { hitRatio, uncachedInputTokens: Math.max(0, usage.inputTokens - cached) };
}

/**
 * 按每百万 token 定价折算成本（USD）。input 计费按未命中部分计，
 * cached 段按缓存价计，二者互斥（cachedInputTokens 已包含在 inputTokens 内）。
 * 无 pricing 时全部为 0（与现有 --cost 面板的 "no pricing" 行为一致）。
 */
export function estimateCostUsd(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
): { inputUsd: number; outputUsd: number; cachedUsd: number; totalUsd: number } {
  if (!pricing) return { inputUsd: 0, outputUsd: 0, cachedUsd: 0, totalUsd: 0 };
  const { uncachedInputTokens } = cacheMetrics(usage);
  const inputUsd = (uncachedInputTokens / 1_000_000) * pricing.input;
  const outputUsd = (usage.outputTokens / 1_000_000) * pricing.output;
  const cachedUsd =
    pricing.cachedInput !== undefined
      ? ((usage.cachedInputTokens ?? 0) / 1_000_000) * pricing.cachedInput
      : 0;
  return { inputUsd, outputUsd, cachedUsd, totalUsd: inputUsd + outputUsd + cachedUsd };
}
