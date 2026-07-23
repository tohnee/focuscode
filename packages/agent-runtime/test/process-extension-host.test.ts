import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { AgentToolRegistry, ProcessExtensionHost, resolveAgentConfig } from "../src/index.js";

// The runner is spawned as a child process, so it must come from the built
// output even when vitest transpiles the surrounding sources on the fly.
const RUNNER_PATH = fileURLToPath(new URL("../dist/extension-runner.js", import.meta.url));

function fixtureExtension(options: {
  name: string;
  toolName: string;
  commandName: string;
}): string {
  return `export const name = ${JSON.stringify(options.name)};
let lastEvent = null;
export default function activate(api) {
  api.registerTool({
    definition: {
      name: ${JSON.stringify(options.toolName)},
      label: "Echo",
      description: "Echo arguments back",
      parameters: { type: "object" },
      effect: "read",
    },
    async execute(args, context) {
      if (args.fail) throw new Error("boom: " + String(args.fail));
      if (args.crash) process.exit(42);
      if (args.hang) await new Promise(() => {});
      return { content: "echo:" + JSON.stringify(args) + " cwd=" + context.cwd };
    },
  });
  api.registerTool({
    definition: {
      name: ${JSON.stringify(`${options.toolName}_event`)},
      label: "Last event",
      description: "Return the last agent event observed by this extension",
      parameters: { type: "object", additionalProperties: false },
      effect: "read",
    },
    async execute() {
      return { content: JSON.stringify(lastEvent) };
    },
  });
  api.registerCommand({
    name: ${JSON.stringify(options.commandName)},
    description: "Fixture command",
    execute: (args, context) => "cmd:" + args + ":" + context.sessionId,
  });
  api.onEvent((event) => {
    lastEvent = event;
  });
  api.appendSystemPrompt("  fixture prompt fragment  ");
}
`;
}

async function writeExtension(
  root: string,
  file: string,
  options: { name: string; toolName: string; commandName: string },
): Promise<string> {
  const entry = join(root, file);
  await writeFile(entry, fixtureExtension(options));
  return entry;
}

