import { describe, expect, it } from "vitest";
import { AgentToolRegistry } from "../src/tools.js";
import type { AgentTool } from "../src/types.js";

function makeTool(name: string): AgentTool {
  return {
    definition: {
      name,
      label: name,
      description: `fixture tool ${name}`,
      parameters: {},
      effect: "read",
    },
    execute: async () => ({ content: "ok", isError: false }),
  };
}

describe("AgentToolRegistry.freeze", () => {
  it("throws on register after freeze", () => {
    const registry = new AgentToolRegistry();
    registry.freeze();
    expect(() => registry.register(makeTool("late"))).toThrow(/frozen/);
  });

  it("throws on unregister after freeze", () => {
    const registry = new AgentToolRegistry([makeTool("read")]);
    registry.freeze();
    expect(() => registry.unregister("read")).toThrow(/frozen/);
  });

  it("keeps existing tools readable after freeze", () => {
    const registry = new AgentToolRegistry([makeTool("read"), makeTool("write")]);
    registry.freeze();
    expect(registry.get("read")).toBeDefined();
    expect(registry.definitions().map((tool) => tool.name)).toEqual(["read", "write"]);
  });

  it("is idempotent: double freeze still rejects mutations", () => {
    const registry = new AgentToolRegistry([makeTool("read")]);
    registry.freeze();
    registry.freeze();
    expect(() => registry.register(makeTool("late"))).toThrow(/frozen/);
  });

  it("register before freeze still succeeds", () => {
    const registry = new AgentToolRegistry();
    registry.register(makeTool("early"));
    registry.freeze();
    expect(registry.get("early")).toBeDefined();
    expect(registry.definitions()).toHaveLength(1);
  });

  it("unregister before freeze still succeeds", () => {
    const registry = new AgentToolRegistry([makeTool("read"), makeTool("write")]);
    expect(registry.unregister("write")).toBe(true);
    registry.freeze();
    expect(registry.get("write")).toBeUndefined();
  });
});
