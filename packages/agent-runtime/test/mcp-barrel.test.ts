import { describe, expect, it } from "vitest";
import {
  McpPinMismatchError,
  McpStdioClient,
  closeAll,
  computeToolPin,
  registerMcpServers,
  verifyPins,
  type McpServerSpec,
  type McpToolPinV1,
} from "../src/index.js";

describe("MCP barrel export", () => {
  it("exposes McpStdioClient class", () => {
    expect(typeof McpStdioClient).toBe("function");
    const spec: McpServerSpec = { id: "x", command: "true" };
    const client = new McpStdioClient(spec);
    expect(client).toBeInstanceOf(McpStdioClient);
    expect(client.id).toBe("x");
  });

  it("exposes registerMcpServers and closeAll functions", () => {
    expect(typeof registerMcpServers).toBe("function");
    expect(typeof closeAll).toBe("function");
  });

  it("exposes computeToolPin and verifyPins functions", () => {
    expect(typeof computeToolPin).toBe("function");
    expect(typeof verifyPins).toBe("function");
  });

  it("exposes McpPinMismatchError class", () => {
    expect(typeof McpPinMismatchError).toBe("function");
    const error = new McpPinMismatchError("srv", "tool", "reason");
    expect(error).toBeInstanceOf(Error);
    expect(error.serverId).toBe("srv");
    expect(error.toolName).toBe("tool");
    expect(error.reason).toBe("reason");
  });

  it("McpToolPinV1 type is structurally compatible", () => {
    const pin: McpToolPinV1 = {
      serverId: "srv",
      serverVersion: "1.0.0",
      toolName: "echo",
      schemaDigest: "sha256:abc",
      transportDigest: "sha256:def",
    };
    expect(pin.serverId).toBe("srv");
    expect(pin.toolName).toBe("echo");
  });
});
