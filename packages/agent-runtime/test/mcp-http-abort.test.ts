import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpHttpClient, closeAll } from "../src/mcp.js";

interface ServerOptions {
  /** Delay for the `slow` tool response, in ms. Default 200. */
  slowDelayMs?: number;
  /** Delay for the `echo` tool response, in ms. Default 0 (immediate). */
  echoDelayMs?: number;
  /** If true, `notifications/initialized` never responds. Default false. */
  initializedHangs?: boolean;
}

interface StartServerResult {
  server: Server;
  url: string;
}

/**
 * Fake MCP HTTP server speaking JSON-RPC 2.0 over POST.
 * Configurable per-test via {@link ServerOptions}:
 *   - initialize -> serverInfo { name: "abort-fake", version: "1.0.0" }
 *   - notifications/initialized -> 202 (or never responds when initializedHangs)
 *   - tools/list -> [echo, slow]
 *   - tools/call echo -> "echo:<text>" (after echoDelayMs)
 *   - tools/call slow -> "slow-done" (after slowDelayMs)
 */
function startFakeHttpServer(options: ServerOptions = {}): Promise<StartServerResult> {
  const slowDelayMs = options.slowDelayMs ?? 200;
  const echoDelayMs = options.echoDelayMs ?? 0;
  const initializedHangs = options.initializedHangs ?? false;
  return new Promise((resolve) => {
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
                serverInfo: { name: "abort-fake", version: "1.0.0" },
              },
            }),
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          if (initializedHangs) {
            // Never respond — the request will time out.
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} }));
          return;
        }
        if (message.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [
                  {
                    name: "echo",
                    description: "Echo text",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                      required: ["text"],
                    },
                  },
                  {
                    name: "slow",
                    description: "Slow tool",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (message.method === "tools/call") {
          const params = message.params ?? {};
          if (params.name === "echo") {
            const text = (params.arguments as { text?: string } | undefined)?.text ?? "";
            const writeEcho = () => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    content: [{ type: "text", text: `echo:${text}` }],
                    isError: false,
                  },
                }),
              );
            };
            if (echoDelayMs > 0) setTimeout(writeEcho, echoDelayMs);
            else writeEcho();
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
            }, slowDelayMs);
            return;
          }
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

describe("MCP HTTP AbortController isolation (P1-4)", () => {
  let serverInfo: StartServerResult | undefined;
  let clients: McpHttpClient[] = [];

  afterEach(async () => {
    await closeAll(clients);
    clients = [];
    if (serverInfo) {
      // closeAllConnections ensures hanging requests (e.g. initializedHangs)
      // don't keep server.close() pending forever.
      serverInfo.server.closeAllConnections();
      await new Promise<void>((resolve) => serverInfo!.server.close(() => resolve()));
      serverInfo = undefined;
    }
  });

  /**
   * Start a fake server with the given options, track it for afterEach cleanup,
   * and return the URL.
   */
  async function startServer(options: ServerOptions = {}): Promise<string> {
    serverInfo = await startFakeHttpServer(options);
    return serverInfo.url;
  }

  function track(client: McpHttpClient): McpHttpClient {
    clients.push(client);
    return client;
  }

  it("TC-P1-4-01: a timed-out request does not cancel a concurrent request", async () => {
    // Stagger the requests so echo's timeout deadline is later than slow's:
    //   slow  starts at T=0    → times out at T=200ms
    //   echo  starts at T=50ms → responds at  T=230ms (50+180), times out at T=250ms (50+200)
    //
    // With the bug: slow's timeout at 200ms aborts the SHARED controller, which
    //   cancels the still-pending echo fetch immediately (echo would have
    //   responded at 230ms but never gets the chance).
    // With the fix: slow's timeout only aborts slow's per-request controller;
    //   echo survives and responds at 230ms, before its own 250ms deadline.
    const url = await startServer({ echoDelayMs: 180, slowDelayMs: 500 });
    const client = track(new McpHttpClient({ id: "abort-fake", url, timeoutMs: 200 }));
    await client.connect();
    const slowPromise = client.callTool("slow", {});
    // Stagger: start echo 50ms later so its timeout deadline (250ms) is after
    // slow's (200ms), giving it a window to survive slow's timeout.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const echoPromise = client.callTool("echo", { text: "concurrent" });
    await expect(slowPromise).rejects.toThrow(/timed out/);
    // The concurrent echo request must NOT have been cancelled by the slow timeout.
    const result = await echoPromise;
    expect(result.content).toBe("echo:concurrent");
  });

  it("TC-P1-4-02: after a request times out, subsequent requests still succeed", async () => {
    const url = await startServer();
    const client = track(new McpHttpClient({ id: "abort-fake", url, timeoutMs: 50 }));
    await client.connect();
    // First request times out.
    await expect(client.callTool("slow", {})).rejects.toThrow(/timed out/);
    // A subsequent request must still work — the controller is not permanently aborted.
    const result = await client.callTool("echo", { text: "after-timeout" });
    expect(result.content).toBe("echo:after-timeout");
  });

  it("TC-P1-4-03: close() cancels all in-flight requests", async () => {
    // Use a long timeout so the request is still pending when close() fires.
    const url = await startServer({ slowDelayMs: 1000 });
    const client = track(new McpHttpClient({ id: "abort-fake", url, timeoutMs: 5000 }));
    await client.connect();
    const slowPromise = client.callTool("slow", {});
    // Give the request time to reach the server before closing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();
    // The pending request must be rejected (cancelled by close).
    await expect(slowPromise).rejects.toThrow();
    // New requests after close must also fail.
    await expect(client.callTool("echo", { text: "after-close" })).rejects.toThrow();
  });

  it("TC-P1-4-04: connect() fails when notifications/initialized times out", async () => {
    const url = await startServer({ initializedHangs: true });
    const client = track(new McpHttpClient({ id: "abort-fake", url, timeoutMs: 50 }));
    // connect() must NOT return success when notifications/initialized times out.
    await expect(client.connect()).rejects.toThrow();
  });
});
