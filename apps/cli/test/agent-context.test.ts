import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { createAgentContext } from "../src/agent-context.js";

describe("createAgentContext", () => {
  it("returns sandbox, registry, resources, client, and config", async () => {
    const cwd = await createTestDirectory("agent-context");
    const ctx = await createAgentContext({
      cwd,
      configOverrides: { provider: "ollama", model: "test-model", sandbox: { kind: "host" } },
    });
    expect(ctx.cwd).toBe(cwd);
    expect(ctx.sandbox).toBeDefined();
    expect(ctx.registry).toBeDefined();
    expect(ctx.resources).toBeDefined();
    expect(ctx.client).toBeDefined();
    expect(ctx.config).toBeDefined();
    expect(ctx.config.model.provider).toBeDefined();
    expect(ctx.config.model.model).toBeDefined();
  });

  it("applies config overrides", async () => {
    const cwd = await createTestDirectory("agent-context-override");
    const ctx = await createAgentContext({
      cwd,
      configOverrides: { provider: "ollama", model: "test-model", sandbox: { kind: "host" } },
    });
    expect(ctx.config.model.provider).toBe("ollama");
    expect(ctx.config.model.model).toBe("test-model");
  });
});
