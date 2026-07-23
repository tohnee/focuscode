import { describe, expect, it } from "vitest";
import {
  type Goal,
  type GoalState,
  createGoalState,
  createGoalTool,
  type GoalVerifier,
} from "../src/goal.js";

describe("goal state machine", () => {
  it("transitions pending→in_progress→done", () => {
    const state = createGoalState("Implement feature X");
    expect(state.status).toBe("pending");
    state.start();
    expect(state.status).toBe("in_progress");
    state.complete();
    expect(state.status).toBe("done");
  });

  it("rejects invalid transitions", () => {
    const state = createGoalState("Goal");
    state.complete();
    expect(() => state.start()).toThrow(/Cannot start a done goal/);
  });

  it("captures verifier result with evidence", () => {
    const verifier: GoalVerifier = async () => ({
      satisfied: true,
      evidence: "tests pass",
    });
    const state = createGoalState("Goal", verifier);
    state.start();
    return state.verify().then((result) => {
      expect(result.satisfied).toBe(true);
      expect(result.evidence).toBe("tests pass");
      expect(state.status).toBe("done");
    });
  });

  it("stays in_progress when verifier not satisfied", async () => {
    const verifier: GoalVerifier = async () => ({ satisfied: false });
    const state = createGoalState("Goal", verifier);
    state.start();
    const result = await state.verify();
    expect(result.satisfied).toBe(false);
    expect(state.status).toBe("in_progress");
  });

  it("tracks attempts across verify calls", async () => {
    const verifier: GoalVerifier = async () => ({ satisfied: false });
    const state = createGoalState("Goal", verifier);
    state.start();
    await state.verify();
    await state.verify();
    expect(state.attempts).toBe(2);
  });

  it("fails without verifier returns satisfied", async () => {
    const state = createGoalState("No verifier");
    state.start();
    const result = await state.verify();
    expect(result.satisfied).toBe(true);
    expect(state.status).toBe("done");
  });

  it("fail() transitions to failed status", () => {
    const state = createGoalState("Will fail");
    state.start();
    state.fail();
    expect(state.status).toBe("failed");
  });

  it("exposes description and lastEvidence", async () => {
    const verifier: GoalVerifier = async () => ({
      satisfied: false,
      evidence: "not yet",
    });
    const state = createGoalState("My goal", verifier);
    expect(state.description).toBe("My goal");
    state.start();
    await state.verify();
    expect(state.lastEvidence).toBe("not yet");
  });
});

describe("goal tool", () => {
  it("exposes definition with write effect", () => {
    const tool = createGoalTool();
    expect(tool.definition.name).toBe("goal");
    expect(tool.definition.effect).toBe("write");
    const properties = (tool.definition.parameters as { properties: Record<string, unknown> })
      .properties;
    expect(properties).toHaveProperty("action");
    expect(properties).toHaveProperty("description");
    expect(properties).toHaveProperty("evidence");
  });

  it("returns content for status action", async () => {
    const tool = createGoalTool();
    const result = await tool.execute({ action: "status" }, { cwd: "/tmp" });
    expect(result.content).toContain("goal");
  });

  it("returns content for set action", async () => {
    const tool = createGoalTool();
    const result = await tool.execute({ action: "set", description: "test goal" }, { cwd: "/tmp" });
    expect(result.content).toContain("set");
  });
});

describe("Goal type", () => {
  it("matches the public interface shape", () => {
    const goal: Goal = {
      description: "test",
      status: "pending",
      attempts: 0,
    };
    expect(goal.description).toBe("test");
    expect(goal.status).toBe("pending");
  });
});
