/**
 * MCP (Model Context Protocol) runtime clients.
 *
 * Supports three transports:
 *   - **stdio** (default): newline-delimited JSON-RPC 2.0 over the child
 *     process stdin/stdout pipes. Content-Length header framing is NOT
 *     supported; a server speaking header framing surfaces its output as
 *     non-JSON lines in `serverLog` and the handshake will time out
 *     (fail closed).
 *   - **http**: request/response JSON-RPC 2.0 over HTTP POST. Each request
 *     is a single POST with `Content-Type: application/json`; the response
 *     body is the JSON-RPC envelope. Stateless servers only.
 *   - **sse**: not yet implemented; reserved for v0.6.0 streaming servers.
 *
 * `McpServerSpec` is declared locally: an equivalent type is being added to
 * config.ts by a parallel change. Keeping a structurally identical copy here
 * avoids modifying config.ts from this change; once the config type lands it
 * can be re-exported or unified without behavioral changes.
 *
 * `McpToolPinV1` mirrors the pin contract in @focuscode/protocols. The
 * agent-runtime package intentionally does not depend on the protocols
 * package (architecture boundary), so the shape is re-declared structurally
 * while digests reuse @focuscode/contracts' stable-stringify sha256 to stay
 * byte-compatible with pins computed elsewhere.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sha256Digest } from "@focuscode/contracts";
import type { AgentToolRegistry } from "./tools.js";
import type { AgentTool, ToolDefinition } from "./types.js";

export type McpTransportKind = "stdio" | "http";

export interface McpServerSpec {
  id: string;
  /**
   * Transport kind. Defaults to `"stdio"` for backward compatibility with
   * specs that only declare `command`/`args`.
   */
  transport?: McpTransportKind;
  /** stdio transport: command to spawn. Required when `transport === "stdio"` (or omitted). */
  command?: string;
  /** stdio transport: command arguments. */
  args?: string[];
  /** stdio transport: extra environment variables merged into the whitelisted child env. */
  env?: Record<string, string>;
  /** http transport: full URL to POST JSON-RPC requests to. Required when `transport === "http"`. */
  url?: string;
  /** http transport: extra HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpClientOptions extends McpServerSpec {
  timeoutMs?: number;
  startupTimeoutMs?: number;
}

export interface McpToolPinV1 {
  serverId: string;
  serverVersion: string;
  toolName: string;
  schemaDigest: string;
  transportDigest: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: string;
  isError: boolean;
}

/**
 * Common contract implemented by every MCP client (stdio, http, ...).
 * `closeAll`, `registerMcpServers`, and `computeToolPin` operate on this
 * interface so transports are interchangeable at the registry layer.
 */
