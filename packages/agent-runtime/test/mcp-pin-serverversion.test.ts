import { describe, expect, it } from "vitest";
import {
  McpPinMismatchError,
  computeToolPin,
  verifyPins,
  type McpClient,
  type McpToolInfo,
  type McpToolPinV1,
} from "../src/mcp.js";

/**
 * Minimal in-memory {@link McpClient} for unit-testing pin digest logic
 * without spawning a real MCP server process. Only the fields touched by
 * `computeToolPin` / `verifyPins` are exercised; the transport methods are
 * never called and return benign no-ops.
 */
function fakeClient(overrides?: { id?: string; serverVersion?: string }): McpClient {
  const id = overrides?.id ?? "fake";
  const serverVersion = overrides?.serverVersion ?? "1.2.3";
  return {
    id,
    serverInfo: { name: "fake", version: serverVersion },
    serverVersion,
    serverLog: [],
    transport: { command: "x", args: [] },
    transportDigestPayload: { command: "x", args: [] },
    async connect() {},
    async listTools() {
      return [];
    },
    async callTool() {
      return { content: "", isError: false };
    },
    async close() {},
  };
}

const baseTool: McpToolInfo = {
  name: "echo",
  description: "Echo the provided text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  annotations: { readOnlyHint: true },
};

describe("MCP pin serverVersion and contract digest (P0-2)", () => {
  it("TC-P0-2-01: throws McpPinMismatchError when observed serverVersion differs from pin", () => {
    const client = fakeClient();
    const pin = computeToolPin(client, baseTool);
    const observed: McpToolPinV1 = { ...pin, serverVersion: "9.9.9" };
    expect(() => verifyPins([pin], [observed])).toThrow(McpPinMismatchError);
    expect(() => verifyPins([pin], [observed])).toThrow(/serverVersion changed/);
  });

  it("TC-P0-2-02: passes when observed serverVersion equals the pinned serverVersion", () => {
    const client = fakeClient();
    const pin = computeToolPin(client, baseTool);
    const observed: McpToolPinV1 = { ...pin };
    expect(() => verifyPins([pin], [observed])).not.toThrow();
  });

  it("TC-P0-2-03: changing annotations produces a different schemaDigest (pin mismatch)", () => {
    const client = fakeClient();
    const pin = computeToolPin(client, baseTool);
    const modified: McpToolInfo = {
      ...baseTool,
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    const observed = computeToolPin(client, modified);
    expect(pin.schemaDigest).not.toBe(observed.schemaDigest);
    expect(() => verifyPins([pin], [observed])).toThrow(/schemaDigest changed/);
  });

  it("TC-P0-2-04: changing description produces a different schemaDigest (pin mismatch)", () => {
    const client = fakeClient();
    const pin = computeToolPin(client, baseTool);
    const modified: McpToolInfo = { ...baseTool, description: "Different description" };
    const observed = computeToolPin(client, modified);
    expect(pin.schemaDigest).not.toBe(observed.schemaDigest);
    expect(() => verifyPins([pin], [observed])).toThrow(/schemaDigest changed/);
  });

  it("TC-P0-2-05: changing inputSchema produces a different schemaDigest (regression)", () => {
    const client = fakeClient();
    const pin = computeToolPin(client, baseTool);
    const modified: McpToolInfo = {
      ...baseTool,
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    };
    const observed = computeToolPin(client, modified);
    expect(pin.schemaDigest).not.toBe(observed.schemaDigest);
    expect(() => verifyPins([pin], [observed])).toThrow(/schemaDigest changed/);
  });

  it("TC-P0-2-06: changing tool name produces a different schemaDigest", () => {
    const client = fakeClient();
    const pin = computeToolPin(client, baseTool);
    const modified: McpToolInfo = { ...baseTool, name: "shout" };
    const observed = computeToolPin(client, modified);
    expect(pin.schemaDigest).not.toBe(observed.schemaDigest);
  });

  it("TC-P0-2-07: computing the digest for the same tool twice yields identical schemaDigest", () => {
    const client = fakeClient();
    // Minimal tool exercises undefined description/inputSchema/annotations handling.
    const minimalTool: McpToolInfo = { name: "echo" };
    const first = computeToolPin(client, minimalTool);
    const second = computeToolPin(client, { ...minimalTool });
    expect(second.schemaDigest).toBe(first.schemaDigest);
  });
});
