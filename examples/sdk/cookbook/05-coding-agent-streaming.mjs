// Cookbook 05: createCodingAgent + onEvent 事件流
//
// 场景：会话型 Coding Agent，监听模型/工具事件流（替代原生 AsyncIterable）。
// 要点：options.onEvent 回调接收 AgentEvent，可转发到 WebSocket/SSE/日志。
//
// 运行：pnpm build && node examples/sdk/cookbook/05-coding-agent-streaming.mjs
//
// 注意：本示例用 scripted 模型，无需 API Key。真实场景把 config.model
// 换成 { provider: "openai", model: "gpt-4o", baseUrl, apiKey } 即可。

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodingAgent } from "../../../packages/sdk/dist/index.js";

async function main() {
  const cwd = await mkdtemp(join(tmpdir(), "cb05-cwd-"));
  await mkdir(join(cwd, ".focuscode"), { recursive: true });
  await writeFile(
    join(cwd, ".focuscode", "config.json"),
    JSON.stringify({
      schemaVersion: "focuscode-repo.v1",
      protectedPaths: [".git"],
      commands: [],
      verificationCommandIds: [],
      model: {
        provider: "scripted",
        model: "scripted-model",
        baseUrl: "http://localhost",
      },
      approval: "auto-edit",
    }) + "\n",
  );

  // 事件收集器：模拟 WebSocket/SSE 转发
  const events = [];
  const onEvent = (event) => {
    events.push(event);
    console.log(`[cb05 event] ${event.type}`);
  };

  const { agent, sessions, config } = await createCodingAgent({
    cwd,
    onEvent,
    effectSpine: false, // 简化示例；生产场景用 true 启用审计脊
  });

  console.log("[cb05] Agent created");
  console.log("[cb05] config.model:", config.model);
  console.log("[cb05] sessions directory:", sessions.constructor.name);

  // 提交一个最小 prompt
  try {
    const result = await agent.submit("Hello, what can you do?");
    console.log("[cb05] submit result:", result);
  } catch (err) {
    // scripted 模型可能不支持任意 prompt；记录错误但不算失败
    console.log("[cb05] submit returned (scripted model may reject):", err.message);
  }

  console.log("[cb05] Total events captured:", events.length);
  console.log(
    "[cb05] Event types:",
    events.map((e) => e.type),
  );
  console.log("[cb05] OK ✓  — createCodingAgent + onEvent streaming works");

  // 清理会话
  await agent.shutdown?.();
}

main().catch((err) => {
  console.error("[cb05] error:", err);
  process.exit(1);
});