describe("ProcessExtensionHost", () => {
  it("round-trips tools, commands, prompt fragments and events over stdio", async () => {
    const root = await createTestDirectory("process-ext-roundtrip");
    const entry = await writeExtension(root, "fixture.mjs", {
      name: "fixture",
      toolName: "echo_tool",
      commandName: "fixture-cmd",
    });
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
    try {
      const loaded = await host.load([entry]);
      expect(loaded).toMatchObject([{ path: entry, name: "fixture", status: "running" }]);
      expect(typeof loaded[0]!.pid).toBe("number");

      const tool = registry.get("echo_tool");
      expect(tool).toBeDefined();
      const result = await tool!.execute({ text: "hi" }, { cwd: root });
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe(`echo:{"text":"hi"} cwd=${root}`);

      expect(host.commandList().map((command) => command.name)).toEqual(["fixture-cmd"]);
      const command = host.getCommand("fixture-cmd");
      expect(command).toBeDefined();
      await expect(command!.execute("hello", { sessionId: "s1", cwd: root })).resolves.toBe(
        "cmd:hello:s1",
      );

      expect(host.systemPrompt()).toBe("fixture prompt fragment");

      await host.emit({ type: "agent_start", sessionId: "s1", turn: 1 });
      const observed = await registry.get("echo_tool_event")!.execute({}, { cwd: root });
      expect(JSON.parse(observed.content)).toMatchObject({
        type: "agent_start",
        sessionId: "s1",
        turn: 1,
      });
    } finally {
      await host.dispose();
    }
  });

  it("wraps extension tool failures as isError and keeps the host alive", async () => {
    const root = await createTestDirectory("process-ext-errors");
    const entry = await writeExtension(root, "fixture.mjs", {
      name: "fixture",
      toolName: "echo_tool",
      commandName: "fixture-cmd",
    });
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
    try {
      await host.load([entry]);
      const tool = registry.get("echo_tool")!;
      const failure = await tool.execute({ fail: "kaboom" }, { cwd: root });
      expect(failure.isError).toBe(true);
      expect(failure.content).toContain("Extension tool failed");
      expect(failure.content).toContain("boom: kaboom");
      const after = await tool.execute({ text: "still-alive" }, { cwd: root });
      expect(after.isError).toBeUndefined();
      expect(host.list()).toMatchObject([{ name: "fixture", status: "running" }]);
    } finally {
      await host.dispose();
    }
  });

  it("marks a crashed extension dead and isolates the other extensions", async () => {
    const root = await createTestDirectory("process-ext-crash");
    const first = await writeExtension(root, "first.mjs", {
      name: "ext-a",
      toolName: "a_tool",
      commandName: "a-cmd",
    });
    const second = await writeExtension(root, "second.mjs", {
      name: "ext-b",
      toolName: "b_tool",
      commandName: "b-cmd",
    });
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
    try {
      await host.load([first, second]);
      const crashed = await registry.get("a_tool")!.execute({ crash: true }, { cwd: root });
      expect(crashed.isError).toBe(true);

      expect(host.list()).toMatchObject([
        { name: "ext-a", status: "dead" },
        { name: "ext-b", status: "running" },
      ]);

      // A dead extension is no longer routed work.
      const again = await registry.get("a_tool")!.execute({ text: "noop" }, { cwd: root });
      expect(again.isError).toBe(true);
      expect(again.content).toContain("not running");

      // The surviving extension still executes tools and receives events.
      const alive = await registry.get("b_tool")!.execute({ text: "ok" }, { cwd: root });
      expect(alive.isError).toBeUndefined();
      await host.emit({ type: "agent_start", sessionId: "s2", turn: 2 });
      const observed = await registry.get("b_tool_event")!.execute({}, { cwd: root });
      expect(JSON.parse(observed.content)).toMatchObject({ type: "agent_start", turn: 2 });
    } finally {
      await host.dispose();
    }
  });

  it("reloads extensions into fresh child processes", async () => {
    const root = await createTestDirectory("process-ext-reload");
    const entry = await writeExtension(root, "fixture.mjs", {
      name: "fixture",
      toolName: "echo_tool",
      commandName: "fixture-cmd",
    });
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
    try {
      const [before] = await host.load([entry]);
      const reloaded = await host.reload();
      expect(reloaded).toMatchObject([{ path: entry, name: "fixture", status: "running" }]);
      expect(reloaded[0]!.pid).not.toBe(before!.pid);

      // Non-base tools were unregistered and re-registered without a duplicate error.
      const result = await registry.get("echo_tool")!.execute({ text: "again" }, { cwd: root });
      expect(result.isError).toBeUndefined();
      expect(host.systemPrompt()).toBe("fixture prompt fragment");
      expect(host.commandList().map((command) => command.name)).toEqual(["fixture-cmd"]);
    } finally {
      await host.dispose();
    }
  });

  it("dispose kills all child processes and clears registrations", async () => {
    const root = await createTestDirectory("process-ext-dispose");
    const entry = await writeExtension(root, "fixture.mjs", {
      name: "fixture",
      toolName: "echo_tool",
      commandName: "fixture-cmd",
    });
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
    await host.load([entry]);
    const pid = host.list()[0]!.pid!;
    await host.dispose();
    expect(host.list()).toEqual([]);
    expect(registry.get("echo_tool")).toBeUndefined();
    expect(host.commandList()).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("times out a hung tool execution and stays usable", async () => {
    const root = await createTestDirectory("process-ext-timeout");
    const entry = await writeExtension(root, "fixture.mjs", {
      name: "fixture",
      toolName: "echo_tool",
      commandName: "fixture-cmd",
    });
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, {
      runnerPath: RUNNER_PATH,
      toolTimeoutMs: 300,
    });
    try {
      await host.load([entry]);
      const tool = registry.get("echo_tool")!;
      const hung = await tool.execute({ hang: true }, { cwd: root });
      expect(hung.isError).toBe(true);
      expect(hung.content).toContain("timed out");
      const after = await tool.execute({ text: "later" }, { cwd: root });
      expect(after.isError).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("rejects load when the extension factory throws and cleans up registrations", async () => {
    const root = await createTestDirectory("process-ext-bad-factory");
    const entry = join(root, "bad.mjs");
    await writeFile(
      entry,
      `export default function activate(api) {
  api.registerTool({
    definition: { name: "bad_tool", label: "Bad", description: "bad", parameters: { type: "object" }, effect: "read" },
    async execute() { return { content: "x" }; },
  });
  throw new Error("factory exploded");
}
`,
    );
    const registry = new AgentToolRegistry();
    const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
    try {
      await expect(host.load([entry])).rejects.toThrow("Failed to load extension");
      await expect(host.load([entry])).rejects.toThrow("factory exploded");
      expect(registry.get("bad_tool")).toBeUndefined();
      expect(host.list()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});

describe("extensions.host configuration", () => {
  it("defaults to in-process, accepts process and rejects unknown hosts", async () => {
    const root = await createTestDirectory("process-ext-config");
    const base = {
      provider: "ollama",
      model: "fixture",
      globalConfigPath: join(root, "missing-global.json"),
      projectConfigPath: join(root, "missing-project.json"),
    };
    const defaults = await resolveAgentConfig(root, base);
    expect(defaults.extensions.host).toBe("in-process");
    const processHost = await resolveAgentConfig(root, {
      ...base,
      extensions: { host: "process" },
    });
    expect(processHost.extensions.host).toBe("process");
    await expect(
      resolveAgentConfig(root, { ...base, extensions: { host: "sidecar" as never } }),
    ).rejects.toThrow("extensions.host must be one of");
  });
});
