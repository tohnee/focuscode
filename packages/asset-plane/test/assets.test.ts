import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type MemoryWriteProposalV1 } from "@focuscode/contracts";
import { FileFactStore } from "@focuscode/persistence";
import { createTestDirectory } from "@focuscode/testkit";
import { exportTaskAssets, FileMemoryStore } from "../src/index.js";

describe("enterprise asset plane", () => {
  it("keeps model memory as a proposal until an accountable acceptance", async () => {
    const root = await createTestDirectory("assets");
    const memory = new FileMemoryStore(root);
    const proposal: MemoryWriteProposalV1 = {
      schemaVersion: "memory-write-proposal.v1",
      proposalId: newId("proposal"),
      taskId: "asset-task",
      record: {
        schemaVersion: "memory-record.v1",
        memoryId: newId("memory"),
        kind: "repo_fact",
        subject: "repo:fixture",
        claim: { testCommand: "node --test" },
        provenance: ["task:asset-task"],
        confidence: "inferred",
        acl: ["repo-owner"],
        validFrom: "2026-07-19T00:00:00.000Z",
      },
      proposedBy: { id: "model", kind: "agent" },
      rationale: "Observed during preflight",
    };
    await memory.propose(proposal);
    expect(await memory.listRecords()).toEqual([]);
    await memory.accept(proposal.proposalId, "repo-owner");
    expect(await memory.listRecords()).toEqual([proposal.record]);

    const manifest = await exportTaskAssets({
      taskId: "asset-task",
      facts: new FileFactStore(root),
      memory,
      outputDirectory: join(root, "export"),
      now: () => new Date("2026-07-19T00:00:00.000Z"),
    });
    expect(manifest.portable).toBe(true);
    expect(manifest.files.find((file) => file.path === "memory.jsonl")?.records).toBe(1);
    expect(manifest.excluded).toContain("hidden reasoning");
  });
});