export interface McpClient {
  readonly id: string;
  readonly serverInfo: { name?: string; version?: string } | undefined;
  readonly serverVersion: string;
  readonly serverLog: readonly string[];
  /** Transport metadata, exposed for diagnostics and pin computation. */
  readonly transport: unknown;
  /**
   * Stable payload hashed into `McpToolPinV1.transportDigest`. Each transport
   * returns its own shape (stdio: `{command,args}`, http: `{transport,url}`).
   * Existing stdio pins stay byte-compatible because the payload matches the
   * pre-interface behavior.
   */
  readonly transportDigestPayload: unknown;
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export class McpPinMismatchError extends Error {
  constructor(
    readonly serverId: string,
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`MCP pin mismatch for ${serverId}/${toolName}: ${reason}`);
    this.name = "McpPinMismatchError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const CHILD_ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

const MAX_SERVER_LOG_LINES = 20;
const MAX_TOOL_OUTPUT_CHARS = 40_000;
const MAX_TOOL_NAME_LENGTH = 63;

export class McpStdioClient implements McpClient {
  readonly id: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly specEnv: Record<string, string> | undefined;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private closePromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly logLines: string[] = [];
  private serverInfoValue: { name?: string; version?: string } | undefined;
  private capabilitiesValue: unknown;
  private exitError: Error | undefined;

  constructor(options: McpClientOptions) {
    this.id = options.id;
    if (!options.command) {
      throw new Error(`MCP stdio server "${options.id}" requires a command`);
    }
    this.command = options.command;
    this.args = options.args ?? [];
    this.specEnv = options.env;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  }

  get serverInfo(): { name?: string; version?: string } | undefined {
    return this.serverInfoValue;
  }

  get serverVersion(): string {
    return this.serverInfoValue?.version ?? "unknown";
  }

  get capabilities(): unknown {
    return this.capabilitiesValue;
  }

  get serverLog(): readonly string[] {
    return this.logLines;
  }

  get transport(): { command: string; args: string[] } {
    return { command: this.command, args: [...this.args] };
  }

  get transportDigestPayload(): unknown {
    // Byte-compatible with pre-interface pins: { command, args } only.
    return { command: this.command, args: [...this.args] };
  }

  async connect(): Promise<void> {
    if (this.child) throw new Error(`MCP server ${this.id} is already connected`);
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(this.specEnv),
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    this.closePromise = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.onStdout(String(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => this.onStderr(String(chunk)));
    child.once("error", (error) => this.onProcessFailure(error));
    child.once("close", (code, signal) =>
      this.onProcessFailure(
        new Error(`MCP server ${this.id} exited (code ${String(code)}, signal ${String(signal)})`),
      ),
    );
    try {
      const result = (await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "focuscode", version: "0.5.0" },
        },
        this.startupTimeoutMs,
      )) as { serverInfo?: { name?: string; version?: string }; capabilities?: unknown };
      this.serverInfoValue = result.serverInfo ?? {};
      this.capabilitiesValue = result.capabilities;
      this.notify("notifications/initialized");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list", {}, this.timeoutMs)) as
      { tools?: unknown } | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const parsed: McpToolInfo[] = [];
    for (const entry of tools) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (name.length === 0) continue;
      const info: McpToolInfo = { name };
      if (typeof record.description === "string") info.description = record.description;
      if (record.inputSchema && typeof record.inputSchema === "object") {
        info.inputSchema = record.inputSchema as Record<string, unknown>;
      }
      if (record.annotations && typeof record.annotations === "object") {
        info.annotations = record.annotations as Record<string, unknown>;
      }
      parsed.push(info);
    }
    return parsed;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, this.timeoutMs)) as
      { content?: unknown; isError?: unknown } | undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    const parts: string[] = [];
    for (const item of content) {
      const record = (item ?? {}) as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        parts.push(record.text);
      } else if (record.type === "resource") {
        const resource = record.resource as Record<string, unknown> | undefined;
        parts.push(
          resource && typeof resource.text === "string" ? resource.text : JSON.stringify(record),
        );
      } else {
        parts.push(JSON.stringify(record));
      }
    }
    return { content: parts.join("\n"), isError: result?.isError === true };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    this.onProcessFailure(this.exitError ?? new Error(`MCP server ${this.id} closed`));
    try {
      child.stdin.end();
    } catch {
      // The child may already be gone.
    }
    child.kill("SIGTERM");
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already be gone.
      }
    }, 1_000);
    killer.unref();
    await this.closePromise;
    clearTimeout(killer);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.exitError) {
      return Promise.reject(this.exitError ?? new Error(`MCP server ${this.id} is not connected`));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP server ${this.id} request "${method}" timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (params === undefined) this.send({ jsonrpc: "2.0", method });
    else this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.onProcessFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.appendLog(line);
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.appendLog(line);
      return;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.id !== "number") return; // Server notifications are ignored.
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    clearTimeout(pending.timer);
    const error = record.error as { message?: unknown } | undefined;
    if (error && typeof error === "object") {
      pending.reject(
        new Error(`MCP server ${this.id} error: ${String(error.message ?? "unknown")}`),
      );
    } else {
      pending.resolve(record.result);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    for (;;) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stderrBuffer.slice(0, newline).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line.length > 0) this.appendLog(line);
    }
  }

  private appendLog(line: string): void {
    this.logLines.push(line);
    while (this.logLines.length > MAX_SERVER_LOG_LINES) this.logLines.shift();
  }

  private onProcessFailure(error: Error): void {
    if (!this.exitError) this.exitError = error;
    const failure = this.exitError;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      this.pending.delete(id);
    }
  }
}

