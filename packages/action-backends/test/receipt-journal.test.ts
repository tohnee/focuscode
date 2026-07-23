import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "@focuscode/action-domain";
import type { EffectReceiptV1 } from "@focuscode/contracts";
import { fixtureExecution, fixtureModel, createTestDirectory } from "@focuscode/testkit";
import {
  FileReceiptJournal,
  LocalActionRuntime,
  SafeCommandRunner,
  WorkspaceGuard,
  createLocalToolRegistry,
} from "../src/index.js";

function receiptFixture(actionId: string): EffectReceiptV1 {
  return {
    schemaVersion: "effect-receipt.v1",
    actionId,
    grantId: `grant-${actionId}`,
    status: "applied",
    observedEffects: [],
    artifacts: [],
    reconciliation: "matched",
    message: '"ok"',
  };
}

describe("FileReceiptJournal", () => {
  it("round-trips appended receipts in order", async () => {
    const root = await createTestDirectory("journal-roundtrip");
    const journal = new FileReceiptJournal(join(root, "receipts.jsonl"));
    await journal.append(receiptFixture("a1"));
    await journal.append(receiptFixture("a2"));
    await journal.append(receiptFixture("a3"));
    const loaded = await journal.load();
    expect(loaded.map((receipt) => receipt.actionId)).toEqual(["a1", "a2", "a3"]);
  });

  it("returns an empty list for a missing journal file", async () => {
    const root = await createTestDirectory("journal-missing");
    const journal = new FileReceiptJournal(join(root, "absent.jsonl"));
    expect(await journal.load()).toEqual([]);
  });

  it("tolerates a torn tail from a crash mid-append", async () => {
    const root = await createTestDirectory("journal-torn");
    const path = join(root, "receipts.jsonl");
    const journal = new FileReceiptJournal(path);
    await journal.append(receiptFixture("good"));
    // Simulate a crash that left a partial final line.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, '{"schemaVersion":"effect-recei', "utf8");
    const loaded = await journal.load();
    expect(loaded.map((receipt) => receipt.actionId)).toEqual(["good"]);
  });

  it("fails closed on a corrupt line that is not the final line", async () => {
    const root = await createTestDirectory("journal-corrupt");
    const path = join(root, "receipts.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(receiptFixture("first"))}\nnot-json\n${JSON.stringify(receiptFixture("third"))}\n`,
      "utf8",
    );
    const journal = new FileReceiptJournal(path);
    await expect(journal.load()).rejects.toThrow(/Corrupt receipt journal line 2/);
  });
});

describe("LocalActionRuntime receipt journal", () => {
  it("journals a receipt before returning it (receipt-before-result)", async () => {
    const root = await createTestDirectory("journal-runtime");
    const workspace = await WorkspaceGuard.create(root);
    const registry = createLocalToolRegistry(workspace, new SafeCommandRunner([], { cwd: root }));
    const journal = new FileReceiptJournal(join(root, "receipts.jsonl"));
    const runtime = new LocalActionRuntime(
      registry,
      new PolicyEngine({
        protectedPaths: [],
        maxChangedFiles: 10,
        maxChangedLines: 100,
        maxRiskScore: 50,
        allowNetwork: false,
        allowSecrets: false,
        autoGrantRegisteredCommands: false,
        autoGrantSafeWrites: true,
      }),
      {
        async request() {
          return true;
        },
      },
      undefined,
      journal,
    );
    const spec = registry.get("read_file_range")!.spec;
    const context = { execution: fixtureExecution(), model: fixtureModel(), workerId: "test" };
    const [receipt] = await runtime.submit(
      [
        {
          schemaVersion: "action-intent.v1",
          actionId: "journaled-read",
          taskId: "fixture-task",
          tool: { id: spec.id, version: spec.version, schemaDigest: spec.schemaDigest },
          arguments: { path: "missing.txt", startLine: 1, endLine: 1 },
          expectedEffects: [{ class: "read", resource: "missing.txt", description: "Read" }],
          justification: "fixture",
        },
      ],
      context,
    );
    // Even a failed tool call produces a (rejected) receipt that must be durable.
    expect(receipt).toBeDefined();
    const persisted = JSON.parse(
      (await readFile(join(root, "receipts.jsonl"), "utf8")).trim().split("\n")[0]!,
    ) as EffectReceiptV1;
    expect(persisted.actionId).toBe("journaled-read");
    expect(await runtime.journalReceipts()).toHaveLength(1);
  });

  it("returns no journal receipts when no journal is injected", async () => {
    const root = await createTestDirectory("journal-none");
    const workspace = await WorkspaceGuard.create(root);
    const registry = createLocalToolRegistry(workspace, new SafeCommandRunner([], { cwd: root }));
    const runtime = new LocalActionRuntime(
      registry,
      new PolicyEngine({
        protectedPaths: [],
        maxChangedFiles: 10,
        maxChangedLines: 100,
        maxRiskScore: 50,
        allowNetwork: false,
        allowSecrets: false,
        autoGrantRegisteredCommands: false,
        autoGrantSafeWrites: true,
      }),
      {
        async request() {
          return true;
        },
      },
    );
    expect(await runtime.journalReceipts()).toEqual([]);
  });
});
