import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient, type LspDiagnostic } from "../src/lsp-client.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp-server.mjs");

describe("LspClient — JSON-RPC 2.0 over stdio with Content-Length framing", () => {
  let clients: LspClient[] = [];

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    clients = [];
  });

  it("exchanges the initialize handshake and exposes serverCapabilities", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    const connected = await client.connect();
    expect(connected).toBe(true);
    expect(client.serverCapabilities).toBeDefined();
    expect(
      (client.serverCapabilities as { diagnosticProvider?: unknown }).diagnosticProvider,
    ).toBeDefined();
    expect(client.serverInfo?.name).toBe("fake-lsp");
  });

  it("sends textDocument/didOpen notification", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    // didOpen is a notification (no response); the fake server publishes
    // diagnostics in response, so we can verify side-effect via diagnostics().
    await client.didOpen({
      uri: "file:///fake/sample.ts",
      languageId: "typescript",
      text: "const x: number = 'error';\n",
    });
    const diags = await client.diagnostics("file:///fake/sample.ts");
    expect(diags.length).toBe(1);
    expect(diags[0]?.message).toContain("error");
  });

  it("returns an empty array when the document has no diagnostics", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    await client.didOpen({
      uri: "file:///fake/clean.ts",
      languageId: "typescript",
      text: "const x = 1;\n",
    });
    const diags = await client.diagnostics("file:///fake/clean.ts");
    expect(diags).toEqual([]);
  });

  it("resolves diagnostics with structured range and severity", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    await client.didOpen({
      uri: "file:///fake/structured.ts",
      languageId: "typescript",
      text: "error here\n",
    });
    const diags = await client.diagnostics("file:///fake/structured.ts");
    const first = diags[0] as LspDiagnostic | undefined;
    expect(first).toBeDefined();
    expect(first?.severity).toBe(1);
    expect(first?.range.start.line).toBe(0);
    expect(first?.range.start.character).toBe(0);
    expect(first?.range.end.line).toBe(0);
    expect(first?.range.end.character).toBe(5);
  });

  it("shuts down cleanly via shutdown request then exit notification", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    await client.close();
    // After close, the client is no longer connected.
    expect(client.connected).toBe(false);
  });

  it("connect() resolves to false (fail-quiet) when the server command is missing", async () => {
    const client = new LspClient({
      command: "definitely-not-a-real-lsp-command-xyz",
      args: [],
    });
    clients.push(client);
    const connected = await client.connect();
    expect(connected).toBe(false);
    expect(client.serverCapabilities).toBeUndefined();
  });

  it("connect() resolves to false when the server exits before responding to initialize", async () => {
    // A server that immediately exits without speaking LSP.
    const client = new LspClient({ command: process.execPath, args: ["-e", "process.exit(1)"] });
    clients.push(client);
    const connected = await client.connect();
    expect(connected).toBe(false);
  });

  it("didChange sends a notification without expecting diagnostics change", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    await client.didOpen({
      uri: "file:///fake/change.ts",
      languageId: "typescript",
      text: "error\n",
    });
    // didChange should not throw; the fake server does not re-publish on
    // didChange, so diagnostics stay as they were.
    await expect(
      client.didChange({
        uri: "file:///fake/change.ts",
        languageId: "typescript",
        text: "const y = 2;\n",
        version: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it("completion() returns completion items with label and optional detail", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    const items = await client.completion({
      textDocument: { uri: "file:///fake/sample.ts" },
      position: { line: 0, character: 0 },
    });
    expect(items).toHaveLength(3);
    expect(items[0]?.label).toBe("foo");
    expect(items[0]?.detail).toBe("() => void");
    expect(items[1]?.label).toBe("bar");
    expect(items[1]?.detail).toBe("(x: number) => string");
    expect(items[2]?.label).toBe("baz");
    expect(items[2]?.detail).toBeUndefined();
  });

  it("completion() filters out items without a string label", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    await client.connect();
    const items = await client.completion({
      textDocument: { uri: "file:///fake/sample.ts" },
      position: { line: 0, character: 0 },
    });
    // The fake server sends 4 items, one without a label — it must be filtered.
    expect(items.every((item) => typeof item.label === "string")).toBe(true);
  });

  it("completion() returns empty array when not connected (fail-quiet)", async () => {
    const client = new LspClient({ command: process.execPath, args: [fixture] });
    clients.push(client);
    // Don't call connect() — the client has no child process.
    const items = await client.completion({
      textDocument: { uri: "file:///fake/sample.ts" },
      position: { line: 0, character: 0 },
    });
    expect(items).toEqual([]);
  });

  it("completion() returns empty array when the server responds with an error", async () => {
    // Use a server that responds with an error to completion requests.
    const client = new LspClient({
      command: process.execPath,
      args: [
        "-e",
        `
        let buf = Buffer.alloc(0);
        process.stdin.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            const end = buf.indexOf("\\r\\n\\r\\n");
            if (end < 0) return;
            const header = buf.subarray(0, end).toString();
            const m = /Content-Length:\\s*(\\d+)/i.exec(header);
            if (!m) { buf = buf.subarray(end + 4); continue; }
            const len = Number(m[1]);
            const start = end + 4;
            if (buf.length < start + len) return;
            const body = buf.subarray(start, start + len).toString();
            buf = buf.subarray(start + len);
            const msg = JSON.parse(body);
            if (msg.method === "initialize") {
              const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {}, serverInfo: { name: "err-lsp" } } });
              const bytes = Buffer.from(out);
              process.stdout.write("Content-Length: " + bytes.length + "\\r\\n\\r\\n");
              process.stdout.write(bytes);
            } else if (msg.method === "textDocument/completion") {
              const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "completion failed" } });
              const bytes = Buffer.from(out);
              process.stdout.write("Content-Length: " + bytes.length + "\\r\\n\\r\\n");
              process.stdout.write(bytes);
            } else if (msg.method === "shutdown") {
              const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null });
              const bytes = Buffer.from(out);
              process.stdout.write("Content-Length: " + bytes.length + "\\r\\n\\r\\n");
              process.stdout.write(bytes);
            }
          }
        });
      `,
      ],
    });
    clients.push(client);
    await client.connect();
    const items = await client.completion({
      textDocument: { uri: "file:///fake/sample.ts" },
      position: { line: 0, character: 0 },
    });
    expect(items).toEqual([]);
  });
});
