import type { GoalState, GoalVerifyResult } from "./goal.js";

export interface LoopIterationResult {
  tokensUsed: number;
  output: string;
}

export interface LoopOptions {
  goal: GoalState;
  maxIterations: number;
  tokenBudget: number;
  execute: (iteration: number) => Promise<LoopIterationResult>;
  verify: () => Promise<GoalVerifyResult>;
}

export interface LoopResult {
  satisfied: boolean;
  iterations: number;
  totalTokens: number;
  reason: "satisfied" | "max_iterations" | "token_budget" | "error";
  error?: string | undefined;
  finalOutput?: string | undefined;
}

export async function runGoalLoop(options: LoopOptions): Promise<LoopResult> {
  const { goal, maxIterations, tokenBudget, execute, verify } = options;
  if (maxIterations < 1) {
    throw new Error("maxIterations must be at least 1");
  }
  if (tokenBudget < 1) {
    throw new Error("tokenBudget must be at least 1");
  }
  goal.start();
  let totalTokens = 0;
  let finalOutput: string | undefined;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let iterResult: LoopIterationResult;
    try {
      iterResult = await execute(iteration);
    } catch (error) {
      goal.fail();
      return {
        satisfied: false,
        iterations: iteration,
        totalTokens,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    totalTokens += iterResult.tokensUsed;
    finalOutput = iterResult.output;
    if (totalTokens >= tokenBudget) {
      return {
        satisfied: false,
        iterations: iteration,
        totalTokens,
        reason: "token_budget",
        finalOutput,
      };
    }
    const verifyResult = await verify();
    if (verifyResult.satisfied) {
      goal.complete();
      return {
        satisfied: true,
        iterations: iteration,
        totalTokens,
        reason: "satisfied",
        finalOutput,
      };
    }
  }
  return {
    satisfied: false,
    iterations: maxIterations,
    totalTokens,
    reason: "max_iterations",
    finalOutput,
  };
}
