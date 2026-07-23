import { describe, expect, it } from "vitest";
import { runGoalLoop, type LoopOptions } from "../src/loop.js";
import { createGoalState } from "../src/goal.js";

describe("goal loop", () => {
  it("terminates when goal satisfied on first iteration", async () => {
    let calls = 0;
    const options: LoopOptions = {
      goal: createGoalState("Done immediately"),
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        calls += 1;
        return { tokensUsed: 100, output: "done" };
      },
      verify: async () => ({ satisfied: true, evidence: "verified" }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBe(1);
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe("satisfied");
    expect(calls).toBe(1);
  });

  it("iterates until satisfied within maxIterations", async () => {
    let calls = 0;
    const options: LoopOptions = {
      goal: createGoalState("Needs 3 iterations"),
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        calls += 1;
        return { tokensUsed: 100, output: `iter ${calls}` };
      },
      verify: async () => ({ satisfied: calls >= 3 }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBe(3);
    expect(result.satisfied).toBe(true);
  });

  it("stops at maxIterations when not satisfied", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Never satisfied"),
      maxIterations: 2,
      tokenBudget: 10_000,
      execute: async () => ({ tokensUsed: 100, output: "iter" }),
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBe(2);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("max_iterations");
  });

  it("stops when token budget exhausted", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Token heavy"),
      maxIterations: 100,
      tokenBudget: 250,
      execute: async () => ({ tokensUsed: 200, output: "expensive" }),
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBeLessThanOrEqual(2);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("token_budget");
  });

  it("propagates execute errors with fail reason", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Will error"),
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        throw new Error("boom");
      },
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.error).toBe("boom");
  });

  it("rejects maxIterations < 1", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Bad"),
      maxIterations: 0,
      tokenBudget: 10_000,
      execute: async () => ({ tokensUsed: 1, output: "" }),
      verify: async () => ({ satisfied: true }),
    };
    await expect(runGoalLoop(options)).rejects.toThrow(/maxIterations/);
  });

  it("rejects tokenBudget < 1", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Bad"),
      maxIterations: 5,
      tokenBudget: 0,
      execute: async () => ({ tokensUsed: 1, output: "" }),
      verify: async () => ({ satisfied: true }),
    };
    await expect(runGoalLoop(options)).rejects.toThrow(/tokenBudget/);
  });

  it("marks goal as failed on execute error", async () => {
    const goal = createGoalState("Will fail");
    const options: LoopOptions = {
      goal,
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        throw new Error("boom");
      },
      verify: async () => ({ satisfied: false }),
    };
    await runGoalLoop(options);
    expect(goal.status).toBe("failed");
  });

  it("marks goal as done when satisfied", async () => {
    const goal = createGoalState("Will succeed");
    const options: LoopOptions = {
      goal,
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => ({ tokensUsed: 100, output: "done" }),
      verify: async () => ({ satisfied: true }),
    };
    await runGoalLoop(options);
    expect(goal.status).toBe("done");
  });

  it("passes iteration number to execute", async () => {
    const seen: number[] = [];
    const options: LoopOptions = {
      goal: createGoalState("Track iterations"),
      maxIterations: 3,
      tokenBudget: 10_000,
      execute: async (iteration) => {
        seen.push(iteration);
        return { tokensUsed: 100, output: "" };
      },
      verify: async () => ({ satisfied: seen.length >= 3 }),
    };
    await runGoalLoop(options);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("tracks totalTokens across iterations", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Track tokens"),
      maxIterations: 3,
      tokenBudget: 1_000,
      execute: async (i) => ({ tokensUsed: 50 * i, output: "" }),
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.totalTokens).toBe(50 + 100 + 150);
  });
});
