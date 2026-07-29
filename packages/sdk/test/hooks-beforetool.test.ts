import { describe, expect, it } from "vitest";
import { createHooks, dispatchAgentEvent, type AgentHooks } from "../src/hooks.js";
import type { AgentEvent, ToolExecutionResult } from "@focuscode/agent-runtime";

describe("beforeTool 统一到 SDK hooks", () => {
  it("AgentHooks includes preToolUse hook", () => {
    const hooks: AgentHooks = {
      preToolUse: async (context) => {
        expect(context.toolName).toBe("bash");
        return { allow: false, reason: "blocked by SDK hook" };
      },
    };
    expect(hooks.preToolUse).toBeDefined();
  });

  it("preToolUse can veto tool execution", async () => {
    let called = false;
    const hooks: AgentHooks = {
      preToolUse: async (context) => {
        called = true;
        expect(context.toolName).toBe("bash");
        expect(context.arguments).toEqual({ command: "rm -rf /" });
        return { allow: false, reason: "dangerous command" };
      },
    };
    // This would be called by the agent loop before executing a tool
    const result = await hooks.preToolUse!({
      toolName: "bash",
      arguments: { command: "rm -rf /" },
      cwd: "/test",
    });
    expect(called).toBe(true);
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("dangerous command");
  });

  it("preToolUse returning allow:true permits execution", async () => {
    const hooks: AgentHooks = {
      preToolUse: async () => ({ allow: true }),
    };
    const result = await hooks.preToolUse!({
      toolName: "read",
      arguments: { path: "/safe" },
      cwd: "/test",
    });
    expect(result.allow).toBe(true);
  });

  it("preToolUse returning undefined permits execution (fail-open)", async () => {
    const hooks: AgentHooks = {
      preToolUse: async () => undefined,
    };
    const result = await hooks.preToolUse!({
      toolName: "read",
      arguments: { path: "/safe" },
      cwd: "/test",
    });
    expect(result).toBeUndefined();
  });

  it("preToolUse errors propagate to caller", async () => {
    const hooks: AgentHooks = {
      preToolUse: async () => {
        throw new Error("hook failed");
      },
    };
    await expect(
      hooks.preToolUse!({
        toolName: "bash",
        arguments: {},
        cwd: "/test",
      }),
    ).rejects.toThrow("hook failed");
  });

  it("dispatchAgentEvent routes tool_start to preToolUse", async () => {
    let called = false;
    const hooks: AgentHooks = {
      preToolUse: async (context) => {
        called = true;
        expect(context.toolName).toBe("bash");
        return { allow: true };
      },
    };
    const event: AgentEvent = {
      type: "tool_start",
      call: { id: "call-1", name: "bash", arguments: { command: "ls" } },
    };
    // Note: dispatchAgentEvent currently does NOT route tool_start to preToolUse
    // This test documents the expected behavior after the fix
    await dispatchAgentEvent(hooks, event, { cwd: "/test" });
    // Currently this will fail because dispatchAgentEvent doesn't handle tool_start
    // After the fix, called should be true
    expect(called).toBe(true);
  });
});
