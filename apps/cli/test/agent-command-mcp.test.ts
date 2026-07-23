import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentToolRegistry,
  McpPinMismatchError,
  McpStdioClient,
  closeAll,
  computeToolPin,
  type McpServerSpec,
} from "@focuscode/agent-runtime";
import { wireMcpServers, type WiredMcpHandle } from "../src/mcp-wiring.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

const spec: McpServerSpec = { id: "fake", command: process.execPath, args: [fixture] };

describe("wireMcpServers — CLI MCP composition root", () => {
  let handles: WiredMcpHandle[] = [];

  afterEach(async () => {
    for (const handle of handles) await handle.close();
    handles = [];
  });

  function track(handle: WiredMcpHandle): WiredMcpHandle {
    handles.push(handle);
    return handle;
  }

  it("registers MCP tools into the registry when servers are healthy", async () => {
    const registry = new AgentToolRegistry();
    const handle = track(
      await wireMcpServers({
        registry,
        servers: [spec],
        pins: [],
        onWarning: () => undefined,
      }),
    );
    expect(handle.registered).toEqual(["mcp_fake_echo", "mcp_fake_boom"]);
    expect(registry.get("mcp_fake_echo")).toBeDefined();
    expect(registry.get("mcp_fake_boom")).toBeDefined();
    expect(handle.clients.length).toBe(1);
  });

  it("returns an empty handle when no servers are configured", async () => {
    const registry = new AgentToolRegistry();
    const handle = track(
      await wireMcpServers({ registry, servers: [], pins: [], onWarning: () => undefined }),
    );
    expect(handle.registered).toEqual([]);
    expect(handle.clients).toEqual([]);
    expect(registry.definitions()).toEqual([]);
  });

  it("skips servers with disabled: true", async () => {
    const registry = new AgentToolRegistry();
    const handle = track(
      await wireMcpServers({
        registry,
        servers: [{ ...spec, disabled: true }],
        pins: [],
        onWarning: () => undefined,
      }),
    );
    expect(handle.registered).toEqual([]);
    expect(handle.clients).toEqual([]);
    expect(registry.definitions()).toEqual([]);
  });

  it("fails closed (throws McpPinMismatchError) when a pin does not match", async () => {
    const registry = new AgentToolRegistry();
    const probe = new McpStdioClient(spec);
    await probe.connect();
    const pins = (await probe.listTools()).map((tool) => computeToolPin(probe, tool));
    await probe.close();
    const tampered = pins.map((pin) =>
      pin.toolName === "echo" ? { ...pin, schemaDigest: `sha256:${"0".repeat(64)}` } : pin,
    );
    await expect(
      wireMcpServers({
        registry,
        servers: [spec],
        pins: tampered,
        onWarning: () => undefined,
      }),
    ).rejects.toThrow(McpPinMismatchError);
    // Fail-closed: no tools should remain registered after a pin mismatch.
    expect(registry.definitions().filter((d) => d.name.startsWith("mcp_"))).toEqual([]);
  });

  it("passes pin verification when pins match the observed server", async () => {
    const registry = new AgentToolRegistry();
    const probe = new McpStdioClient(spec);
    await probe.connect();
    const pins = (await probe.listTools()).map((tool) => computeToolPin(probe, tool));
    await probe.close();
    const handle = track(
      await wireMcpServers({
        registry,
        servers: [spec],
        pins,
        onWarning: () => undefined,
      }),
    );
    expect(handle.registered).toHaveLength(2);
  });

  it("forwards onWarning when a server command is missing", async () => {
    const registry = new AgentToolRegistry();
    const warnings: string[] = [];
    const handle = track(
      await wireMcpServers({
        registry,
        servers: [{ id: "missing", command: "definitely-not-a-real-command-xyz" }],
        pins: [],
        onWarning: (message) => warnings.push(message),
      }),
    );
    expect(handle.registered).toEqual([]);
    expect(handle.clients).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MCP server missing unavailable");
  });

  it("close() disposes tracked MCP clients", async () => {
    const registry = new AgentToolRegistry();
    const handle = await wireMcpServers({
      registry,
      servers: [spec],
      pins: [],
      onWarning: () => undefined,
    });
    expect(handle.clients.length).toBe(1);
    const clientRef = handle.clients[0]!;
    await handle.close();
    // After close, calling close again on the client should not throw
    // (closeAll is idempotent). The handle is already disposed.
    await expect(closeAll(handle.clients)).resolves.toBeUndefined();
    expect(clientRef.serverInfo).toBeDefined();
  });
});
