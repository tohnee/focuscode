// Cookbook 03: 注入自定义 FactPort（内存实现）
//
// 场景：企业集成需要把 Fact 事件流写入 Postgres/ Kafka，而非本地文件。
// 要点：通过 options.factStore 注入实现 FactPort 接口的对象。
//
// 运行：pnpm build && node examples/sdk/cookbook/03-custom-fact-store.mjs

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalHarness } from "../../../packages/sdk/dist/index.js";

/**
 * 内存 FactPort：把所有事件记录在内存数组中，供测试或转发到外部系统。
 * 生产场景可替换 append() 为 Postgres INSERT、loadEvents() 为 SELECT。
 */
class InMemoryFactPort {
  constructor() {
    this.events = new Map(); // taskId -> DomainEventV1[]
    this.checkpoints = new Map(); // taskId -> KernelCheckpointV1
  }

  async append(request) {
    const list = this.events.get(request.taskId) ?? [];
    const firstSeq = list.length;
    const committed = request.events.map((event, index) => ({
      ...event,
      seq: firstSeq + index,
      taskId: request.taskId,
      recordedAt: new Date().toISOString(),
    }));
    list.push(...committed);
    this.events.set(request.taskId, list);
    return { firstSeq, lastSeq: list.length - 1, events: committed };
  }

  async loadEvents(taskId, afterSeq = 0) {
    return (this.events.get(taskId) ?? []).filter((event) => event.seq > afterSeq);
  }

  async loadCheckpoint(taskId) {
    return this.checkpoints.get(taskId);
  }

  async saveCheckpoint(checkpoint) {
    this.checkpoints.set(checkpoint.taskId, checkpoint);
  }
}

async function main() {
  const repoRoot = await mkdtemp(join(tmpdir(), "cb03-repo-"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "cb03-state-"));
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

  const factStore = new InMemoryFactPort();

  const harness = await createLocalHarness({
    repoRoot,
    stateDirectory,
    approvalMode: "auto-safe",
    model: {
      kind: "scripted",
      steps: [{ kind: "completion_candidate", summary: "noop", evidence: [], residualRisks: [] }],
    },
    factStore, // ← 注入自定义 FactPort
  });

  // 验证注入生效
  if (harness.facts !== factStore) {
    console.error("[cb03] FAILED: harness.facts is not the injected instance");
    process.exit(2);
  }
  console.log("[cb03] Injected InMemoryFactPort wired into FocusKernel ✓");

  // 跑一个任务，观察事件被记录到内存
  await harness.run({
    schemaVersion: "task-spec.v1",
    repoId: "cb03",
    baseRef: "HEAD",
    mode: "explore",
    objective: "Test custom fact store",
    acceptanceCriteria: [{ id: "noop", description: "Noop" }],
  });

  const taskIds = [...factStore.events.keys()];
  console.log("[cb03] Recorded task IDs:", taskIds);
  for (const taskId of taskIds) {
    const events = factStore.events.get(taskId);
    console.log(
      `[cb03] Task ${taskId} events:`,
      events.map((e) => e.kind),
    );
  }
  console.log("[cb03] OK ✓  — custom FactPort captured all domain events in memory");
}

main().catch((err) => {
  console.error("[cb03] error:", err);
  process.exit(1);
});
