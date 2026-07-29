import type { McpCallToolResult, McpToolInfo } from "./mcp.js";

/**
 * Tool handler for the in-process SDK MCP server. Unlike stdio/HTTP MCP
 * servers (which spawn a child process or connect to a remote endpoint),
 * in-process handlers run directly in the CLI host process. This is the
 * FocusCode equivalent of Claude Agent SDK's `createSdkMcpServer`.
 */
export interface McpSdkToolHandler {
  /** Tool name (must be unique within the server). */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** JSON Schema for the tool's input. */
  inputSchema?: Record<string, unknown>;
  /** Execute the tool. Receives parsed arguments, returns text content. */
  execute(args: Record<string, unknown>): Promise<string> | string;
}

/**
 * Options for {@link createSdkMcpServer}.
 */
export interface CreateSdkMcpServerOptions {
  /** Server identifier (used in logs and pin computation). */
  id: string;
  /** Tool handlers to register. */
  tools: McpSdkToolHandler[];
}

/**
 * In-process MCP server returned by {@link createSdkMcpServer}.
 * Satisfies the same `McpClient`-adjacent interface as stdio/HTTP clients
 * so the tool registration pipeline can treat it uniformly.
 */
export interface McpSdkServer {
  readonly id: string;
  readonly transport: { transport: "in-process"; id: string };
  readonly transportDigestPayload: unknown;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

/**
 * Create an in-process MCP server from a set of tool handlers.
 *
 * This is the FocusCode equivalent of Claude Agent SDK's `createSdkMcpServer`:
 * a factory that lets integrators define MCP tools directly in TypeScript
 * without spawning a child process or running a separate server.
 *
 * Unlike stdio/HTTP MCP servers, in-process servers:
 *   - Run in the CLI host process (no IPC overhead, no serialization boundary)
 *   - Do not require a `command`/`url` — tools are plain async functions
 *   - Share the host's memory and lifecycle (no `connect()` handshake needed)
 *   - Are suitable for trusted, high-performance tool implementations
 *
 * @example
 * ```ts
 * const server = createSdkMcpServer({
 *   id: "my-tools",
 *   tools: [
 *     {
 *       name: "read_config",
 *       async execute() {
 *         return JSON.stringify(await loadConfig());
 *       },
 *     },
 *   ],
 * });
 * const tools = await server.listTools();
 * const result = await server.callTool("read_config", {});
 * ```
 */
export function createSdkMcpServer(options: CreateSdkMcpServerOptions): McpSdkServer {
  const tools = new Map<string, McpSdkToolHandler>();
  for (const tool of options.tools) {
    if (tools.has(tool.name)) {
      throw new Error(`Duplicate tool name in MCP server "${options.id}": ${tool.name}`);
    }
    tools.set(tool.name, tool);
  }

  return {
    id: options.id,
    transport: { transport: "in-process", id: options.id },
    transportDigestPayload: { transport: "in-process" as const, id: options.id },

    async listTools(): Promise<McpToolInfo[]> {
      return options.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      }));
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
      const handler = tools.get(name);
      if (!handler) {
        return {
          content: `Tool not found in MCP server "${options.id}": ${name}`,
          isError: true,
        };
      }
      try {
        const result = await handler.execute(args);
        return { content: result, isError: false };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },

    async close(): Promise<void> {
      // In-process servers have no external resources to release.
    },
  };
}
