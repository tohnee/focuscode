// Cookbook 01: ScriptedDecisionPort 确定性测试
//
// 场景：CI/CD 中无需 API Key 即可验证 Harness 接线正确性。
// 要点：model.kind = "scripted" 回放预录制的决策序列；
//       注入 always-pass verifier 使 kernel 到达 REVIEW_READY。
//
// 运行：pnpm build && node examples/sdk/cookbook/01-scripted-harness.mjs

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalHarness } from "../../../packages/sdk/dist/index.js";

/** Minimal always-pass verifier for deterministic CI runs. */
const passVerifier = {
  async verify(request) {
    return {
      schemaVersion: "verification-report.v1",
      conclusion: "PASS",
      phase: request.phase,
      results: [],
      summary: "scripted pass",
    };
  },
};

async function main() {
  const repoRoot = await mkdtemp(join(tmpdir(), "cb01-repo-"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "cb01-state-"));
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
    approvalMode: "auto-safe",
    verifier: passVerifier,
    model: {
      kind: "scripted",
      steps: [
        // 第一轮：模型直接提出 completion_candidate，无工具调用
        { kind: "completion_candidate", summary: "nothing to do", evidence: [], residualRisks: [] },
      ],
    },
  });

  const result = await harness.run({
    schemaVersion: "task-spec.v1",
    repoId: "cb01",
    baseRef: "HEAD",
    mode: "explore",
    objective: "Inspect repository",
    acceptanceCriteria: [{ id: "noop", description: "No changes required" }],
  });

  console.log("[cb01] state:", result.checkpoint.state);
  console.log(
    "[cb01] events:",
    result.events.map((e) => e.kind),
  );

  if (result.checkpoint.state !== "REVIEW_READY") {
    console.error("[cb01] FAILED: expected REVIEW_READY");
    process.exit(2);
  }
  console.log("[cb01] OK ✓  — scripted harness drove kernel to REVIEW_READY without API key");
}

main().catch((err) => {
  console.error("[cb01] error:", err);
  process.exit(1);
});
