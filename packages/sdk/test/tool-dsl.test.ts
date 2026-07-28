import { describe, expect, it } from "vitest";
import { tool } from "../src/index.js";

describe("tool() DSL", () => {
  it("creates an AgentTool from name, parameters, and handler", () => {
    const echo = tool(
      "echo",
      {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      async (args) => ({ content: String(args.message ?? "") }),
    );

    expect(echo.definition.name).toBe("echo");
    expect(echo.definition.parameters).toMatchObject({
      type: "object",
      properties: { message: { type: "string" } },
    });
    expect(typeof echo.execute).toBe("function");
  });

  it("infers effect='read' by default and allows override via options", () => {
    const reader = tool("read", { type: "object" }, async () => ({ content: "ok" }));
    expect(reader.definition.effect).toBe("read");

    const writer = tool("write", { type: "object" }, async () => ({ content: "wrote" }), {
      effect: "write",
    });
    expect(writer.definition.effect).toBe("write");
  });

  it("derives label from name and accepts description via options", () => {
    const t = tool("search_files", { type: "object" }, async () => ({ content: "[]" }), {
      description: "Search files by glob pattern",
    });
    expect(t.definition.label).toBe("search_files");
    expect(t.definition.description).toBe("Search files by glob pattern");
  });

  it("passes arguments and context to the handler", async () => {
    const greeter = tool(
      "greet",
      { type: "object", properties: { name: { type: "string" } } },
      async (args, ctx) => ({
        content: `Hello ${args.name ?? "world"} from ${ctx.cwd}`,
      }),
    );

    const result = await greeter.execute({ name: "Alice" }, { cwd: "/tmp/test" });
    expect(result.content).toBe("Hello Alice from /tmp/test");
    expect(result.isError).toBeUndefined();
  });

  it("supports returning isError from the handler", async () => {
    const failer = tool("fail", { type: "object" }, async () => ({
      content: "boom",
      isError: true,
    }));
    const result = await failer.execute({}, { cwd: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("boom");
  });
});
