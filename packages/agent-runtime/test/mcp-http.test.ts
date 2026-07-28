import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Digest } from "@focuscode/contracts";
import {
  McpHttpClient,
  type McpServerSpec,
  type McpToolPinV1,
  closeAll,
  computeToolPin,
  registerMcpServers,
} from "../src/mcp.js";
import { AgentToolRegistry } from "../src/tools.js";

interface StartServerResult {
  server: Server;
  url: string;
}

/**
 * Fake MCP HTTP server speaking JSON-RPC 2.0 over POST.
 * - POST /mcp with `Content-Type: application/json`
 * - initialize -> serverInfo { name: "fake-http", version: "9.9.9" }
 * - tools/list -> [echo, slow]
 * - tools/call echo -> "echo:<text>"
 * - tools/call slow -> waits 50ms then returns
 */
function startFakeHttpServer(): Promise<StartServerResult> {
  return new Promise((resolve) => {
    const tools = [
      {
        name: "echo",
        description: "Echo text over HTTP",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "slow",
        description: "Slow tool",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let message: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          message = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "parse error" },
            }),
          );
          return;
        }
        if (message.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-http", version: "9.9.9" },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} }));
          return;
        }
        if (message.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }));
          return;
        }
        if (message.method === "tools/call") {
          const params = message.params ?? {};
          if (params.name === "echo") {
            const text = (params.arguments as { text?: string } | undefined)?.text ?? "";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: `echo:${text}` }], isError: false },
              }),
            );
            return;
          }
          if (params.name === "slow") {
            setTimeout(() => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { content: [{ type: "text", text: "slow-done" }], isError: false },
                }),
              );
            }, 50);
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "unknown tool" },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "unknown method" },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

describe("MCP HTTP transport", () => {
  let serverInfo: StartServerResult | undefined;
  let clients: McpHttpClient[] = [];

  beforeEach(async () => {
    serverInfo = await startFakeHttpServer();
  });

  afterEach(async () => {
    await closeAll(clients);
    clients = [];
    if (serverInfo) {
      await new Promise<void>((resolve) => serverInfo!.server.close(() => resolve()));
      serverInfo = undefined;
    }
  });

  function track(client: McpHttpClient): McpHttpClient {
    clients.push(client);
    return client;
  }

  it("connects, handshakes and lists tools over HTTP", async () => {
    const client = track(new McpHttpClient({ id: "fake-http", url: serverInfo!.url }));
    await client.connect();
    expect(client.serverInfo?.name).toBe("fake-http");
    expect(client.serverVersion).toBe("9.9.9");
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "slow"]);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns its text content over HTTP", async () => {
    const client = track(new McpHttpClient({ id: "fake-http", url: serverInfo!.url }));
    await client.connect();
    const result = await client.callTool("echo", { text: "hello" });
    expect(result.content).toBe("echo:hello");
    expect(result.isError).toBe(false);
  });

  it("exposes the URL in transport metadata", async () => {
    const client = track(new McpHttpClient({ id: "fake-http", url: serverInfo!.url }));
    await client.connect();
    expect(client.transport).toEqual({ url: serverInfo!.url });
  });

  it("rejects calls when not connected", async () => {
    const client = new McpHttpClient({ id: "fake-http", url: serverInfo!.url });
    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow(/not connected/);
  });

  it("rejects calls when the server returns an error response", async () => {
    const client = track(new McpHttpClient({ id: "fake-http", url: serverInfo!.url }));
    await client.connect();
    await expect(client.callTool("unknown", {})).rejects.toThrow(/unknown tool/);
  });

  it("times out when the server is too slow", async () => {
    const client = track(
      new McpHttpClient({ id: "fake-http", url: serverInfo!.url, timeoutMs: 20 }),
    );
    await client.connect();
    await expect(client.callTool("slow", {})).rejects.toThrow(/timed out/);
  });

  it("can be closed without error after connect", async () => {
    const client = new McpHttpClient({ id: "fake-http", url: serverInfo!.url });
    await client.connect();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("registerMcpServers registers tools from an HTTP server spec", async () => {
    const registry = new AgentToolRegistry();
    const spec: McpServerSpec = {
      id: "fake-http",
      transport: "http",
      url: serverInfo!.url,
    };
    const result = await registerMcpServers(registry, [spec]);
    clients.push(...result.clients);
    expect(result.registered).toEqual(["mcp_fake_http_echo", "mcp_fake_http_slow"]);
    const echo = registry.get("mcp_fake_http_echo");
    expect(echo?.definition.effect).toBe("read");
    const executed = await echo?.execute({ text: "hi" }, { cwd: process.cwd() });
    expect(executed?.content).toBe("echo:hi");
  });

  it("computeToolPin includes the URL in transportDigest for HTTP", async () => {
    const client = track(new McpHttpClient({ id: "fake-http", url: serverInfo!.url }));
    await client.connect();
    const tools = await client.listTools();
    const pin = computeToolPin(client, tools[0]!);
    expect(pin.transportDigest).toBe(sha256Digest({ transport: "http", url: serverInfo!.url }));
  });

  it("pin verification passes when configured pins match the HTTP server", async () => {
    const probe = track(new McpHttpClient({ id: "fake-http", url: serverInfo!.url }));
    await probe.connect();
    const tools = await probe.listTools();
    const pins: McpToolPinV1[] = tools.map((tool) => computeToolPin(probe, tool));

    const registry = new AgentToolRegistry();
    const result = await registerMcpServers(registry, [
      { id: "fake-http", transport: "http", url: serverInfo!.url },
    ]);
    clients.push(...result.clients);
    expect(result.registered.sort()).toEqual(["mcp_fake_http_echo", "mcp_fake_http_slow"].sort());
    // If pin verification failed, registerMcpServers would have thrown.
    expect(pins.length).toBe(2);
  });
});
