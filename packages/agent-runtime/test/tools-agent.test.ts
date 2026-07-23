import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  SessionStore,
  createCodingToolRegistry,
  type AgentEvent,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture",
  protocol: "openai-chat",
  baseUrl: "http://fixture",
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
  temperature: 0,
  toolMode: "native",
};

describe("coding tools", () => {
  it("reads, searches, edits, patches, inspects git and runs scrubbed commands", async () => {
    const root = await createTestDirectory("agent-tools");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const value = 1;\n");
    const init = spawnSync("git", ["init", "-q"], { cwd: root });
    expect(init.status).toBe(0);
    const registry = await createCodingToolRegistry(root, { maxOutputChars: 10_000 });
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = registry.get(name);
      if (!tool) throw new Error(`missing ${name}`);
      return tool.execute(args, { cwd: root });
    };

    expect((await run("read", { path: "src/a.ts" })).content).toContain("value = 1");
    expect((await run("ls", { path: "src" })).content).toContain("a.ts");
    expect((await run("find", { glob: "*.ts" })).content).toContain("src/a.ts");
    expect((await run("grep", { pattern: "value", path: "src" })).content).toContain("a.ts");
    await run("edit", {
      path: "src/a.ts",
      oldText: "value = 1",
      newText: "value = 2",
    });
    await run("write", { path: "src/b.ts", content: "export const b = true;\n" });
    await run("apply_patch", {
      patch:
        "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const value = 2;\n+export const value = 3;\n",
    });
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toContain("value = 3");
    expect((await run("git_status", {})).content).toContain("src/");
    expect((await run("git_diff", {})).content).toContain("No diff");

    process.env.FOCUSCODE_FAKE_SECRET = "must-not-leak";
    try {
      const shell = await run("bash", {
        command: 'printf "%s" "${FOCUSCODE_FAKE_SECRET:-missing}"',
      });
      expect(shell.content).toContain("missing");
      expect(shell.content).not.toContain("must-not-leak");
    } finally {
      delete process.env.FOCUSCODE_FAKE_SECRET;
    }
  });
});

describe("CodingAgent", () => {
  it("runs a multi-round model/tool loop, persists evidence and emits lifecycle events", async () => {
    const root = await createTestDirectory("coding-agent");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          { id: "write-1", name: "write", arguments: { path: "hello.txt", content: "hello\n" } },
        ],
        usage: { inputTokens: 20, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{ id: "read-1", name: "read", arguments: { path: "hello.txt" } }],
        usage: { inputTokens: 25, outputTokens: 4 },
        stopReason: "tool_use",
      },
      {
        content: "Created and verified hello.txt.",
        toolCalls: [],
        usage: { inputTokens: 30, outputTokens: 7 },
        stopReason: "stop",
      },
    ]);
    const events: AgentEvent[] = [];
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient,
      tools: registry.values(),
      permission: {
        mode: "auto-edit",
        projectTrusted: true,
        protectedPaths: [".env", ".focuscode"],
      },
      sessionStore: new SessionStore("unused", false),
      maxRounds: 8,
      eventSink: (event) => events.push(event),
    });
    const result = await agent.submit("Create hello.txt");
    expect(result).toMatchObject({ rounds: 3, toolCalls: 2, stopped: "stop" });
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hello\n");
    expect(agent.snapshot().entries).toHaveLength(6);
    expect(events.map((event) => event.type)).toContain("tool_end");
    expect(agent.toolDefinitions().map((tool) => tool.name)).toContain("write");
    expect((await agent.status()).usage).toEqual({ inputTokens: 75, outputTokens: 16 });
    await agent.nameSession("fixture session");
    expect((await agent.status()).sessionName).toBe("fixture session");
    expect(await agent.forkSession()).toContain("session_");
    expect(await agent.newSession("new")).toContain("session_");
  });

  it("denies critical direct shell tools even in full-auto mode", async () => {
    const root = await createTestDirectory("coding-agent-deny");
    const registry = await createCodingToolRegistry(root);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: new QueueModelClient([]),
      tools: registry.values(),
      permission: {
        mode: "full-auto",
        projectTrusted: true,
        protectedPaths: [".env"],
      },
      sessionStore: new SessionStore("unused", false),
    });
    expect(await agent.runTool("bash", { command: "rm -rf /" })).toMatchObject({
      isError: true,
    });
    agent.changeApproval("deny");
    expect((await agent.status()).approval).toBe("deny");
  });

  it("pairs direct tool runs with an assistant call so later turns stay well-formed", async () => {
    const root = await createTestDirectory("coding-agent-runtool");
    const registry = await createCodingToolRegistry(root);
    const client = new QueueModelClient([
      {
        content: "continued",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: registry.values(),
      permission: {
        mode: "full-auto",
        projectTrusted: true,
        protectedPaths: [],
      },
      sessionStore: new SessionStore("unused", false),
    });
    await agent.runTool("bash", { command: "echo hi" });
    await agent.submit("continue");

    const messages = agent.snapshot().entries.map((entry) => entry.message);
    const callIndex = messages.findIndex(
      (message) => message.role === "assistant" && message.toolCalls?.length,
    );
    const resultIndex = messages.findIndex((message) => message.role === "tool");
    expect(callIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(messages[resultIndex]!.toolCallId).toBe(messages[callIndex]!.toolCalls![0]!.id);

    // Providers reject orphan tool results; every tool message sent to the
    // model must answer a preceding assistant toolCalls entry.
    const request = client.requests[0]!;
    const knownCallIds = new Set(
      request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
    );
    for (const message of request.messages) {
      if (message.role === "tool") expect(knownCallIds.has(message.toolCallId!)).toBe(true);
    }
  });
});

class QueueModelClient implements ModelClient {
  readonly protocol = "fixture";
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(
    request: ModelRequest,
    onEvent?: Parameters<ModelClient["complete"]>[1],
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response.content) onEvent?.({ type: "text_delta", delta: response.content });
    return response;
  }
}
