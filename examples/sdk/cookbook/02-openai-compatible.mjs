// Cookbook 02: 连接 OpenAI 兼容 Provider
//
// 场景：接入 Kimi/Qwen/GLM/DeepSeek/MiniMax/Ollama 等国产或自托管模型。
// 要点：model.kind = "openai-compatible"，提供 baseUrl + apiKey。
//
// 运行（需 API Key）：
//   FOCUSCODE_API_KEY=sk-xxx node examples/sdk/cookbook/02-openai-compatible.mjs
//
// 环境变量：
//   FOCUSCODE_BASE_URL  - Provider 的 OpenAI 兼容 endpoint（默认 Kimi）
//   FOCUSCODE_API_KEY   - API Key
//   FOCUSCODE_MODEL_ID  - 模型 ID（默认 moonshot-v1-8k）

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalHarness } from "../../../packages/sdk/dist/index.js";

async function main() {
  const baseUrl = process.env.FOCUSCODE_BASE_URL ?? "https://api.moonshot.cn/v1";
  const apiKey = process.env.FOCUSCODE_API_KEY;
  const modelId = process.env.FOCUSCODE_MODEL_ID ?? "moonshot-v1-8k";

  if (!apiKey) {
    console.error("[cb02] Set FOCUSCODE_API_KEY to run this cookbook.");
    process.exit(0); // Skip in CI without key
  }

  const repoRoot = await mkdtemp(join(tmpdir(), "cb02-repo-"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "cb02-state-"));
  await mkdir(join(repoRoot, ".focuscode"), { recursive: true });
  await writeFile(
    join(repoRoot, ".focuscode", "config.json"),
    JSON.stringify({
      schemaVersion: "focuscode-repo.v1",
      protectedPaths: [".git"],
      commands: [],
      verificationCommandIds: [],
    }) + "\n",
  );

  const harness = await createLocalHarness({
    repoRoot,
    stateDirectory,
    approvalMode: "prompt", // 交互式审批；CI 用 "deny" 或 "auto-safe"
    model: {
      kind: "openai-compatible",
      modelId,
      baseUrl,
      apiKey,
    },
  });

  console.log("[cb02] Connected to:", baseUrl);
  console.log("[cb02] Model:", modelId);
  console.log("[cb02] harness.profile.digest:", harness.profile.digest);
  console.log("[cb02] harness.model.modelId:", harness.model.modelId);
  console.log("[cb02] OK ✓  — openai-compatible harness constructed");
  console.log("[cb02] Next: call harness.run(taskSpec) to drive a real task");
}

main().catch((err) => {
  console.error("[cb02] error:", err);
  process.exit(1);
});
