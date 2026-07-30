import { describe, expect, it } from "vitest";
import {
  createSlashCommandRegistry,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../src/slash-command-registry.js";

/** Minimal context stub for testing — real contexts add cwd/agent/sessions. */
function makeContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    cwd: "/tmp/test",
    args: "",
    ...overrides,
  };
}

describe("SlashCommandRegistry", () => {
  it("registers and dispatches a command by name", async () => {
    const registry = createSlashCommandRegistry();
    const command: SlashCommand = {
      name: "status",
      description: "Show status",
      modes: ["interactive", "tui", "rpc"],
      execute: async (ctx) => `status for ${ctx.cwd}`,
    };
    registry.register(command);

    const result = await registry.dispatch("status", makeContext({ cwd: "/repo" }));
    expect(result).toBe("status for /repo");
  });

  it("returns undefined for an unknown command", async () => {
    const registry = createSlashCommandRegistry();
    const result = await registry.dispatch("nonexistent", makeContext());
    expect(result).toBeUndefined();
  });

  it("passes parsed args (name + remainder) to the handler", async () => {
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "model",
      description: "Change model",
      modes: ["interactive", "tui"],
      execute: async (ctx) => `model args: "${ctx.args}"`,
    });

    const result = await registry.dispatch("model kimi/k2", makeContext());
    expect(result).toBe('model args: "kimi/k2"');
  });

  it("lists all registered commands for completion and help", () => {
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "status",
      description: "d1",
      modes: ["interactive"],
      execute: async () => undefined,
    });
    registry.register({
      name: "tools",
      description: "d2",
      modes: ["tui"],
      execute: async () => undefined,
    });

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name).sort()).toEqual(["status", "tools"]);
  });

  it("filters commands by mode so each surface sees only its own", () => {
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "status",
      description: "",
      modes: ["interactive", "tui"],
      execute: async () => undefined,
    });
    registry.register({
      name: "abort",
      description: "",
      modes: ["rpc"],
      execute: async () => undefined,
    });
    registry.register({
      name: "tools",
      description: "",
      modes: ["interactive"],
      execute: async () => undefined,
    });

    const interactive = registry.listForMode("interactive");
    const rpc = registry.listForMode("rpc");
    const tui = registry.listForMode("tui");

    expect(interactive.map((c) => c.name).sort()).toEqual(["status", "tools"]);
    expect(rpc.map((c) => c.name)).toEqual(["abort"]);
    expect(tui.map((c) => c.name)).toEqual(["status"]);
  });

  it("supports aliases (e.g. quit → exit)", async () => {
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "exit",
      aliases: ["quit"],
      description: "Leave",
      modes: ["interactive", "tui"],
      execute: async () => "bye",
    });

    expect(await registry.dispatch("exit", makeContext())).toBe("bye");
    expect(await registry.dispatch("quit", makeContext())).toBe("bye");
  });

  it("rejects duplicate command names to prevent shadowing", () => {
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "status",
      description: "",
      modes: ["interactive"],
      execute: async () => undefined,
    });
    expect(() =>
      registry.register({
        name: "status",
        description: "",
        modes: ["interactive"],
        execute: async () => undefined,
      }),
    ).toThrow(/already registered/);
  });

  it("handler can signal no-output by returning undefined", async () => {
    const registry = createSlashCommandRegistry();
    registry.register({
      name: "silent",
      description: "",
      modes: ["interactive"],
      execute: async () => undefined,
    });

    const result = await registry.dispatch("silent", makeContext());
    expect(result).toBeUndefined();
  });

  it("handler can return a void action (e.g. side-effect only)", async () => {
    const registry = createSlashCommandRegistry();
    let sideEffect = 0;
    registry.register({
      name: "bump",
      description: "",
      modes: ["interactive"],
      execute: async () => {
        sideEffect += 1;
      },
    });

    const result = await registry.dispatch("bump", makeContext());
    expect(result).toBeUndefined();
    expect(sideEffect).toBe(1);
  });
});
