#!/usr/bin/env node
/**
 * FocusCode Control API — read-only task/checkpoint/events surface.
 *
 * P1-J: security model.
 *   - Loopback bind (127.0.0.1 / ::1): no auth required (default).
 *   - Non-loopback bind (0.0.0.0, etc.): FAIL-CLOSED unless a token is
 *     configured via `FOCUSCODE_CONTROL_TOKEN`. If no token is set, the
 *     server refuses to start. This prevents accidentally exposing task
 *     lists, checkpoints, and event streams (which may contain code or
 *     conversation content) on a public interface.
 *   - When a token is configured (loopback or not), every endpoint except
 *     `/health` requires `Authorization: Bearer <token>` with a
 *     timing-safe comparison. `/health` stays open for liveness probes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { TaskSpecSchema, assertSchema } from "@focuscode/contracts";
import { FileFactStore } from "@focuscode/persistence";

export interface ControlApiOptions {
  host?: string;
  port?: number;
  stateDirectory?: string;
  /** When set, all endpoints except /health require Bearer auth. */
  token?: string;
  /**
   * When true, non-loopback binds are allowed without a token (NOT
   * recommended; default false). Set explicitly in tests only.
   */
  allowInsecureNonLoopback?: boolean;
}

export function createControlApi(options: ControlApiOptions = {}): Server {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const stateDirectory = resolve(options.stateDirectory ?? ".focuscode-state");
  const token = options.token;
  const allowInsecure = options.allowInsecureNonLoopback ?? false;

  // P1-J: fail-closed for non-loopback binds without a token.
  if (!isLoopback(host) && !token && !allowInsecure) {
    throw new Error(
      `Control API refuses to bind non-loopback host "${host}" without a token. ` +
        "Set FOCUSCODE_CONTROL_TOKEN or bind to 127.0.0.1/::1.",
    );
  }

  const store = new FileFactStore(stateDirectory);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

      // /health is always open — liveness probes must not require auth.
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          component: "focuscode-control-api",
          version: "0.1.0-alpha.1",
        });
        return;
      }

      // P1-J: every non-health endpoint requires the token when configured.
      if (token && !authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
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

  // P1-J: signal handlers are only attached in the entrypoint, not here, so
  // tests can close the server without triggering process.exit().
  return server;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

function authorized(request: IncomingMessage, token: string): boolean {
  const provided = request.headers.authorization;
  if (!provided?.startsWith("Bearer ")) return false;
  const left = Buffer.from(provided.slice(7));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

// --- Entrypoint (only when run as `node dist/index.js`) ---
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = process.env.FOCUSCODE_CONTROL_HOST ?? "127.0.0.1";
  const port = Number(process.env.FOCUSCODE_CONTROL_PORT ?? "4317");
  const token = process.env.FOCUSCODE_CONTROL_TOKEN;
  const server = createControlApi({
    host,
    port,
    stateDirectory: process.env.FOCUSCODE_STATE_DIR ?? ".focuscode-state",
    ...(token ? { token } : {}),
  });
  server.listen(port, host, () => {
    process.stdout.write(`FocusCode Control API listening on http://${host}:${port}\n`);
    process.stdout.write(
      `State directory: ${process.env.FOCUSCODE_STATE_DIR ?? ".focuscode-state"}\n`,
    );
    if (token) {
      process.stdout.write(
        "Authentication: Bearer token required for all endpoints except /health\n",
      );
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
