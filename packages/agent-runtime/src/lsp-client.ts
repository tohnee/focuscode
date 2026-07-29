/**
 * LSP (Language Server Protocol) stdio client.
 *
 * Speaks JSON-RPC 2.0 over stdio with Content-Length header framing,
 * matching the LSP base protocol spec — NOT the newline-delimited
 * framing used by MCP. This is the key transport difference: LSP messages
 * are framed as:
 *
 *   Content-Length: <n>\r\n
 *   \r\n
 *   <n bytes of UTF-8 JSON>
 *
 * The client is fail-quiet: any handshake or transport failure resolves
 * `connect()` to `false` so the diagnostic provider can fall back to the
 * spawn-based provider. Runtime errors after a successful connect are
 * propagated via the pending-request rejection path.
 *
 * Architecture boundary: this module does not depend on any other
 * @focuscode/* package. It only uses node:child_process and node:buffer.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LspClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  startupTimeoutMs?: number;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

export interface LspDidOpenParams {
  uri: string;
  languageId: string;
  text: string;
}

export interface LspDidChangeParams {
  uri: string;
  languageId: string;
  text: string;
  version: number;
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

const DIAGNOSTICS_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

export class LspClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly specEnv: Record<string, string> | undefined;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private closePromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = Buffer.alloc(0);
  private serverCapabilitiesValue: unknown;
  private serverInfoValue: { name?: string; version?: string } | undefined;
  private exitError: Error | undefined;
  private readonly diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticsWaiters = new Map<string, Array<(diags: LspDiagnostic[]) => void>>();

  constructor(options: LspClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.specEnv = options.env;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  get serverCapabilities(): unknown {
    return this.serverCapabilitiesValue;
  }

  get serverInfo(): { name?: string; version?: string } | undefined {
    return this.serverInfoValue;
  }

  get connected(): boolean {
    return this.child !== undefined && this.exitError === undefined;
  }

  /**
   * Performs the LSP initialize handshake. Resolves to `true` on success,
   * `false` on any failure (fail-quiet) so the diagnostic provider can
   * fall back to spawn-based providers.
   */
  async connect(): Promise<boolean> {
    if (this.child) throw new Error("LSP client is already connected");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(this.specEnv),
        ...(this.cwd ? { cwd: this.cwd } : {}),
        shell: false,
        windowsHide: true,
      });
    } catch {
      return false;
    }
    this.child = child;
    this.closePromise = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // LSP servers log to stderr; we ignore these for fail-quiet semantics.
    });
    child.once("error", (error) => this.onProcessFailure(error));
    child.once("close", (code, signal) =>
      this.onProcessFailure(
        new Error(`LSP server exited (code ${String(code)}, signal ${String(signal)})`),
      ),
    );
    try {
      const result = (await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: null,
          capabilities: {},
        },
        this.startupTimeoutMs,
      )) as { capabilities?: unknown; serverInfo?: { name?: string; version?: string } };
      this.serverCapabilitiesValue = result?.capabilities;
      this.serverInfoValue = result?.serverInfo ?? {};
      this.notify("initialized");
      return true;
    } catch {
      await this.close();
      return false;
    }
  }

  /**
   * Sends a textDocument/didOpen notification. The server will push
   * diagnostics via textDocument/publishDiagnostics; use `diagnostics(uri)`
   * to await them.
   */
  async didOpen(params: LspDidOpenParams): Promise<void> {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: params.uri,
        languageId: params.languageId,
        version: 1,
        text: params.text,
      },
    });
  }

  /**
   * Sends a textDocument/didChange notification (full sync).
   */
  async didChange(params: LspDidChangeParams): Promise<void> {
    this.notify("textDocument/didChange", {
      textDocument: { uri: params.uri, version: params.version },
      contentChanges: [{ text: params.text }],
    });
  }

  /**
   * Awaits the next diagnostic push for the given URI. Resolves with the
   * cached diagnostics if already received; otherwise waits up to
   * `DIAGNOSTICS_TIMEOUT_MS` for the server to publish.
   */
  async diagnostics(uri: string): Promise<LspDiagnostic[]> {
    const cached = this.diagnosticsCache.get(uri);
    if (cached) return cached;
    return new Promise<LspDiagnostic[]>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(uri, resolver);
        resolve(this.diagnosticsCache.get(uri) ?? []);
      }, DIAGNOSTICS_TIMEOUT_MS);
      timer.unref();
      const resolver = (diags: LspDiagnostic[]) => {
        clearTimeout(timer);
        resolve(diags);
      };
      this.addWaiter(uri, resolver);
    });
  }

  /**
   * Requests `textDocument/completion` from the LSP server. Returns an empty
   * array on any failure (fail-quiet) so the TUI completion system can fall
   * back to other providers. Set `FOCUSCODE_DEBUG_LSP=1` to surface the
   * failure reason on stderr for debugging.
   */
  async completion(params: {
    textDocument: { uri: string };
    position: { line: number; character: number };
  }): Promise<Array<{ label: string; detail?: string }>> {
    try {
      const result = (await this.request("textDocument/completion", params, this.timeoutMs)) as
        { items?: Array<{ label?: string; detail?: string }> } | undefined;
      const items = result?.items ?? [];
      return items
        .filter((item) => typeof item.label === "string")
        .map((item) => ({
          label: item.label!,
          ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
        }));
    } catch (error) {
      if (process.env.FOCUSCODE_DEBUG_LSP) {
        process.stderr.write(
          `[lsp:completion] failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return [];
    }
  }

  /**
   * Performs a clean shutdown: `shutdown` request, then `exit` notification.
   */
  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    if (!this.exitError) {
      try {
        await this.request("shutdown", null, this.timeoutMs);
      } catch {
        // Best-effort; continue to exit notification.
      }
      try {
        this.notify("exit");
      } catch {
        // Process may already be gone.
      }
    }
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
    this.pending.clear();
    this.diagnosticsWaiters.clear();
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.exitError) {
      return Promise.reject(this.exitError ?? new Error("LSP client is not connected"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
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
    if (!this.child) return;
    const json = JSON.stringify(message);
    const bytes = Buffer.from(json, "utf8");
    const header = `Content-Length: ${bytes.length}\r\n\r\n`;
    try {
      this.child.stdin.write(header);
      this.child.stdin.write(bytes);
    } catch (error) {
      this.onProcessFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    for (;;) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.stdoutBuffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Skip malformed header block.
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.stdoutBuffer.length < bodyStart + length) return;
      const body = this.stdoutBuffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(bodyStart + length);
      this.onMessage(body);
    }
  }

  private onMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    // Response to a request.
    if (typeof record.id === "number") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      const error = record.error as { message?: unknown } | undefined;
      if (error && typeof error === "object") {
        pending.reject(new Error(`LSP error: ${String(error.message ?? "unknown")}`));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    // Server notification.
    if (typeof record.method === "string") {
      this.onNotification(record.method, record.params);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return;
    const record = (params ?? {}) as { uri?: unknown; diagnostics?: unknown };
    const uri = typeof record.uri === "string" ? record.uri : "";
    if (uri.length === 0) return;
    const rawDiags = Array.isArray(record.diagnostics) ? record.diagnostics : [];
    const diags: LspDiagnostic[] = [];
    for (const entry of rawDiags) {
      const parsed = parseDiagnostic(entry);
      if (parsed) diags.push(parsed);
    }
    this.diagnosticsCache.set(uri, diags);
    const waiters = this.diagnosticsWaiters.get(uri);
    if (waiters) {
      this.diagnosticsWaiters.delete(uri);
      for (const waiter of waiters) waiter(diags);
    }
  }

  private addWaiter(uri: string, resolver: (diags: LspDiagnostic[]) => void): void {
    const list = this.diagnosticsWaiters.get(uri) ?? [];
    list.push(resolver);
    this.diagnosticsWaiters.set(uri, list);
  }

  private removeWaiter(uri: string, resolver: (diags: LspDiagnostic[]) => void): void {
    const list = this.diagnosticsWaiters.get(uri);
    if (!list) return;
    const idx = list.indexOf(resolver);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.diagnosticsWaiters.delete(uri);
  }

  private onProcessFailure(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [, waiters] of this.diagnosticsWaiters) {
      for (const waiter of waiters) waiter([]);
    }
    this.diagnosticsWaiters.clear();
  }
}

function parseDiagnostic(entry: unknown): LspDiagnostic | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const range = parseRange(record.range);
  if (!range) return undefined;
  const diag: LspDiagnostic = {
    range,
    message: typeof record.message === "string" ? record.message : "",
  };
  if (typeof record.severity === "number") diag.severity = record.severity;
  if (typeof record.code === "number" || typeof record.code === "string") {
    diag.code = record.code;
  }
  if (typeof record.source === "string") diag.source = record.source;
  return diag;
}

function parseRange(value: unknown): LspRange | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const start = parsePosition(record.start);
  const end = parsePosition(record.end);
  if (!start || !end) return undefined;
  return { start, end };
}

function parsePosition(value: unknown): LspPosition | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.line !== "number" || typeof record.character !== "number") return undefined;
  return { line: record.line, character: record.character };
}

function buildChildEnv(specEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (specEnv) {
    for (const [key, value] of Object.entries(specEnv)) {
      env[key] = value;
    }
  }
  return env;
}
