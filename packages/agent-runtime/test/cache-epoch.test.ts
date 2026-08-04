import { describe, expect, it } from "vitest";
import { computeEpochManifest, stableHash } from "../src/cache-epoch.js";
import type { ToolDefinition } from "../src/types.js";

describe("stableHash", () => {
  it("is deterministic and length-bounded", () => {
    const h1 = stableHash("stable system prompt");
    expect(h1).toBe(stableHash("stable system prompt"));
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).not.toBe(stableHash("stable system prompt "));
  });
});

describe("computeEpochManifest", () => {
  const tools: ToolDefinition[] = [
    { name: "read", label: "Read", description: "read file", parameters: { type: "object" }, effect: "read" },
  ];

  it("produces identical manifest for identical inputs", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    expect(a).toEqual(b);
  });

  it("changes toolBundleHash when tool schema changes", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: [...tools, { name: "write", label: "Write", description: "w", parameters: {}, effect: "write" }],
    });
    expect(a.toolBundleHash).not.toBe(b.toolBundleHash);
    expect(a.systemHash).toBe(b.systemHash);
  });

  it("changes systemHash when stable system changes", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({ modelRevision: "r1", systemStable: "S2", toolDefinitions: tools });
    expect(a.systemHash).not.toBe(b.systemHash);
  });
});
