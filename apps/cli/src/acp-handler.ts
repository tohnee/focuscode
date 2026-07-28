/**
 * ACP checkpoint method handler — extracted from acp-server.ts for testability.
 *
 * Handles the `session/checkpoint` JSON-RPC method (list/undo) and the
 * `initialize` capability advertisement. Other methods remain in the
 * inline dispatcher in acp-server.ts.
 */
import type { CheckpointSummary, CodingAgent } from "@focuscode/agent-runtime";
import type { ModelProfile } from "@focuscode/agent-runtime";

export interface AcpSession {
  agent: Pick<CodingAgent, "listCheckpoints" | "undoCheckpoint">;
  sessionId: string;
  busy: boolean;
  abortController?: AbortController | undefined;
}

export interface AcpContext {
  sessions: Map<string, AcpSession>;
  currentSessionId: string | undefined;
  config: { model: ModelProfile };
  cwd: string;
  sessionStore: { list(cwd: string): Promise<unknown[]> };
}

export interface AcpCheckpointParams {
  action: "list" | "undo";
}

/**
 * Dispatch a checkpoint-related ACP method.
 *
 * Returns the `result` field of the JSON-RPC response, or throws an Error
 * with a human-readable message (the caller maps it to a JSON-RPC error).
 */
export async function dispatchAcpMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: AcpContext,
): Promise<Record<string, unknown>> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "1.0.0",
        server: "FocusCode",
        version: "0.5.0",
        capabilities: {
          events: true,
          diff: true,
          approval: "coarse",
          cancel: true,
          checkpoint: true,
        },
      };

    case "session/checkpoint": {
      const action = params?.["action"] as string | undefined;
      if (!action) throw new Error("Missing required parameter: action");

      if (!ctx.currentSessionId) {
        throw new Error("No active session. Call session/new first.");
      }
      const session = ctx.sessions.get(ctx.currentSessionId);
      if (!session) {
        throw new Error(`Session not found: ${ctx.currentSessionId}`);
      }

      if (action === "list") {
        const checkpoints: CheckpointSummary[] = await session.agent.listCheckpoints();
        return { checkpoints };
      }

      if (action === "undo") {
        const result = await session.agent.undoCheckpoint();
        return { result };
      }

      throw new Error(`Invalid checkpoint action: ${action}. Use "list" or "undo".`);
    }

    default:
      throw new Error(`Method not handled by checkpoint dispatcher: ${method}`);
  }
}
