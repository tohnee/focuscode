import { createInterface } from "node:readline";
import {
  validateImageAttachments,
  type AgentAttachment,
  type ApprovalMode,
  type CodingAgent,
  type SessionStore,
} from "@focuscode/agent-runtime";

interface RpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function rpcEventSink(event: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })}\n`);
}

export async function runRpc(agent: CodingAgent, sessions: SessionStore): Promise<void> {
  const readline = createInterface({ input: process.stdin, terminal: false });
  let queue = Promise.resolve();
  const completed = new Promise<void>((resolve) => readline.once("close", resolve));
  readline.on("line", (line) => {
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      writeError(null, -32700, "Parse error");
      return;
    }
    if (request.method === "abort") {
      writeResult(request.id, { aborted: agent.abort() });
      return;
    }
    if (request.method === "steer") {
      const text = request.params?.text;
      const mode = request.params?.mode;
      if (
        typeof text !== "string" ||
        (mode !== undefined && !["append", "interrupt", "follow-up"].includes(String(mode)))
      ) {
        writeError(
          request.id,
          -32602,
          "steer requires text and optional append|interrupt|follow-up mode",
        );
        return;
      }
      void agent
        .steer(
          text,
          mode === "interrupt" ? "interrupt" : mode === "follow-up" ? "follow-up" : "append",
        )
        .then((result) => writeResult(request.id, result))
        .catch((error: unknown) =>
          writeError(request.id, -32000, error instanceof Error ? error.message : String(error)),
        );
      return;
    }
    if (request.method === "unsteer") {
      const id = request.params?.id;
      if (id !== undefined && typeof id !== "string") {
        writeError(request.id, -32602, "unsteer accepts an optional string id");
        return;
      }
      void agent
        .unsteer(id)
        .then((removed) => writeResult(request.id, { removed }))
        .catch((error: unknown) =>
          writeError(request.id, -32000, error instanceof Error ? error.message : String(error)),
        );
      return;
    }
    if (request.method === "steering_list") {
      writeResult(request.id, { items: agent.listSteering() });
      return;
    }
    queue = queue
      .then(() => handleRequest(request, agent, sessions))
      .catch((error: unknown) => {
        writeError(request.id, -32000, error instanceof Error ? error.message : String(error));
      });
  });
  await completed;
  await queue;
}

async function handleRequest(
  request: RpcRequest,
  agent: CodingAgent,
  sessions: SessionStore,
): Promise<void> {
  const params = request.params ?? {};
  switch (request.method) {
    case "prompt": {
      const text = params.text;
      if (typeof text !== "string") throw new Error("prompt requires params.text");
      const attachments = attachmentsParam(params.attachments);
      writeResult(
        request.id,
        await agent.submit({ text, ...(attachments.length ? { attachments } : {}) }),
      );
      return;
    }
    case "status":
      writeResult(request.id, await agent.status());
      return;
    case "compact":
      writeResult(request.id, await agent.compact());
      return;
    case "new_session":
      writeResult(request.id, { sessionId: await agent.newSession(stringParam(params.name)) });
      return;
    case "switch_session": {
      const id = stringParam(params.sessionId);
      if (!id) throw new Error("switch_session requires params.sessionId");
      writeResult(request.id, { sessionId: await agent.switchSession(id) });
      return;
    }
    case "fork_session":
      writeResult(request.id, {
        sessionId: await agent.forkSession(stringParam(params.entryId), stringParam(params.name)),
      });
      return;
    case "list_sessions":
      writeResult(request.id, await sessions.list(stringParam(params.cwd)));
      return;
    case "set_approval": {
      const mode = stringParam(params.mode);
      if (!mode || !isApprovalMode(mode)) throw new Error("Invalid approval mode");
      agent.changeApproval(mode);
      writeResult(request.id, { mode });
      return;
    }
    case "shutdown":
      writeResult(request.id, { ok: true });
      process.stdin.pause();
      return;
    default:
      writeError(request.id, -32601, `Method not found: ${String(request.method)}`);
  }
}

function attachmentsParam(value: unknown): AgentAttachment[] {
  if (value === undefined) return [];
  return validateImageAttachments(value);
}

function writeResult(id: RpcRequest["id"], result: unknown): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: RpcRequest["id"], code: number, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })}\n`,
  );
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isApprovalMode(value: string): value is ApprovalMode {
  return ["ask", "auto-edit", "full-auto", "deny"].includes(value);
}
