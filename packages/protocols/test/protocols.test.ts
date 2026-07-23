import { describe, expect, it } from "vitest";
import { sha256Digest } from "@focuscode/contracts";
import {
  McpSchemaChangedError,
  assertMcpToolPin,
  assertReadOnlyDelegation,
  classifyNativeCapsule,
  negotiateAcpCapabilities,
} from "../src/index.js";

describe("protocol anti-corruption boundaries", () => {
  it("downgrades ACP when fine approval/checkpoint are unavailable", () => {
    const result = negotiateAcpCapabilities(
      {
        protocolVersion: "1",
        events: true,
        diff: true,
        approval: "coarse",
        cancel: true,
        checkpoint: false,
      },
      {
        protocolVersion: "1",
        events: true,
        diff: true,
        approval: "fine",
        cancel: true,
        checkpoint: true,
      },
    );
    expect(result.safeMode).toBe("read-only");
    expect(result.disabled.map((item) => item.capability)).toContain("fine-approval");
  });

  it("detects MCP schema rug-pulls", () => {
    const digest = sha256Digest("transport");
    const expected = {
      serverId: "server",
      serverVersion: "1",
      toolName: "search",
      schemaDigest: sha256Digest("schema-v1"),
      transportDigest: digest,
    };
    expect(() => assertMcpToolPin(expected, expected)).not.toThrow();
    expect(() =>
      assertMcpToolPin(expected, { ...expected, schemaDigest: sha256Digest("schema-v2") }),
    ).toThrow(McpSchemaChangedError);
  });

  it("rejects writable A2A delegation and classifies capsule trust", () => {
    expect(() =>
      assertReadOnlyDelegation({
        schemaVersion: "delegation-spec.v1",
        delegationId: "d1",
        objective: "review",
        inputs: [],
        allowedData: ["source"],
        allowedCapabilities: ["repo.write"],
        outputSchemaDigest: sha256Digest("output"),
        maxTurns: 2,
        deadline: "2026-07-19T01:00:00.000Z",
        maxDelegationDepth: 1,
      }),
    ).toThrow(/write capabilities/);
    expect(
      classifyNativeCapsule({
        capsuleId: "unsafe",
        interceptsAllTools: false,
        exportsTypedEvents: false,
        supportsCancel: false,
        supportsCheckpoint: false,
        confinesNetworkAndFiles: false,
      }),
    ).toBe("C3");
  });
});
