/**
 * ACP (Agent Client Protocol) server - JSON-RPC 2.0 over stdio.
 *
 * Wraps CodingAgent for editor integration (Zed, JetBrains, etc.).
 * The server reads line-delimited JSON-RPC requests from stdin and writes
 * responses/notifications to stdout. All logging goes to stderr to keep
 * the stdout protocol stream clean.
 *
 * Supported methods:
 * - initialize: capability negotiation
 * - session/new: create a new agent session
 * - session/prompt: send a prompt and stream events back
 * - session/cancel: cancel the current operation
 * - session/list: list available sessions
 * - session/load: load an existing session by ID
 *
 * Usage: focuscode --mode acp [options]
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CodingAgent,
  SessionStore,
  renderResourcePrompt,
  type AgentEvent,
} from "@focuscode/agent-runtime";
import type { AgentCliArgs } from "./agent-args.js";
import { createAgentContext } from "./agent-context.js";

const ACP_PROTOCOL_VERSION = "1.0.0";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

function send(message: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResponse(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendNotification(method: string, params?: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
}

function log(message: string): void {
  process.stderr.write(`[acp] ${message}\n`);
}

interface AcpSession {
  agent: CodingAgent;
  sessionId: string;
  busy: boolean;
  abortController?: AbortController | undefined;
}

export async function runAcpServer(
  args: AgentCliArgs,
  configOverrides: Parameters<typeof import("@focuscode/agent-runtime").resolveAgentConfig>[1],
): Promise<void> {
  const cwd = resolve(args.cwd);
  const sessions = new SessionStore(
    resolve(args.sessionDirectory ?? joinDefault(cwd)),
    !args.noSession,
  );
  const ctx = await createAgentContext({
    cwd,
    configOverrides: configOverrides ?? {},
    onFallback: (event) => log(`Fallback: ${event.from} -> ${event.to} (${event.reason})`),
  });
  const { sandbox, registry, resources, client, config } = ctx;

  const sessions_ = new Map<string, AcpSession>();
  let currentSessionId: string | undefined;

  async function createAgent(sessionId?: string): Promise<AcpSession> {
    const agent = await CodingAgent.create({
      cwd,
      model: config.model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: {
        mode: config.approval,
        projectTrusted: config.projectTrusted,
        protectedPaths: config.protectedPaths,
      },
      sessionStore: sessions,
      ...(sessionId ? { sessionId } : {}),
      instructions: [renderResourcePrompt(resources)],
      maxRounds: args.maxRounds ?? config.maxRounds,
      eventSink: (event: AgentEvent) => {
        // Map agent events to ACP notifications
        handleAgentEvent(event);
      },
    });
    const sid = agent.sessionId;
    const session: AcpSession = { agent, sessionId: sid, busy: false };
    sessions_.set(sid, session);
    return session;
  }

  function handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        sendNotification("session/event", {
          sessionId: currentSessionId,
          event: "text",
          data: event.delta,
        });
        break;
      case "tool_start":
        sendNotification("session/event", {
          sessionId: currentSessionId,
          event: "tool_start",
          data: { name: event.call.name, arguments: event.call.arguments },
        });
        break;
      case "tool_end":
        sendNotification("session/event", {
          sessionId: currentSessionId,
          event: "tool_end",
          data: {
            name: event.call.name,
            content: event.result.content.slice(0, 500),
            isError: event.result.isError ?? false,
            durationMs: event.durationMs,
          },
        });
        break;
      case "error":
        sendNotification("session/event", {
          sessionId: currentSessionId,
          event: "error",
          data: event.message,
        });
        break;
      case "agent_start":
        sendNotification("session/event", {
          sessionId: currentSessionId,
          event: "turn_start",
          data: { turn: event.turn },
        });
        break;
      case "agent_end":
        sendNotification("session/event", {
          sessionId: currentSessionId,
          event: "turn_end",
          data: {
            stopped: event.response.stopped,
            rounds: event.response.rounds,
            toolCalls: event.response.toolCalls,
          },
        });
        break;
      default:
        // Other events (usage, reasoning_delta, etc.) are not forwarded
        // to keep the ACP stream focused on editor-relevant updates.
        break;
    }
  }

  // ─── JSON-RPC dispatch ───────────────────────────────────────────────

  async function handleMessage(message: JsonRpcMessage): Promise<void> {
    if (!("method" in message)) return; // Response or notification, ignore
    const req = message as JsonRpcRequest;
    const id = req.id ?? 0;

    try {
      switch (req.method) {
        case "initialize": {
          sendResponse(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            server: "FocusCode",
            version: "0.5.0",
            capabilities: {
              events: true,
              diff: true,
              approval: "coarse",
              cancel: true,
              checkpoint: false,
            },
          });
          break;
        }

        case "session/new": {
          const session = await createAgent();
          currentSessionId = session.sessionId;
          sendResponse(id, {
            sessionId: session.sessionId,
            model: `${config.model.provider}/${config.model.model}`,
            cwd,
          });
          break;
        }

        case "session/load": {
          const sessionId = req.params?.["sessionId"] as string;
          if (!sessionId) {
            sendError(id, -32602, "Missing sessionId parameter");
            break;
          }
          const session = await createAgent(sessionId);
          currentSessionId = session.sessionId;
          sendResponse(id, {
            sessionId: session.sessionId,
            model: `${config.model.provider}/${config.model.model}`,
            cwd,
          });
          break;
        }

        case "session/list": {
          const list = await sessions.list(cwd);
          sendResponse(id, {
            sessions: list.map((s) => ({
              sessionId: s.sessionId,
              name: s.name,
              updatedAt: s.updatedAt,
              model: s.model,
              preview: s.preview,
            })),
          });
          break;
        }

        case "session/prompt": {
          if (!currentSessionId) {
            sendError(id, -32000, "No active session. Call session/new first.");
            break;
          }
          const session = sessions_.get(currentSessionId);
          if (!session) {
            sendError(id, -32001, `Session not found: ${currentSessionId}`);
            break;
          }
          if (session.busy) {
            sendError(id, -32002, "Session is busy. Cancel the current operation first.");
            break;
          }
          const prompt = req.params?.["prompt"] as string;
          if (!prompt) {
            sendError(id, -32602, "Missing prompt parameter");
            break;
          }
          session.busy = true;
          session.abortController = new AbortController();
          // Respond immediately - events stream as notifications
          sendResponse(id, { sessionId: currentSessionId, streaming: true });
          try {
            const result = await session.agent.submit(prompt, session.abortController.signal);
            sendNotification("session/end", {
              sessionId: currentSessionId,
              result: {
                content: result.content,
                stopped: result.stopped,
                rounds: result.rounds,
                toolCalls: result.toolCalls,
                usage: result.usage,
              },
            });
          } catch (error) {
            sendNotification("session/end", {
              sessionId: currentSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            session.busy = false;
            session.abortController = undefined;
          }
          break;
        }

        case "session/cancel": {
          if (!currentSessionId) {
            sendError(id, -32000, "No active session");
            break;
          }
          const session = sessions_.get(currentSessionId);
          if (session?.abortController) {
            session.abortController.abort();
            sendResponse(id, { cancelled: true });
          } else {
            sendResponse(id, { cancelled: false, reason: "No active operation" });
          }
          break;
        }

        case "shutdown": {
          sendResponse(id, { ok: true });
          process.exit(0);
          break;
        }

        default:
          sendError(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error handling ${req.method}: ${message}`);
      sendError(id, -32603, message);
    }
  }

  // ─── stdio loop ─────────────────────────────────────────────────────

  const lines = createInterface({ input: process.stdin });
  log(`ACP server started (protocol ${ACP_PROTOCOL_VERSION})`);

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const message = JSON.parse(trimmed) as JsonRpcMessage;
      await handleMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Parse error: ${message}`);
      send({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "Parse error" } });
    }
  }

  log("ACP server stdin closed, shutting down");
}

function joinDefault(cwd: string): string {
  const digest = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(homedir(), ".focuscode", "sessions", digest);
}
