import { createHash } from "node:crypto";
import type { CacheEpochManifestV1 } from "@focuscode/contracts";
import type { ProviderCompatibility, ToolDefinition } from "./types.js";

/** sha256 前 16 位 hex;用于稳定前缀指纹(非安全用途,仅内容寻址比较)。 */
export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * 计算当前 cache epoch 的兼容性指纹。任一输入变化都产生新 epoch。
 * 可选字段仅在对应输入存在时写入 manifest(兼容 exactOptionalPropertyTypes,
 * 避免把 undefined 赋给可选属性)。
 */
export function computeEpochManifest(args: {
  modelRevision: string;
  systemStable: string;
  toolDefinitions: ToolDefinition[];
  compatibility?: ProviderCompatibility;
  /** wire protocol("openai-chat"|"anthropic-messages"|...),由调用方从 ModelProfile.protocol 填充。 */
  toolProtocol?: string;
}): CacheEpochManifestV1 {
  const toolBundle = JSON.stringify(
    args.toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      effect: t.effect,
    })),
  );
  const compat = args.compatibility;
  return {
    schemaVersion: "cache-epoch.v1",
    modelRevision: args.modelRevision || "unknown",
    toolBundleHash: stableHash(toolBundle),
    systemHash: stableHash(args.systemStable),
    ...(compat?.thinkingFormat
      ? { chatTemplateHash: stableHash(compat.thinkingFormat), reasoningProtocol: compat.thinkingFormat }
      : {}),
    ...(args.toolProtocol ? { toolProtocol: args.toolProtocol } : {}),
    ...(compat?.cacheControl?.mode ? { cacheMode: compat.cacheControl.mode } : {}),
  };
}

/** 返回 prev→next 之间变化的字段名(用于 churn 诊断)。无变化返回空数组。 */
export function diffEpochs(prev: CacheEpochManifestV1, next: CacheEpochManifestV1): string[] {
  const fields = [
    "modelRevision",
    "chatTemplateHash",
    "toolBundleHash",
    "systemHash",
    "reasoningProtocol",
    "toolProtocol",
    "cacheMode",
  ] as const;
  return fields.filter((field) => prev[field] !== next[field]);
}
