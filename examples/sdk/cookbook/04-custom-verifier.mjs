// Cookbook 04: 注入自定义 VerifyPort（自定义验收逻辑）
//
// 场景：项目用自定义测试框架（如 pytest、maven、gradle）而非默认的
// RegisteredCommandVerifier，或需要把验证结果聚合到外部 SRE 面板。
// 要点：通过 options.verifier 注入实现 VerifyPort 接口的对象。
//
// 运行：pnpm build && node examples/sdk/cookbook/04-custom-verifier.mjs

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalHarness } from "../../../packages/sdk/dist/index.js";

/**
 * 自定义 Verifier：永远返回 PASS，并把每次调用记录到日志。
 * 生产场景可替换为：
 *   - 调用 pytest/maven/gradle 并解析退出码
 *   - 调用远程 SRE 验证服务
 *   - 聚合多个验收命令的结果
 */
class LoggingVerifier {
  constructor() {
    this.calls = [];
  }

  async verify(request) {
    this.calls.push({ phase: request.phase, at: new Date().toISOString() });
    console.log(`[cb04 verifier] verify() called for phase=${request.phase}`);

    return {
      schemaVersion: "verification-report.v1",
      conclusion: "PASS",
      phase: request.phase,
      results: [],
      summary: `Custom verifier: always pass (phase=${request.phase})`,
    };
  }
}

async function main() {
  const repoRoot = await mkdtemp(join(tmpdir(), "cb04-repo-"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "cb04-state-"));
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

  const verifier = new LoggingVerifier();

  const harness = await createLocalHarness({
    repoRoot,
    stateDirectory,
    approvalMode: "auto-safe",
    model: {
      kind: "scripted",
      steps: [{ kind: "completion_candidate", summary: "done", evidence: [], residualRisks: [] }],
    },
    verifier, // ← 注入自定义 VerifyPort
  });

  const result = await harness.run({
    schemaVersion: "task-spec.v1",
    repoId: "cb04",
    baseRef: "HEAD",
    mode: "change",
    objective: "Test custom verifier",
    acceptanceCriteria: [{ id: "custom", description: "Custom verifier returns PASS" }],
  });

  console.log("[cb04] verifier calls:", verifier.calls);
  console.log("[cb04] checkpoint.state:", result.checkpoint.state);
  console.log("[cb04] verification.conclusion:", result.verification?.conclusion);

  if (result.checkpoint.state !== "REVIEW_READY" || result.verification?.conclusion !== "PASS") {
    console.error("[cb04] FAILED: expected REVIEW_READY + PASS");
    process.exit(2);
  }
  console.log("[cb04] OK ✓  — custom verifier drove kernel to REVIEW_READY with PASS");
}

main().catch((err) => {
  console.error("[cb04] error:", err);
  process.exit(1);
});
