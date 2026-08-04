import { describe, expect, it } from "vitest";
import type { AgentStatus, SessionSnapshot, ToolDefinition } from "@focuscode/agent-runtime";
import {
  renderAgentsCommand,
  renderConfigCommand,
  renderDoctorCommand,
  renderGoalCommand,
  renderPermissionsCommand,
  renderTaskCommand,
} from "../src/tui-command-views.js";

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    header: { schemaVersion: "session-header.v1", sessionId: "sess-abc", createdAt: "2026-01-01" },
    entries: [
      {
        entryId: "e1",
        createdAt: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Fix the login bug and add tests." },
      },
      {
        entryId: "e2",
        createdAt: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: "I will fix it." },
      },
    ],
    activeLeafId: "e2",
    ...overrides,
  };
}

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    sessionId: "sess-abc",
    cwd: "/repo",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    protocol: "openai-chat",
    approval: "ask",
    projectTrusted: false,
    entries: 2,
    activeLeafId: "e2",
    context: { estimatedTokens: 1200, contextWindow: 128000, compacted: false },
    steering: { queued: 1, running: false },
    ...overrides,
  };
}

const counts = { pending: 2, inProgress: 1, completed: 3 };

describe("renderGoalCommand", () => {
  it("shows the latest user request as the goal", () => {
    const out = renderGoalCommand(snapshot(), counts);
    expect(out).toContain("Fix the login bug and add tests.");
    expect(out).toContain("sess-abc");
    expect(out).toContain("1 in progress, 2 pending, 3 completed");
  });

  it("handles a session with no user message yet", () => {
    const out = renderGoalCommand(snapshot({ entries: [] }), {
      pending: 0,
      inProgress: 0,
      completed: 0,
    });
    expect(out).toContain("no user request yet");
  });
});

describe("renderTaskCommand", () => {
  it("summarizes counts and lists the todo content", () => {
    const out = renderTaskCommand("- [ ] write tests\n- [x] fix bug", counts);
    expect(out).toContain("1 in progress, 2 pending, 3 completed");
    expect(out).toContain("write tests");
  });

  it("suggests /task add when empty", () => {
    const out = renderTaskCommand("", { pending: 0, inProgress: 0, completed: 0 });
    expect(out).toContain("/task add");
  });
});

describe("renderAgentsCommand", () => {
  it("reports no subagents when the session has no delegate calls", () => {
    const out = renderAgentsCommand(snapshot(), status());
    expect(out).toContain("deepseek/deepseek-v4-flash");
    expect(out).toContain("none yet");
  });

  it("lists delegate calls found in the session", () => {
    const withDelegate = snapshot({
      entries: [
        ...snapshot().entries,
        {
          entryId: "e3",
          createdAt: "2026-01-01T00:00:02.000Z",
          message: {
            role: "tool",
            content: "{" + '"role":"assistant","content":"subagent result: tests pass"' + "}",
            toolName: "delegate",
          },
        },
      ],
    });
    const out = renderAgentsCommand(withDelegate, status());
    expect(out).toContain("1 delegate call");
    expect(out).toContain("subagent result");
  });
});

describe("renderDoctorCommand", () => {
  it("reports environment, provider, session and checkpoint health", () => {
    const out = renderDoctorCommand(status(), 4, 12);
    expect(out).toContain("node " + process.versions.node);
    expect(out).toContain("deepseek/deepseek-v4-flash");
    expect(out).toContain("~1200 tokens / 128000 window");
    expect(out).toContain("Checkpoints: 4 · Sessions on disk: 12");
  });
});

describe("renderConfigCommand", () => {
  it("shows resolved configuration without secrets", () => {
    const out = renderConfigCommand(status(), "seatbelt", "/repo");
    expect(out).toContain("Provider: deepseek/deepseek-v4-flash");
    expect(out).toContain("Sandbox: seatbelt");
    expect(out).toContain("Working directory: /repo");
    expect(out).not.toContain("apiKey");
    expect(out).not.toContain("sk-");
  });
});

describe("renderPermissionsCommand", () => {
  it("summarizes approval mode and tool effects", () => {
    const tools: ToolDefinition[] = [
      { name: "read", effect: "read", description: "Read files" },
      { name: "grep", effect: "read", description: "Search" },
      { name: "bash", effect: "command", description: "Run shell" },
      { name: "write", effect: "file_write", description: "Write files" },
    ];
    const out = renderPermissionsCommand("ask", tools);
    expect(out).toContain("Approval mode: ask");
    expect(out).toContain("4 registered");
    expect(out).toContain("read × 2");
    expect(out).toContain("command × 1");
  });
});
