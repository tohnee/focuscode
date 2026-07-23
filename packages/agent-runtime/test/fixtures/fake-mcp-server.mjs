// Fake MCP stdio server for tests: newline-delimited JSON-RPC 2.0 on stdin/stdout.
// - initialize -> result with serverInfo {name: "fake", version: "1.2.3"}
// - notifications/initialized -> no response
// - tools/list -> two tools: echo (readOnlyHint) and boom (no annotations)
// - tools/call echo -> text "echo:<text>"; tools/call boom -> process.exit(42)

process.stderr.write("fake-mcp-server listening\n");

const tools = [
  {
    name: "echo",
    description: "Echo the provided text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "boom",
    description: "Kill the server process",
    inputSchema: { type: "object", properties: {} },
  },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(line);
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.2.3" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    const params = message.params ?? {};
    if (params.name === "echo") {
      const text = params.arguments?.text ?? "";
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `echo:${text}` }], isError: false },
      });
      return;
    }
    if (params.name === "boom") process.exit(42);
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "unknown tool" } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
}
