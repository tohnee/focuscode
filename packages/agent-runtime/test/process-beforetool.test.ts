import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { AgentToolRegistry, ProcessExtensionHost } from "../src/index.js";
import type { BeforeToolContext, BeforeToolResult } from "../src/extensions.js";

// The runner is spawned as a child process, so it must come from the built
// output even when vitest transpiles the surrounding sources on the fly.
const RUNNER_PATH = fileURLToPath(new URL("../dist/extension-runner.js", import.meta.url));

const CONTEXT: BeforeToolContext = {
  toolName: "write",
  arguments: { path: "test.txt", content: "hello" },
  cwd: "/tmp",
};

async function writeFixture(root: string, file: string, code: string): Promise<string> {
  const entry = join(root, file);
  await writeFile(entry, code);
  return entry;
}

/** Fixture: extension that vetoes all tool calls. */
const VETO_FIXTURE = `
export const name = "veto-ext";
export default function(api) {
  api.beforeTool(() => ({ allow: false, reason: "blocked by test veto" }));
}
`;

/** Fixture: extension that allows all tool calls. */
const ALLOW_FIXTURE = `
export const name = "allow-ext";
export default function(api) {
  api.beforeTool(() => ({ allow: true }));
}
`;

/** Fixture: extension whose beforeTool hook throws. */
const THROW_FIXTURE = `
export const name = "throw-ext";
export default function(api) {
  api.beforeTool(() => { throw new Error("hook crashed"); });
}
`;

/** Fixture: extension whose beforeTool hook never resolves. */
const HANG_FIXTURE = `
export const name = "hang-ext";
export default function(api) {
  api.beforeTool(() => new Promise(() => {}));
}
`;

/** Fixture: extension with a crash tool and a beforeTool veto. */
const CRASH_VETO_FIXTURE = `
export const name = "crash-veto-ext";
export default function(api) {
  api.registerTool({
    definition: { name: "crash_tool", label: "Crash", description: "crash", parameters: { type: "object" }, effect: "read" },
    async execute(args) { if (args.crash) process.exit(42); return { content: "ok" }; },
  });
  api.beforeTool(() => ({ allow: false, reason: "veto from crash-veto-ext" }));
}
`;

/** Fixture: extension with no beforeTool hook. */
const NO_HOOK_FIXTURE = `
export const name = "no-hook-ext";
export default function(api) {
  api.appendSystemPrompt("no hooks here");
}
`;

describe("ProcessExtensionHost.checkBeforeTool (D4: cross-process beforeTool)", () => {
  describe("basic hook behavior", () => {
    it("T1: returns undefined when no beforeTool hooks are registered", async () => {
      const root = await createTestDirectory("d4-t1-no-hook");
      const entry = await writeFixture(root, "ext.mjs", NO_HOOK_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([entry]);
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toBeUndefined();
      } finally {
        await host.dispose();
      }
    });

    it("T2: returns veto when child extension vetoes", async () => {
      const root = await createTestDirectory("d4-t2-veto");
      const entry = await writeFixture(root, "ext.mjs", VETO_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([entry]);
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toEqual({ allow: false, reason: "blocked by test veto" });
      } finally {
        await host.dispose();
      }
    });

    it("T3: returns undefined when child hook allows", async () => {
      const root = await createTestDirectory("d4-t3-allow");
      const entry = await writeFixture(root, "ext.mjs", ALLOW_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([entry]);
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toBeUndefined();
      } finally {
        await host.dispose();
      }
    });

    it("T4: returns undefined when child hook throws (fail-open)", async () => {
      const root = await createTestDirectory("d4-t4-throw");
      const entry = await writeFixture(root, "ext.mjs", THROW_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([entry]);
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toBeUndefined();
      } finally {
        await host.dispose();
      }
    });
  });

  describe("timeout and error handling", () => {
    it("T5: returns undefined when child times out (fail-open)", async () => {
      const root = await createTestDirectory("d4-t5-timeout");
      const entry = await writeFixture(root, "ext.mjs", HANG_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, {
        runnerPath: RUNNER_PATH,
        toolTimeoutMs: 300,
      });
      try {
        await host.load([entry]);
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toBeUndefined();
        // Host should still be usable after timeout
        expect(host.list()).toMatchObject([{ name: "hang-ext", status: "running" }]);
      } finally {
        await host.dispose();
      }
    });
  });

  describe("multi-extension semantics", () => {
    it("T6: first veto wins across multiple extensions", async () => {
      const root = await createTestDirectory("d4-t6-multi-veto");
      const allowEntry = await writeFixture(root, "allow.mjs", ALLOW_FIXTURE);
      const vetoEntry = await writeFixture(root, "veto.mjs", VETO_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([allowEntry, vetoEntry]);
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toEqual({ allow: false, reason: "blocked by test veto" });
      } finally {
        await host.dispose();
      }
    });

    it("T7: dead extension is skipped", async () => {
      const root = await createTestDirectory("d4-t7-dead-skip");
      const entry = await writeFixture(root, "ext.mjs", CRASH_VETO_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([entry]);
        // Crash the extension
        const tool = registry.get("crash_tool")!;
        await tool.execute({ crash: true }, { cwd: root });
        expect(host.list()).toMatchObject([{ name: "crash-veto-ext", status: "dead" }]);
        // Dead extension should be skipped — no veto returned
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toBeUndefined();
      } finally {
        await host.dispose();
      }
    });

    it("T8: dead extension skipped, surviving extension still checked", async () => {
      const root = await createTestDirectory("d4-t8-dead-alive");
      const crashEntry = await writeFixture(root, "crash.mjs", CRASH_VETO_FIXTURE);
      const vetoEntry = await writeFixture(root, "veto.mjs", VETO_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });
      try {
        await host.load([crashEntry, vetoEntry]);
        // Crash the first extension
        const tool = registry.get("crash_tool")!;
        await tool.execute({ crash: true }, { cwd: root });
        expect(host.list()).toMatchObject([
          { name: "crash-veto-ext", status: "dead" },
          { name: "veto-ext", status: "running" },
        ]);
        // Dead extension skipped, surviving extension's veto should be returned
        const result = await host.checkBeforeTool!(CONTEXT);
        expect(result).toEqual({ allow: false, reason: "blocked by test veto" });
      } finally {
        await host.dispose();
      }
    });
  });

  describe("IPC logging", () => {
    it("T9: emits structured log messages for IPC tracing", async () => {
      const root = await createTestDirectory("d4-t9-logging");
      const entry = await writeFixture(root, "ext.mjs", VETO_FIXTURE);
      const registry = new AgentToolRegistry();
      const host = new ProcessExtensionHost(registry, { runnerPath: RUNNER_PATH });

      // Capture stderr output for log assertion
      const originalWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stderr.write;

      try {
        await host.load([entry]);
        await host.checkBeforeTool!(CONTEXT);

        const allLogs = captured.join("");
        // L1: parent sends request
        expect(allLogs).toContain("[beforeTool] request");
        // L4/L6: parent logs decision
        expect(allLogs).toContain("[beforeTool] decision");
        // L2: child receives check (forwarded with [ext:...] prefix)
        expect(allLogs).toContain("[beforeTool] recv");
      } finally {
        process.stderr.write = originalWrite;
        await host.dispose();
      }
    });
  });
});
