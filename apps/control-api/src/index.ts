#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { TaskSpecSchema, assertSchema } from "@focuscode/contracts";
import { FileFactStore } from "@focuscode/persistence";

const host = process.env.FOCUSCODE_CONTROL_HOST ?? "127.0.0.1";
const port = Number(process.env.FOCUSCODE_CONTROL_PORT ?? "4317");
const stateDirectory = resolve(process.env.FOCUSCODE_STATE_DIR ?? ".focuscode-state");
const store = new FileFactStore(stateDirectory);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        component: "focuscode-control-api",
        version: "0.1.0-alpha.1",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/contracts/task-spec") {
      sendJson(response, 200, TaskSpecSchema);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/tasks/validate") {
      const body = await readJson(request);
      assertSchema(TaskSpecSchema, body, "task spec");
      sendJson(response, 200, { valid: true, schemaVersion: body.schemaVersion });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tasks") {
      sendJson(response, 200, { taskIds: await store.listTaskIds() });
      return;
    }
    const match = /^\/v1\/tasks\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/.exec(url.pathname);
    if (request.method === "GET" && match?.[1]) {
      const taskId = match[1];
      const checkpoint = await store.loadCheckpoint(taskId);
      if (!checkpoint) {
        sendJson(response, 404, { error: "task_not_found", taskId });
        return;
      }
      sendJson(response, 200, {
        checkpoint,
        events: await store.loadEvents(taskId),
      });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`FocusCode Control API listening on http://${host}:${port}\n`);
  process.stdout.write(`State directory: ${stateDirectory}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
