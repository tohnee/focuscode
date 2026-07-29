import { describe, expect, it } from "vitest";
import { createSdkMcpServer, type McpSdkToolHandler } from "../src/mcp-sdk-server.js";

describe("in-process MCP server", () => {
  it("createSdkMcpServer returns a server with listTools and callTool", async () => {
    const handler: McpSdkToolHandler = {
      name: "greet",
      description: "Greet someone",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      async execute(args) {
        return `Hello, ${args.name}!`;
      },
    };
    const server = createSdkMcpServer({ id: "test", tools: [handler] });
    const tools = await server.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("greet");
    const result = await server.callTool("greet", { name: "world" });
    expect(result.content).toBe("Hello, world!");
    expect(result.isError).toBe(false);
  });

  it("callTool returns error for unknown tool", async () => {
    const server = createSdkMcpServer({ id: "test", tools: [] });
    const result = await server.callTool("unknown", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown");
  });

  it("callTool handles handler errors gracefully", async () => {
    const handler: McpSdkToolHandler = {
      name: "fail",
      async execute() {
        throw new Error("handler failed");
      },
    };
    const server = createSdkMcpServer({ id: "test", tools: [handler] });
    const result = await server.callTool("fail", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("handler failed");
  });

  it("server exposes transport metadata for pin computation", () => {
    const handler: McpSdkToolHandler = {
      name: "test",
      async execute() {
        return "ok";
      },
    };
    const server = createSdkMcpServer({ id: "test", tools: [handler] });
    expect(server.transport).toEqual({ transport: "in-process", id: "test" });
  });
});
