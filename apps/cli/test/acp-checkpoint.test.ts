import { describe, expect, it, vi } from "vitest";
import type { CheckpointSummary } from "@focuscode/agent-runtime";
import { dispatchAcpMethod, type AcpContext } from "../src/acp-handler.js";

function mockSession(
  checkpoints: CheckpointSummary[] = [],
  undoResult = "Restored.",
): AcpContext["sessions"] {
  const map = new Map();
  map.set("s1", {
    agent: {
      listCheckpoints: vi.fn().mockResolvedValue(checkpoints),
      undoCheckpoint: vi.fn().mockResolvedValue(undoResult),
    },
    sessionId: "s1",
    busy: false,
  });
  return map;
}

function ctx(overrides: Partial<AcpContext> = {}): AcpContext {
  return {
    sessions: mockSession(),
    currentSessionId: "s1",
    config: { model: { provider: "test", model: "model" } },
    cwd: "/tmp",
    sessionStore: { list: vi.fn().mockResolvedValue([]) } as never,
    ...overrides,
  };
}

describe("D12 ACP checkpoint capability", () => {
  it("TC-D12-01: initialize response advertises checkpoint: true", async () => {
    const result = await dispatchAcpMethod("initialize", {}, ctx());
    expect(result).toMatchObject({
      capabilities: { checkpoint: true },
    });
  });

  it("TC-D12-02: session/checkpoint action=list returns checkpoint summaries", async () => {
    const checkpoints: CheckpointSummary[] = [
      { seq: 1, label: "tool:edit", createdAt: "2026-07-29T00:00:00Z", files: 3 },
      { seq: 2, label: "tool:write", createdAt: "2026-07-29T00:01:00Z", files: 1 },
    ];
    const result = await dispatchAcpMethod(
      "session/checkpoint",
      { action: "list" },
      ctx({ sessions: mockSession(checkpoints) }),
    );
    expect(result).toEqual({ checkpoints });
  });

  it("TC-D12-03: session/checkpoint action=undo calls undoCheckpoint and returns result", async () => {
    const result = await dispatchAcpMethod("session/checkpoint", { action: "undo" }, ctx());
    expect(result).toEqual({ result: "Restored." });
  });

  it("TC-D12-04: session/checkpoint with no active session throws error", async () => {
    await expect(
      dispatchAcpMethod(
        "session/checkpoint",
        { action: "list" },
        ctx({ currentSessionId: undefined }),
      ),
    ).rejects.toThrow(/No active session/);
  });

  it("TC-D12-05: session/checkpoint with invalid action throws error", async () => {
    await expect(
      dispatchAcpMethod("session/checkpoint", { action: "bogus" }, ctx()),
    ).rejects.toThrow(/Invalid checkpoint action/);
  });

  it("TC-D12-06: session/checkpoint action=list returns empty array when no checkpoints", async () => {
    const result = await dispatchAcpMethod(
      "session/checkpoint",
      { action: "list" },
      ctx({ sessions: mockSession([]) }),
    );
    expect(result).toEqual({ checkpoints: [] });
  });

  it("TC-D12-07: session/checkpoint action=undo on session not in map throws", async () => {
    await expect(
      dispatchAcpMethod(
        "session/checkpoint",
        { action: "undo" },
        ctx({ currentSessionId: "missing" }),
      ),
    ).rejects.toThrow(/Session not found/);
  });

  it("TC-D12-08: session/checkpoint with missing action param throws", async () => {
    await expect(dispatchAcpMethod("session/checkpoint", {}, ctx())).rejects.toThrow(
      /Missing.*action/,
    );
  });
});
