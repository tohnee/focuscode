import { describe, expect, it } from "vitest";
import { createCodingAgent } from "../src/coding-agent.js";
import { createTestDirectory } from "@focuscode/testkit";
import type { ShellExecutor } from "@focuscode/agent-runtime";

// Set API key before any tests run
process.env.OPENAI_API_KEY = "test-key";

const mockShellExecutor: ShellExecutor = {
  kind: "host",
  async execute() {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    };
  },
};

async function createSourceSession(root: string) {
  return createCodingAgent({
    cwd: root,
    model: "fixture/fixture",
    shellExecutor: mockShellExecutor,
  });
}

describe("forkSession SDK 层暴露", () => {
  it("CreateCodingAgentOptions accepts forkSession parameter", async () => {
    const root = await createTestDirectory("fork-session");
    const source = await createSourceSession(root);
    const { agent, sessions } = await createCodingAgent({
      cwd: root,
      model: "fixture/fixture",
      forkSession: source.agent.sessionId,
      shellExecutor: mockShellExecutor,
    });
    // forkSession should create a new session forked from the source
    expect(agent.sessionId).not.toBe(source.agent.sessionId);
    const forked = await sessions.load(agent.sessionId);
    expect(forked.header.forkedFrom?.sessionId).toBe(source.agent.sessionId);
  });

  it("forkSession with entryId forks at specific point", async () => {
    const root = await createTestDirectory("fork-session-entry");
    const source = await createSourceSession(root);
    // Get the actual leaf entry ID from the source session
    const sourceSnapshot = await source.sessions.load(source.agent.sessionId);
    const leafEntryId = sourceSnapshot.leafId;
    const { agent, sessions } = await createCodingAgent({
      cwd: root,
      model: "fixture/fixture",
      forkSession: source.agent.sessionId,
      forkEntryId: leafEntryId,
      shellExecutor: mockShellExecutor,
    });
    const forked = await sessions.load(agent.sessionId);
    expect(forked.header.forkedFrom?.sessionId).toBe(source.agent.sessionId);
    expect(forked.header.forkedFrom?.entryId).toBe(leafEntryId);
  });

  it("forkSession with custom name", async () => {
    const root = await createTestDirectory("fork-session-name");
    const source = await createSourceSession(root);
    const { agent, sessions } = await createCodingAgent({
      cwd: root,
      model: "fixture/fixture",
      forkSession: source.agent.sessionId,
      sessionName: "forked-branch",
      shellExecutor: mockShellExecutor,
    });
    const forked = await sessions.load(agent.sessionId);
    expect(forked.header.name).toBe("forked-branch");
  });
});
