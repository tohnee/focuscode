import { describe, expect, it } from "vitest";
import {
  fromClaudeOptions,
  fromOpenCodeOptions,
  mapClaudeTool,
  mapClaudeHooks,
  type ClaudeAgentOptions,
  type OpenCodeOptions,
  type ClaudeTool,
  type ClaudeHooks,
} from "../src/index.js";

/**
 * P1-2: Claude/OpenCode → FocusCode migration helpers (review §9.5 gap #4).
 *
 * Goal: provide programmatic adapters that map the common option shapes from
 * Claude Agent SDK and OpenCode SDK onto FocusCode's CreateCodingAgentOptions,
 * so integrators can migrate with a single function call instead of rewriting
 * their configuration from scratch.
 */
describe("fromClaudeOptions()", () => {
  it("maps cwd and model to FocusCode options", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
    };
    const result = fromClaudeOptions(claude);
    expect(result.cwd).toBe("/tmp/project");
    expect(result.model).toBeDefined();
  });

  it("maps allowedTools to enabledTools", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      allowedTools: ["bash", "read_file", "write_file"],
    };
    const result = fromClaudeOptions(claude);
    expect(result.enabledTools).toEqual(["bash", "read_file", "write_file"]);
  });

  it("maps disallowedTools to disabledTools", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      disallowedTools: ["dangerous_tool"],
    };
    const result = fromClaudeOptions(claude);
    expect(result.disabledTools).toEqual(["dangerous_tool"]);
  });

  it("maps maxTurns to maxRounds", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      maxTurns: 50,
    };
    const result = fromClaudeOptions(claude);
    expect(result.maxRounds).toBe(50);
  });

  it("maps permissionMode to approval mode", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      permissionMode: "acceptEdits",
    };
    const result = fromClaudeOptions(claude);
    expect(result.approval).toBe("auto-edit");
  });

  it("maps plan mode permissionMode to ask (FocusCode has no plan mode)", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      permissionMode: "plan",
    };
    const result = fromClaudeOptions(claude);
    expect(result.approval).toBe("ask");
  });

  it("maps default permissionMode", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      permissionMode: "default",
    };
    const result = fromClaudeOptions(claude);
    expect(result.approval).toBe("ask");
  });

  it("maps systemPrompt to instructions", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      systemPrompt: "You are a helpful coding assistant.",
    };
    const result = fromClaudeOptions(claude);
    expect(result.instructions).toEqual(["You are a helpful coding assistant."]);
  });

  it("maps canUseTool callback to approve handler", () => {
    const canUseTool = async (tool: string) => true;
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      canUseTool,
    };
    const result = fromClaudeOptions(claude);
    expect(result.approve).toBeDefined();
    expect(typeof result.approve).toBe("function");
  });

  it("maps mcpServers to FocusCode MCP servers", () => {
    const claude: ClaudeAgentOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    };
    const result = fromClaudeOptions(claude);
    expect(result.mcp).toBeDefined();
    expect(result.mcp?.servers).toHaveLength(1);
    expect(result.mcp?.servers?.[0].id).toBe("github");
    expect(result.mcp?.servers?.[0].command).toBe("npx");
  });
});

describe("fromOpenCodeOptions()", () => {
  it("maps cwd and model to FocusCode options", () => {
    const opencode: OpenCodeOptions = {
      cwd: "/tmp/project",
      model: "anthropic/claude-sonnet-4",
      provider: "anthropic",
    };
    const result = fromOpenCodeOptions(opencode);
    expect(result.cwd).toBe("/tmp/project");
    expect(result.model).toBeDefined();
  });

  it("maps provider to FocusCode provider format", () => {
    const opencode: OpenCodeOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      provider: "anthropic",
    };
    const result = fromOpenCodeOptions(opencode);
    expect(result.model).toBeDefined();
  });

  it("maps permission config", () => {
    const opencode: OpenCodeOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      provider: "anthropic",
      permissions: {
        bash: "allow",
        edit: "ask",
      },
    };
    const result = fromOpenCodeOptions(opencode);
    expect(result.approval).toBeDefined();
  });

  it("maps agent config", () => {
    const opencode: OpenCodeOptions = {
      cwd: "/tmp/project",
      model: "claude-sonnet-4",
      provider: "anthropic",
      agent: "coder",
    };
    const result = fromOpenCodeOptions(opencode);
    expect(result.cwd).toBe("/tmp/project");
  });
});

describe("mapClaudeTool()", () => {
  it("maps a Claude tool definition to FocusCode AgentTool shape", () => {
    const claudeTool: ClaudeTool = {
      name: "search_web",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const result = mapClaudeTool(claudeTool);
    expect(result.definition.name).toBe("search_web");
    expect(result.definition.description).toBe("Search the web");
    expect(result.definition.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
    });
    expect(typeof result.execute).toBe("function");
  });

  it("defaults effect to read", () => {
    const claudeTool: ClaudeTool = {
      name: "read",
      description: "read",
      inputSchema: { type: "object" },
    };
    const result = mapClaudeTool(claudeTool);
    expect(result.definition.effect).toBe("read");
  });
});

describe("mapClaudeHooks()", () => {
  it("maps PreToolUse to beforeTool", () => {
    const claudeHooks: ClaudeHooks = {
      PreToolUse: async () => ({ decision: "allow" }),
    };
    const result = mapClaudeHooks(claudeHooks);
    expect(result.beforeTool).toBeDefined();
  });

  it("maps PostToolUse to postToolUse", () => {
    const claudeHooks: ClaudeHooks = {
      PostToolUse: async () => {},
    };
    const result = mapClaudeHooks(claudeHooks);
    expect(result.postToolUse).toBeDefined();
  });

  it("maps Stop to stop", () => {
    const claudeHooks: ClaudeHooks = {
      Stop: async () => {},
    };
    const result = mapClaudeHooks(claudeHooks);
    expect(result.stop).toBeDefined();
  });

  it("maps SessionStart to sessionStart", () => {
    const claudeHooks: ClaudeHooks = {
      SessionStart: async () => {},
    };
    const result = mapClaudeHooks(claudeHooks);
    expect(result.sessionStart).toBeDefined();
  });

  it("maps SessionEnd to sessionEnd", () => {
    const claudeHooks: ClaudeHooks = {
      SessionEnd: async () => {},
    };
    const result = mapClaudeHooks(claudeHooks);
    expect(result.sessionEnd).toBeDefined();
  });

  it("returns empty object for no hooks", () => {
    const result = mapClaudeHooks({});
    expect(result.beforeTool).toBeUndefined();
    expect(result.postToolUse).toBeUndefined();
    expect(result.stop).toBeUndefined();
  });
});
