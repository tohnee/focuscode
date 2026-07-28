// CLI composition root helper: wires configured MCP servers into the agent
// tool registry with fail-closed pin verification, and returns a handle that
// owns the lifecycle of the connected stdio clients so the caller can dispose
// them in a `finally` block.
//
// This module is the only place in the CLI that calls `registerMcpServers`.
// Keeping it isolated makes the wiring unit-testable without spawning the
// full `runAgentCommand` pipeline (sandbox, model client, sessions, TUI).

import {
  closeAll,
  registerMcpServers,
  type AgentToolRegistry,
  type McpClient,
  type McpServerSpec,
  type McpToolPinV1,
} from "@focuscode/agent-runtime";

export interface WireMcpOptions {
  registry: AgentToolRegistry;
  servers: readonly McpServerSpec[];
  pins: readonly McpToolPinV1[];
  onWarning?: (message: string) => void;
}

export interface WiredMcpHandle {
  /** Connected MCP clients (stdio or http); empty when no servers were registered. */
  clients: McpClient[];
  /** Tool names registered into the registry (e.g. `mcp_fake_echo`). */
  registered: string[];
  /** Close all tracked clients. Idempotent — safe to call multiple times. */
  close: () => Promise<void>;
}

/**
 * Register MCP server tools into the agent registry before `CodingAgent.create`.
 *
 * - When `servers` is empty, returns an empty handle without touching the
 *   registry (short-circuit so the common no-MCP path stays zero-cost).
 * - When `pins` is non-empty, `registerMcpServers` verifies every pin against
 *   the observed tools and throws `McpPinMismatchError` on any mismatch
 *   (fail closed — no tools remain registered).
 * - `disabled: true` servers are skipped by `registerMcpServers`.
 * - `onWarning` fires for per-server connection failures (missing command,
 *   handshake timeout, etc.); the handle still resolves with the remaining
 *   successfully registered tools.
 */
export async function wireMcpServers(options: WireMcpOptions): Promise<WiredMcpHandle> {
  if (options.servers.length === 0) {
    return { clients: [], registered: [], close: async () => {} };
  }
  const result = await registerMcpServers(options.registry, options.servers, {
    ...(options.pins.length > 0 ? { pins: options.pins } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
  });
  let closed = false;
  return {
    clients: result.clients,
    registered: result.registered,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeAll(result.clients);
    },
  };
}
