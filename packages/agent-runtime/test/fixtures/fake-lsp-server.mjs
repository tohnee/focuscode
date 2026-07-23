// Fake LSP server for tests: JSON-RPC 2.0 over stdio with Content-Length
// header framing (per the LSP spec, NOT newline-delimited like MCP).
//
// Supports:
//   - initialize          -> { capabilities: { diagnosticProvider: {} }, serverInfo }
//   - initialized         -> (notification, ignored)
//   - textDocument/didOpen -> pushes textDocument/publishDiagnostics with one
//                             diagnostic if the text contains the word "error"
//   - shutdown             -> null result
//   - exit                 -> process.exit(0)

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Skip malformed header block.
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(body);
  }
});

function send(message) {
  const json = JSON.stringify(message);
  const bytes = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
  process.stdout.write(bytes);
}

function publishDiagnostics(uri, diagnostics) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

function handle(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: { diagnosticProvider: { interFileDependencies: false } },
        serverInfo: { name: "fake-lsp", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "textDocument/didOpen") {
    const doc = message.params?.textDocument;
    if (doc?.uri && typeof doc.text === "string" && doc.text.includes("error")) {
      publishDiagnostics(doc.uri, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          severity: 1,
          message: "fake diagnostic: text contains 'error'",
        },
      ]);
    } else if (doc?.uri) {
      publishDiagnostics(doc.uri, []);
    }
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
}
