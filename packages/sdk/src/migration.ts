/**
 * Migration helpers for Claude Agent SDK / OpenCode SDK → FocusCode (P1-2).
 *
 * Goal: provide programmatic adapters that map the common option shapes from
 * Claude Agent SDK and OpenCode SDK onto FocusCode's `CreateCodingAgentOptions`,
 * so integrators can migrate with a single function call instead of rewriting
 * their configuration from scratch.
 *
 * These helpers are **best-effort structural mappings** — they translate the
 * field names and value shapes that have direct FocusCode equivalents. Fields
 * without an equivalent (e.g. Claude's `forkSession`, OpenCode's HTTP server
 * config) are silently dropped. Integrators should review the output and add
 * FocusCode-specific options (sandbox, enterprise, OAuth, etc.) manually.
 *
 * @example
 * ```ts
 * import { fromClaudeOptions, createCodingAgent } from "@focuscode/sdk";
 *
 * const options = fromClaudeOptions({
 *   cwd: "/tmp/project",
 *   model: "claude-sonnet-4",
 *   permissionMode: "acceptEdits",
 *   maxTurns: 50,
 * });
 * const { agent } = await createCodingAgent(options);
 * ```
 */

import type {
  AgentTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@focuscode/agent-runtime";
import type { ApprovalMode } from "@focuscode/action-domain";
import type { AgentHooks, PostToolContext } from "./hooks.js";
import type { CreateCodingAgentOptions } from "./coding-agent.js";

// ---------------------------------------------------------------------------
// Claude Agent SDK option shapes (subset, structural)
// ---------------------------------------------------------------------------

/** Claude's permissionMode enum. */
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Claude's MCP server config (object map form). */
export interface ClaudeMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Subset of Claude Agent SDK options that have FocusCode equivalents. */
export interface ClaudeAgentOptions {
  cwd: string;
  model: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  permissionMode?: ClaudePermissionMode;
  canUseTool?: (tool: string) => boolean | Promise<boolean>;
  mcpServers?: Record<string, ClaudeMcpServer>;
}

/** Claude tool definition shape. */
export interface ClaudeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Claude hook names. */
export interface ClaudeHooks {
  PreToolUse?: (context: {
    toolName: string;
  }) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  PostToolUse?: (context: { toolName: string; result: unknown }) => Promise<void>;
  Stop?: (context: { reason: string }) => Promise<void>;
  SessionStart?: (context: { sessionId: string }) => Promise<void>;
  SessionEnd?: (context: { sessionId: string }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// OpenCode SDK option shapes (subset, structural)
// ---------------------------------------------------------------------------

/** OpenCode permission config. */
export interface OpenCodePermissions {
  bash?: "allow" | "ask" | "deny";
  edit?: "allow" | "ask" | "deny";
  fetch?: "allow" | "ask" | "deny";
}

/** Subset of OpenCode SDK options that have FocusCode equivalents. */
export interface OpenCodeOptions {
  cwd: string;
  model: string;
  provider: string;
  agent?: string;
  permissions?: OpenCodePermissions;
}

// ---------------------------------------------------------------------------
// Migration result types
// ---------------------------------------------------------------------------

/**
 * Result of {@link mapClaudeHooks}. Extends {@link AgentHooks} with a
 * `beforeTool` field that maps Claude's `PreToolUse` veto. The integrator
 * should register `beforeTool` via `extensionHost.api().beforeTool()` if
 * present, and pass the rest as `CreateCodingAgentOptions.hooks`.
 */
export interface MigratedHooks extends AgentHooks {
  /** Veto hook mapped from Claude's PreToolUse. Register via ExtensionHost. */
  beforeTool?: (context: { toolName: string }) => Promise<{ allow: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

/** Map Claude permissionMode → FocusCode ApprovalMode. */
function mapPermissionMode(mode: ClaudePermissionMode): ApprovalMode {
  switch (mode) {
    case "acceptEdits":
      return "auto-edit";
    case "bypassPermissions":
      return "full-auto";
    case "plan":
    case "default":
    default:
      return "ask";
  }
}

/** Map OpenCode permission level → FocusCode ApprovalMode (most restrictive wins). */
function mapOpenCodePermissions(perms: OpenCodePermissions): ApprovalMode {
  const levels = [perms.bash, perms.edit, perms.fetch].filter(Boolean) as string[];
  if (levels.includes("deny")) return "deny";
  if (levels.includes("ask")) return "ask";
  if (levels.every((l) => l === "allow")) return "full-auto";
  return "ask";
}

// ---------------------------------------------------------------------------
// Public migration functions
// ---------------------------------------------------------------------------

/**
 * Map Claude Agent SDK options to FocusCode `CreateCodingAgentOptions`.
 *
 * Fields without a FocusCode equivalent are dropped. The integrator should
 * review the output and add FocusCode-specific options (sandbox, enterprise,
 * OAuth, etc.) before calling `createCodingAgent`.
 */
export function fromClaudeOptions(claude: ClaudeAgentOptions): CreateCodingAgentOptions {
  const options: CreateCodingAgentOptions = {
    cwd: claude.cwd,
    model: claude.model,
  };
  if (claude.allowedTools) options.enabledTools = claude.allowedTools;
  if (claude.disallowedTools) options.disabledTools = claude.disallowedTools;
  if (claude.maxTurns !== undefined) options.maxRounds = claude.maxTurns;
  if (claude.permissionMode) options.approval = mapPermissionMode(claude.permissionMode);
  if (claude.systemPrompt) options.instructions = [claude.systemPrompt];
  if (claude.canUseTool) {
    const canUseTool = claude.canUseTool;
    options.approve = async (request) => {
      try {
        return await canUseTool(request.tool.name);
      } catch {
        return false;
      }
    };
  }
  if (claude.mcpServers) {
    const servers = Object.entries(claude.mcpServers).map(([id, server]) => ({
      id,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    }));
    options.mcp = { servers };
  }
  return options;
}

/**
 * Map OpenCode SDK options to FocusCode `CreateCodingAgentOptions`.
 *
 * OpenCode uses a `provider/model` format for model identification. The
 * helper splits this into FocusCode's `provider` + `model` fields.
 */
export function fromOpenCodeOptions(opencode: OpenCodeOptions): CreateCodingAgentOptions {
  const options: CreateCodingAgentOptions = {
    cwd: opencode.cwd,
    model: opencode.model,
  };
  if (opencode.provider) options.provider = opencode.provider;
  if (opencode.permissions) options.approval = mapOpenCodePermissions(opencode.permissions);
  return options;
}

/**
 * Map a Claude tool definition to a FocusCode `AgentTool`.
 *
 * The returned tool has a no-op executor that returns an empty success
 * result. Integrators must override `execute` with their actual handler.
 * The `definition` (name, description, parameters, effect) is fully mapped.
 */
export function mapClaudeTool(claudeTool: ClaudeTool): AgentTool {
  const definition: ToolDefinition = {
    name: claudeTool.name,
    label: claudeTool.name,
    description: claudeTool.description ?? claudeTool.name,
    parameters: claudeTool.inputSchema,
    effect: "read",
  };
  return {
    definition,
    async execute(
      _args: Record<string, unknown>,
      _ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      return { content: "" };
    },
  };
}

/**
 * Map Claude hook names to FocusCode hook names.
 *
 * Returns a {@link MigratedHooks} object. The `beforeTool` field (mapped
 * from Claude's `PreToolUse`) should be registered separately via
 * `extensionHost.api().beforeTool()` because it runs in the extension host,
 * not the SDK event sink.
 */
export function mapClaudeHooks(claudeHooks: ClaudeHooks): MigratedHooks {
  const hooks: MigratedHooks = {};
  if (claudeHooks.PreToolUse) {
    const preToolUse = claudeHooks.PreToolUse;
    hooks.beforeTool = async (context) => {
      const result = await preToolUse({ toolName: context.toolName });
      return {
        allow: result.decision === "allow",
        ...(result.reason ? { reason: result.reason } : {}),
      };
    };
  }
  if (claudeHooks.PostToolUse) {
    const postToolUse = claudeHooks.PostToolUse;
    hooks.postToolUse = async (context: PostToolContext, result: ToolExecutionResult) => {
      await postToolUse({ toolName: context.toolName, result });
    };
  }
  if (claudeHooks.Stop) {
    const stop = claudeHooks.Stop;
    hooks.stop = async (reason) => {
      await stop({ reason: String(reason) });
    };
  }
  if (claudeHooks.SessionStart) {
    const sessionStart = claudeHooks.SessionStart;
    hooks.sessionStart = async (context) => {
      await sessionStart({ sessionId: context.sessionId });
    };
  }
  if (claudeHooks.SessionEnd) {
    const sessionEnd = claudeHooks.SessionEnd;
    hooks.sessionEnd = async (context) => {
      await sessionEnd({ sessionId: context.sessionId });
    };
  }
  return hooks;
}
