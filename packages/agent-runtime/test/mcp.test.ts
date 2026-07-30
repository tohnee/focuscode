import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Digest } from "@focuscode/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpPinMismatchError,
  McpStdioClient,
  closeAll,
  computeToolPin,
  registerMcpServers,
  verifyPins,
  type McpClient,
  type McpServerSpec,
  type McpToolPinV1,
} from "../src/mcp.js";
import { AgentToolRegistry } from "../src/tools.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

const spec: McpServerSpec = { id: "fake", command: process.execPath, args: [fixture] };

describe("MCP stdio client", () => {
  let clients: McpClient[] = [];

  afterEach(async () => {
    await closeAll(clients);
    clients = [];
  });

  function track(client: McpStdioClient): McpStdioClient {
    clients.push(client);
    return client;
  }

  it("connects, handshakes and lists tools", async () => {
    const client = track(new McpStdioClient(spec));
    await client.connect();
    expect(client.serverInfo?.name).toBe("fake");
    expect(client.serverVersion).toBe("1.2.3");
    expect(client.serverLog).toContain("fake-mcp-server listening");
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "boom"]);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns its text content", async () => {
    const client = track(new McpStdioClient(spec));
    await client.connect();
    const result = await client.callTool("echo", { text: "hello" });
    expect(result.content).toBe("echo:hello");
    expect(result.isError).toBe(false);
  });

  it("rejects pending and future calls when the server process dies", async () => {
    const client = track(new McpStdioClient(spec));
    await client.connect();
    await expect(client.callTool("boom", {})).rejects.toThrow(/exited/);
    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow();
  });

  it("registers tools with valid names and mapped effects", async () => {
    const registry = new AgentToolRegistry();
    const result = await registerMcpServers(registry, [spec]);
    clients.push(...result.clients);
    expect(result.registered).toEqual(["mcp_fake_echo", "mcp_fake_boom"]);
    for (const name of result.registered) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
    const echo = registry.get("mcp_fake_echo");
    const boom = registry.get("mcp_fake_boom");
    expect(echo?.definition.effect).toBe("read");
    expect(boom?.definition.effect).toBe("network");
    expect(echo?.definition.description.startsWith("[fake] ")).toBe(true);
    expect(echo?.definition.parameters).toMatchObject({ type: "object" });
    const executed = await echo?.execute({ text: "hi" }, { cwd: process.cwd() });
    expect(executed?.content).toBe("echo:hi");
    expect(executed?.isError).toBeUndefined();
  });

  it("passes registration when configured pins match the observed server", async () => {
    const probe = track(new McpStdioClient(spec));
    await probe.connect();
    const pins = (await probe.listTools()).map((tool) => computeToolPin(probe, tool));
    const registry = new AgentToolRegistry();
    const result = await registerMcpServers(registry, [spec], { pins });
    clients.push(...result.clients);
    expect(result.registered).toHaveLength(2);
  });

  it("throws McpPinMismatchError when a schema digest is tampered", async () => {
    const probe = track(new McpStdioClient(spec));
    await probe.connect();
    const pins = (await probe.listTools()).map((tool) => computeToolPin(probe, tool));
    const tampered = pins.map((pin) =>
      pin.toolName === "echo" ? { ...pin, schemaDigest: `sha256:${"0".repeat(64)}` } : pin,
    );
    const registry = new AgentToolRegistry();
    await expect(registerMcpServers(registry, [spec], { pins: tampered })).rejects.toThrow(
      McpPinMismatchError,
    );
  });

  it("verifyPins fails closed when an observed tool is missing", () => {
    const pin: McpToolPinV1 = {
      serverId: "fake",
      serverVersion: "1.2.3",
      toolName: "echo",
      schemaDigest: sha256Digest(null),
      transportDigest: sha256Digest({ command: "x", args: [] }),
    };
    expect(() => verifyPins([pin], [])).toThrow(McpPinMismatchError);
  });

  it("warns and skips when the server command does not exist", async () => {
    const warnings: string[] = [];
    const registry = new AgentToolRegistry();
    const result = await registerMcpServers(
      registry,
      [{ id: "missing", command: "definitely-not-a-real-command-xyz" }],
      { onWarning: (message) => warnings.push(message) },
    );
    expect(result.registered).toEqual([]);
    expect(result.clients).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MCP server missing unavailable");
  });

  it("P1-K: exactPins fails closed when an undeclared tool is observed", async () => {
    const probe = track(new McpStdioClient(spec));
    await probe.connect();
    const tools = await probe.listTools();
    // Declare pins for only "echo" — "boom" is observed but undeclared.
    const pins = [
      computeToolPin(
        probe,
        tools.find((t) => t.name === "echo")!,
      ),
    ];
    const registry = new AgentToolRegistry();
    await expect(registerMcpServers(registry, [spec], { pins, exactPins: true })).rejects.toThrow(
      McpPinMismatchError,
    );
  });

  it("P1-K: exactPins passes when observed tools exactly match declared pins", async () => {
    const probe = track(new McpStdioClient(spec));
    await probe.connect();
    const tools = await probe.listTools();
    // Declare pins for ALL observed tools — exact match.
    const pins = tools.map((tool) => computeToolPin(probe, tool));
    const registry = new AgentToolRegistry();
    const result = await registerMcpServers(registry, [spec], { pins, exactPins: true });
    clients.push(...result.clients);
    expect(result.registered).toHaveLength(2);
  });

  it("P1-K: without exactPins, undeclared tools are still registered (legacy behavior)", async () => {
    const probe = track(new McpStdioClient(spec));
    await probe.connect();
    const tools = await probe.listTools();
    // Declare a pin for only "echo" — "boom" is undeclared but should
    // still register because exactPins is not set (subset check only).
    const pins = [
      computeToolPin(
        probe,
        tools.find((t) => t.name === "echo")!,
      ),
    ];
    const registry = new AgentToolRegistry();
    const result = await registerMcpServers(registry, [spec], { pins });
    clients.push(...result.clients);
    expect(result.registered).toHaveLength(2);
  });
});
