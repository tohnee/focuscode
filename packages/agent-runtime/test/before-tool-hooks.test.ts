import { describe, expect, it } from "vitest";
import { ExtensionHost, type BeforeToolContext } from "../src/extensions.js";
import { AgentToolRegistry, createCodingToolRegistry } from "../src/tools.js";
import { createTestDirectory } from "@focuscode/testkit";
import type { AgentTool } from "../src/types.js";

function mockTool(name: string): AgentTool {
  return {
    definition: {
      name,
      label: name,
      description: `mock ${name}`,
      parameters: { type: "object", properties: {} },
      effect: "read",
    },
    async execute() {
      return { content: `${name} executed` };
    },
  };
}

describe("beforeTool hooks", () => {
  it("allows tool execution when no hooks registered", async () => {
    const cwd = await createTestDirectory("beforetool-no-hooks");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    const ctx: BeforeToolContext = {
      toolName: "read",
      arguments: { path: "/tmp/test" },
      cwd,
    };
    const result = await host.checkBeforeTool?.(ctx);
    expect(result).toBeUndefined();
  });

  it("allows tool execution when hook returns {allow: true}", async () => {
    const cwd = await createTestDirectory("beforetool-allow");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    host["api"]().beforeTool(() => ({ allow: true }));
    const ctx: BeforeToolContext = {
      toolName: "read",
      arguments: {},
      cwd,
    };
    const result = await host.checkBeforeTool?.(ctx);
    expect(result).toBeUndefined();
  });

  it("vetoes tool execution when hook returns {allow: false}", async () => {
    const cwd = await createTestDirectory("beforetool-veto");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    host["api"]().beforeTool(() => ({
      allow: false,
      reason: "blocked by test hook",
    }));
    const ctx: BeforeToolContext = {
      toolName: "bash",
      arguments: { command: "rm -rf /" },
      cwd,
    };
    const result = await host.checkBeforeTool?.(ctx);
    expect(result?.allow).toBe(false);
    expect(result?.reason).toBe("blocked by test hook");
  });

  it("first veto wins when multiple hooks registered", async () => {
    const cwd = await createTestDirectory("beforetool-first-veto");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    const api = host["api"]();
    api.beforeTool(() => ({ allow: true }));
    api.beforeTool(() => ({ allow: false, reason: "second hook blocks" }));
    api.beforeTool(() => ({ allow: false, reason: "third hook blocks" }));
    const ctx: BeforeToolContext = { toolName: "read", arguments: {}, cwd };
    const result = await host.checkBeforeTool?.(ctx);
    expect(result?.allow).toBe(false);
    expect(result?.reason).toBe("second hook blocks");
  });

  it("fails open when hook throws", async () => {
    const cwd = await createTestDirectory("beforetool-throw");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    host["api"]().beforeTool(() => {
      throw new Error("buggy hook");
    });
    const ctx: BeforeToolContext = { toolName: "read", arguments: {}, cwd };
    const result = await host.checkBeforeTool?.(ctx);
    expect(result).toBeUndefined();
  });

  it("receives correct context with toolName and arguments", async () => {
    const cwd = await createTestDirectory("beforetool-context");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    let capturedCtx: BeforeToolContext | undefined;
    host["api"]().beforeTool((ctx) => {
      capturedCtx = ctx;
      return { allow: true };
    });
    const inputCtx: BeforeToolContext = {
      toolName: "write",
      arguments: { path: "/tmp/foo", content: "bar" },
      cwd,
    };
    await host.checkBeforeTool?.(inputCtx);
    expect(capturedCtx?.toolName).toBe("write");
    expect(capturedCtx?.arguments.path).toBe("/tmp/foo");
    expect(capturedCtx?.cwd).toBe(cwd);
  });

  it("supports async hooks", async () => {
    const cwd = await createTestDirectory("beforetool-async");
    const registry = await createCodingToolRegistry(cwd);
    const host = new ExtensionHost(registry);
    host["api"]().beforeTool(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { allow: false, reason: "async veto" };
    });
    const ctx: BeforeToolContext = { toolName: "read", arguments: {}, cwd };
    const result = await host.checkBeforeTool?.(ctx);
    expect(result?.allow).toBe(false);
    expect(result?.reason).toBe("async veto");
  });
});