/**
 * MCP HTTP transport client.
 *
 * Each JSON-RPC 2.0 request is a single `POST` to `options.url` with
 * `Content-Type: application/json` and the configured `headers`. The
 * response body is the JSON-RPC envelope. No SSE streaming, no session
 * management — stateless request/response only. Suitable for servers that
 * don't need server-initiated notifications.
 *
 * Failure modes (all fail closed):
 *   - Non-2xx HTTP status: reject with `MCP server <id> HTTP <status>` error.
 *   - Network error: reject with the underlying fetch error.
 *   - Timeout: reject with `MCP server <id> request "<method>" timed out`.
 *   - JSON parse error: reject with `MCP server <id> returned non-JSON body`.
 */
export class McpHttpClient implements McpClient {
  readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly logLines: string[] = [];
  private serverInfoValue: { name?: string; version?: string } | undefined;
  private capabilitiesValue: unknown;
  private connected = false;
  private aborted = false;
  // Client-level signal aborted only by close(). Each request combines this
  // signal with its own per-request timeout controller (see request()), so a
  // single timeout cannot pollute concurrent or subsequent requests.
  private readonly closeController = new AbortController();

  constructor(options: McpClientOptions) {
    this.id = options.id;
    if (!options.url) {
      throw new Error(`MCP http server "${options.id}" requires a url`);
    }
    this.url = options.url;
    this.headers = { "Content-Type": "application/json", ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  }

  get serverInfo(): { name?: string; version?: string } | undefined {
    return this.serverInfoValue;
  }

  get serverVersion(): string {
    return this.serverInfoValue?.version ?? "unknown";
  }

  get capabilities(): unknown {
    return this.capabilitiesValue;
  }

  get serverLog(): readonly string[] {
    return this.logLines;
  }

  get transport(): { url: string } {
    return { url: this.url };
  }

  get transportDigestPayload(): unknown {
    return { transport: "http" as const, url: this.url };
  }

  async connect(): Promise<void> {
    if (this.connected) throw new Error(`MCP server ${this.id} is already connected`);
    if (this.aborted) throw new Error(`MCP server ${this.id} has been closed`);
    // Mark connected before issuing the initialize request: `request()` and
    // `callTool()` gate on this flag, and the handshake is a normal request.
    // If the handshake fails, `close()` resets the flag.
    this.connected = true;
    try {
      const result = (await this.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "focuscode", version: "0.5.0" },
        },
        this.startupTimeoutMs,
      )) as { serverInfo?: { name?: string; version?: string }; capabilities?: unknown };
      this.serverInfoValue = result.serverInfo ?? {};
      this.capabilitiesValue = result.capabilities;
      // notifications/initialized completes the handshake. A timeout or error
      // here means the connection is unhealthy, so let it propagate rather
      // than silently swallowing it and leaving the client in a broken state.
      await this.request("notifications/initialized", undefined, this.timeoutMs);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request("tools/list", {}, this.timeoutMs)) as
      { tools?: unknown } | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const parsed: McpToolInfo[] = [];
    for (const entry of tools) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (name.length === 0) continue;
      const info: McpToolInfo = { name };
      if (typeof record.description === "string") info.description = record.description;
      if (record.inputSchema && typeof record.inputSchema === "object") {
        info.inputSchema = record.inputSchema as Record<string, unknown>;
      }
      if (record.annotations && typeof record.annotations === "object") {
        info.annotations = record.annotations as Record<string, unknown>;
      }
      parsed.push(info);
    }
    return parsed;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, this.timeoutMs)) as
      { content?: unknown; isError?: unknown } | undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    const parts: string[] = [];
    for (const item of content) {
      const record = (item ?? {}) as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        parts.push(record.text);
      } else if (record.type === "resource") {
        const resource = record.resource as Record<string, unknown> | undefined;
        parts.push(
          resource && typeof resource.text === "string" ? resource.text : JSON.stringify(record),
        );
      } else {
        parts.push(JSON.stringify(record));
      }
    }
    return { content: parts.join("\n"), isError: result?.isError === true };
  }

  async close(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.connected = false;
    this.closeController.abort();
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.aborted || !this.connected) {
      throw new Error(`MCP server ${this.id} is not connected`);
    }
    const id = nextHttpRequestId();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    // Each request gets its own AbortController for timeout isolation. The
    // combined signal merges the per-request timeout with the client-level
    // close signal: close() cancels all in-flight requests, but a single
    // timeout only affects that one request — it never poisons the shared
    // close signal or subsequent requests.
    const requestController = new AbortController();
    const signal = AbortSignal.any([requestController.signal, this.closeController.signal]);
    const timer = setTimeout(() => {
      requestController.abort(new Error(`timeout ${method}`));
    }, timeoutMs);
    timer.unref();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body,
        signal,
      });
      if (!response.ok) {
        throw new Error(`MCP server ${this.id} HTTP ${String(response.status)}`);
      }
      const text = await response.text();
      let message: unknown;
      try {
        message = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        throw new Error(`MCP server ${this.id} returned non-JSON body`);
      }
      if (typeof message !== "object" || message === null) {
        throw new Error(`MCP server ${this.id} returned non-object body`);
      }
      const record = message as Record<string, unknown>;
      const error = record.error as { message?: unknown } | undefined;
      if (error && typeof error === "object") {
        throw new Error(`MCP server ${this.id} error: ${String(error.message ?? "unknown")}`);
      }
      return record.result;
    } catch (error) {
      // Distinguish per-request timeout from close()-driven abort: if the
      // request's own controller was aborted, the timer fired (timeout);
      // if the close controller was aborted, close() was called. Checking
      // individual controllers (instead of a shared one) is what keeps one
      // request's timeout from leaking into others.
      if (requestController.signal.aborted) {
        throw new Error(
          `MCP server ${this.id} request "${method}" timed out after ${String(timeoutMs)}ms`,
        );
      }
      if (this.closeController.signal.aborted) {
        throw new Error(`MCP server ${this.id} is not connected`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

let httpRequestIdCounter = 0;
function nextHttpRequestId(): number {
  httpRequestIdCounter = (httpRequestIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return httpRequestIdCounter;
}

function buildChildEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) env[key] = value;
  }
  return env;
}

/**
 * Deterministic digest of a tool's observable contract: name, description,
 * inputSchema and annotations. `stableStringify` (via {@link sha256Digest})
 * sorts object keys and drops `undefined` entries, so a tool that omits an
 * optional field hashes identically regardless of which keys are present.
 *
 * output schema is intentionally excluded: MCP `tools/list` does not expose an
 * output schema, so it cannot contribute a stable value.
 */
function computeToolContractDigest(tool: McpToolInfo): string {
  return sha256Digest({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  });
}

export function computeToolPin(client: McpClient, tool: McpToolInfo): McpToolPinV1 {
  return {
    serverId: client.id,
    serverVersion: client.serverVersion,
    toolName: tool.name,
    schemaDigest: computeToolContractDigest(tool),
    transportDigest: sha256Digest(client.transportDigestPayload),
  };
}

export function verifyPins(pins: readonly McpToolPinV1[], observed: readonly McpToolPinV1[]): void {
  for (const pin of pins) {
    const match = observed.find(
      (entry) => entry.serverId === pin.serverId && entry.toolName === pin.toolName,
    );
    if (!match) {
      throw new McpPinMismatchError(
        pin.serverId,
        pin.toolName,
        "tool not observed on the connected server (fail closed)",
      );
    }
    if (pin.serverVersion && match.serverVersion !== pin.serverVersion) {
      throw new McpPinMismatchError(pin.serverId, pin.toolName, "serverVersion changed");
    }
    if (match.schemaDigest !== pin.schemaDigest) {
      throw new McpPinMismatchError(pin.serverId, pin.toolName, "schemaDigest changed");
    }
    if (match.transportDigest !== pin.transportDigest) {
      throw new McpPinMismatchError(pin.serverId, pin.toolName, "transportDigest changed");
    }
  }
}

export interface RegisterMcpOptions {
  pins?: readonly McpToolPinV1[];
  connectTimeoutMs?: number;
  onWarning?: (message: string) => void;
  /**
   * P1-K: when true, the observed tool set must EXACTLY match the declared
   * pins — any extra tool the server advertises (e.g. after an upgrade or
   * compromise) causes a fail-closed error instead of being silently
   * registered. Enterprise deployments should set this to true.
   */
  exactPins?: boolean;
}

export interface RegisterMcpResult {
  clients: McpClient[];
  registered: string[];
}

export async function registerMcpServers(
  registry: AgentToolRegistry,
  servers: readonly McpServerSpec[],
  options: RegisterMcpOptions = {},
): Promise<RegisterMcpResult> {
  const clients: McpClient[] = [];
  const registered: string[] = [];
  const connected: Array<{ client: McpClient; tools: McpToolInfo[] }> = [];
  const observedPins: McpToolPinV1[] = [];
  for (const spec of servers) {
    if (spec.disabled) continue;
    const clientOptions: McpClientOptions = { ...spec };
    if (options.connectTimeoutMs !== undefined) {
      clientOptions.startupTimeoutMs = options.connectTimeoutMs;
    }
    const client = createMcpClient(clientOptions);
    try {
      await client.connect();
      const tools = await client.listTools();
      clients.push(client);
      connected.push({ client, tools });
      for (const tool of tools) observedPins.push(computeToolPin(client, tool));
    } catch (error) {
      options.onWarning?.(`MCP server ${spec.id} unavailable: ${errorMessage(error)}`);
      await client.close().catch(() => undefined);
    }
  }
  if (options.pins) {
    try {
      verifyPins(options.pins, observedPins);
      // P1-K: exact allowlist — when exactPins is set, every observed tool
      // must be declared in the pins. A server that advertises an extra
      // tool (after upgrade or compromise) fails closed instead of being
      // silently registered. This closes the gap where pins were a subset
      // check: declared pins had to exist, but undeclared tools were free
      // to enter the registry.
      if (options.exactPins) {
        for (const observed of observedPins) {
          const declared = options.pins.some(
            (pin) => pin.serverId === observed.serverId && pin.toolName === observed.toolName,
          );
          if (!declared) {
            throw new McpPinMismatchError(
              observed.serverId,
              observed.toolName,
              "tool is observed but not declared in the exact allowlist (fail closed)",
            );
          }
        }
      }
    } catch (error) {
      await closeAll(clients);
      throw error;
    }
  }
  const taken = new Set(registry.definitions().map((definition) => definition.name));
  for (const { client, tools } of connected) {
    for (const tool of tools) {
      const name = mcpToolName(client.id, tool.name, taken);
      taken.add(name);
      registry.register(buildAgentTool(client, tool, name));
      registered.push(name);
    }
  }
  return { clients, registered };
}

/**
 * Dispatch a {@link McpServerSpec} to the right client implementation based
 * on `spec.transport`. Defaults to `"stdio"` for backward compatibility.
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const transport = options.transport ?? "stdio";
  if (transport === "http") return new McpHttpClient(options);
  if (transport === "stdio") return new McpStdioClient(options);
  // exhaustiveness check — TypeScript narrows here to `never` when both
  // cases above cover McpTransportKind.
  throw new Error(`MCP server "${options.id}" has unsupported transport: ${String(transport)}`);
}

export async function closeAll(clients: readonly McpClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
}

function buildAgentTool(client: McpClient, tool: McpToolInfo, name: string): AgentTool {
  const definition: ToolDefinition = {
    name,
    label: `${client.id}:${tool.name}`,
    description: `[${client.id}] ${tool.description ?? tool.name}`,
    parameters: tool.inputSchema ?? { type: "object" },
    effect: effectOf(tool),
  };
  return {
    definition,
    async execute(args) {
      try {
        const result = await client.callTool(tool.name, args);
        const content =
          result.content.length > MAX_TOOL_OUTPUT_CHARS
            ? `${result.content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n... [truncated to ${MAX_TOOL_OUTPUT_CHARS} characters]`
            : result.content;
        return {
          content: content || "(no content)",
          ...(result.isError ? { isError: true } : {}),
          metadata: { server: client.id, tool: tool.name },
        };
      } catch (error) {
        return {
          content: `MCP tool ${tool.name} failed: ${errorMessage(error)}`,
          isError: true,
          metadata: { server: client.id, tool: tool.name },
        };
      }
    },
  };
}

function effectOf(tool: McpToolInfo): ToolDefinition["effect"] {
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === true) return "read";
  if (annotations.destructiveHint === true) return "write";
  return "network";
}

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function mcpToolName(serverId: string, toolName: string, taken: ReadonlySet<string>): string {
  // The "mcp_" prefix guarantees the name starts with a letter.
  const base = `mcp_${sanitizeSegment(serverId)}_${sanitizeSegment(toolName)}`;
  const candidate = base.slice(0, MAX_TOOL_NAME_LENGTH);
  if (!taken.has(candidate)) return candidate;
  const suffix = sha256Digest(base).slice("sha256:".length, "sha256:".length + 8);
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
