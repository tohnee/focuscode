// @focuscode/sdk 快速入门示例
//
// 本示例使用 ScriptedDecisionPort（确定性回放），**无需 API Key** 即可运行。
// 真实场景把 `model.kind` 换成 `"openai-compatible"` 并提供 baseUrl + apiKey 即可。
//
// 运行方式（仓库根目录）：
//   pnpm build
//   node examples/sdk/quickstart.mjs
//
// 或安装发布包后：
//   npm install @focuscode/sdk
//   node quickstart.mjs

// 仓库内运行使用相对路径;外部用户改成 `from "@focuscode/sdk"`
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalHarness } from "../../packages/sdk/dist/index.js";

async function main() {
  // 1. 准备一个最小仓库（真实场景换成你的 repo 路径）
  const repoRoot = await mkdtemp(join(tmpdir(), "focuscode-quickstart-repo-"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "focuscode-quickstart-state-"));
  await mkdir(join(repoRoot, "src"), { recursive: true });
  await mkdir(join(repoRoot, ".focuscode"), { recursive: true });
  await writeFile(
    join(repoRoot, "package.json"),
    JSON.stringify({ name: "quickstart-demo", type: "module" }) + "\n",
  );
  // 故意写一个错误的 add 函数,让 SDK 修复
  await writeFile(
    join(repoRoot, "src", "math.js"),
    "export function add(a, b) { return a - b; }\n",
  );
  await writeFile(
    join(repoRoot, ".focuscode", "config.json"),
    JSON.stringify(
      {
        schemaVersion: "focuscode-repo.v1",
        protectedPaths: [".git", ".focuscode"],
        commands: [{ id: "test", argv: [process.execPath, "--test"], timeoutMs: 30_000 }],
        verificationCommandIds: ["test"],
      },
      null,
      2,
    ) + "\n",
  );

  console.log("[quickstart] repoRoot:", repoRoot);
  console.log("[quickstart] stateDirectory:", stateDirectory);

  // 2. 构造 Harness。这里用 scripted 模型,无需 API Key
  const harness = await createLocalHarness({
    repoRoot,
    stateDirectory,
    approvalMode: "auto-safe", // CI 友好;交互场景用 "prompt"
    trustRepoConfig: true, // 信任 .focuscode/config.json 中的 test 命令
    model: {
      kind: "scripted",
      steps: [
        {
          kind: "tool_intent_template",
          intents: [
            {
              toolId: "apply_edit_ir",
              arguments: {
                path: "src/math.js",
                edits: [{ search: "a - b", replace: "a + b", expectedOccurrences: 1 }],
              },
              expectedEffects: [
                { class: "file_write", resource: "src/math.js", description: "Fix operator" },
              ],
              justification: "Unique one-line repair",
            },
          ],
        },
        { kind: "completion_candidate", summary: "fixed", evidence: [], residualRisks: [] },
      ],
    },
  });

  // 3. 提交任务
  const result = await harness.run(
    {
      schemaVersion: "task-spec.v1",
      repoId: repoRoot,
      baseRef: "WORKTREE",
      mode: "change",
      objective: "Fix the add function",
      acceptanceCriteria: [{ id: "test", description: "Tests pass" }],
    },
    { taskId: `quickstart-${Date.now()}` },
  );

  // 4. 检查结果
  console.log("[quickstart] checkpoint.state:", result.checkpoint.state);
  console.log("[quickstart] verification.conclusion:", result.verification?.conclusion);
  console.log(
    "[quickstart] events:",
    result.events.map((e) => e.kind),
  );
  console.log("[quickstart] changedFiles:", harness.actions.ledgerSnapshot().changedFiles);

  const fixed = await readFile(join(repoRoot, "src", "math.js"), "utf8");
  console.log("[quickstart] src/math.js after run:", JSON.stringify(fixed));

  if (result.checkpoint.state !== "REVIEW_READY" || result.verification?.conclusion !== "PASS") {
    console.error("[quickstart] FAILED: expected REVIEW_READY + PASS");
    process.exit(2);
  }
  console.log("[quickstart] OK ✓");
}

main().catch((err) => {
  console.error("[quickstart] error:", err);
  process.exit(1);
});
