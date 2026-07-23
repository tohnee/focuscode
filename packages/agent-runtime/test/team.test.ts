import { describe, expect, it } from "vitest";
import {
  validateTeamPlan,
  runAgentTeam,
  type TeamRole,
  type TeamPlan,
  type TeamExecutorOptions,
} from "../src/team.js";

describe("team plan validation", () => {
  const validRoles: TeamRole[] = [
    { name: "planner", instructions: "You are a planner.", allowedTools: ["read"], maxRounds: 5 },
    {
      name: "coder",
      instructions: "You are a coder.",
      allowedTools: ["read", "write", "edit"],
      maxRounds: 12,
    },
    {
      name: "reviewer",
      instructions: "You are a reviewer.",
      allowedTools: ["read", "bash"],
      maxRounds: 8,
    },
  ];

  it("accepts a valid team plan", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [
        { id: "t1", roleId: "planner", input: "Plan the feature", dependencies: [] },
        { id: "t2", roleId: "coder", input: "Implement step 1", dependencies: ["t1"] },
        { id: "t3", roleId: "reviewer", input: "Review the code", dependencies: ["t2"] },
      ],
    };
    expect(() => validateTeamPlan(plan)).not.toThrow();
  });

  it("rejects duplicate role names", () => {
    const plan: TeamPlan = {
      roles: [
        ...validRoles,
        { name: "planner", instructions: "dup", allowedTools: [], maxRounds: 1 },
      ],
      tasks: [],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/duplicate role.*planner/i);
  });

  it("rejects task with unknown roleId", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [{ id: "t1", roleId: "unknown", input: "x", dependencies: [] }],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/unknown role.*unknown/i);
  });

  it("rejects duplicate task ids", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [
        { id: "t1", roleId: "planner", input: "a", dependencies: [] },
        { id: "t1", roleId: "coder", input: "b", dependencies: [] },
      ],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/duplicate task.*t1/i);
  });

  it("rejects task dependency on non-existent task", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [{ id: "t1", roleId: "planner", input: "a", dependencies: ["nonexistent"] }],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/non-existent.*nonexistent/i);
  });

  it("rejects empty roles", () => {
    const plan: TeamPlan = { roles: [], tasks: [] };
    expect(() => validateTeamPlan(plan)).toThrow(/at least one role/i);
  });

  it("rejects role with empty name", () => {
    const plan: TeamPlan = {
      roles: [{ name: "", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/role name/i);
  });

  it("rejects maxRounds out of range", () => {
    const plan: TeamPlan = {
      roles: [{ name: "r", instructions: "x", allowedTools: [], maxRounds: 0 }],
      tasks: [],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/maxRounds/i);
  });

  it("rejects cyclic dependencies between tasks", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [
        { id: "a", roleId: "planner", input: "A", dependencies: ["b"] },
        { id: "b", roleId: "coder", input: "B", dependencies: ["a"] },
      ],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/cycle/i);
  });
});

describe("runAgentTeam executor", () => {
  it("executes a simple team plan sequentially", async () => {
    const plan: TeamPlan = {
      roles: [
        { name: "worker", instructions: "You are a worker.", allowedTools: [], maxRounds: 3 },
      ],
      tasks: [
        { id: "t1", roleId: "worker", input: "Do task 1", dependencies: [] },
        { id: "t2", roleId: "worker", input: "Do task 2", dependencies: ["t1"] },
      ],
    };
    const calls: string[] = [];
    const options: TeamExecutorOptions = {
      createAgentForRole: async (role) => ({
        submit: async (input: string) => {
          calls.push(`${role.name}:${input}`);
          return { content: `result for ${input}` };
        },
      }),
    };
    const result = await runAgentTeam(plan, options);
    expect(result.completed).toBe(true);
    expect(result.reason).toBe("all_succeeded");
    expect(result.taskResults).toHaveLength(2);
    expect(result.taskResults[0]!.status).toBe("succeeded");
    expect(result.taskResults[0]!.output).toContain("result for Do task 1");
    expect(calls).toEqual(["worker:Do task 1", "worker:Do task 2"]);
  });

  it("passes role-specific instructions and tools to child agent factory", async () => {
    const plan: TeamPlan = {
      roles: [
        {
          name: "coder",
          instructions: "Write clean code.",
          allowedTools: ["read", "write"],
          maxRounds: 8,
        },
      ],
      tasks: [{ id: "t1", roleId: "coder", input: "Write a function", dependencies: [] }],
    };
    let capturedRole: TeamRole | undefined;
    const options: TeamExecutorOptions = {
      createAgentForRole: async (role) => {
        capturedRole = role;
        return { submit: async () => ({ content: "done" }) };
      },
    };
    await runAgentTeam(plan, options);
    expect(capturedRole?.name).toBe("coder");
    expect(capturedRole?.instructions).toBe("Write clean code.");
    expect(capturedRole?.allowedTools).toEqual(["read", "write"]);
    expect(capturedRole?.maxRounds).toBe(8);
  });

  it("stops on task failure by default", async () => {
    const plan: TeamPlan = {
      roles: [{ name: "worker", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [
        { id: "t1", roleId: "worker", input: "fail", dependencies: [] },
        { id: "t2", roleId: "worker", input: "skip me", dependencies: ["t1"] },
      ],
    };
    const options: TeamExecutorOptions = {
      createAgentForRole: async () => ({
        submit: async (input: string) => {
          if (input === "fail") throw new Error("task failed");
          return { content: "ok" };
        },
      }),
    };
    const result = await runAgentTeam(plan, options);
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("task_failed");
    expect(result.taskResults.find((r) => r.taskId === "t1")?.status).toBe("failed");
    expect(result.taskResults.find((r) => r.taskId === "t2")?.status).toBe("skipped");
  });

  it("runs independent tasks in parallel", async () => {
    const plan: TeamPlan = {
      roles: [{ name: "worker", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [
        { id: "t1", roleId: "worker", input: "a", dependencies: [] },
        { id: "t2", roleId: "worker", input: "b", dependencies: [] },
      ],
    };
    let concurrent = 0;
    let maxConcurrent = 0;
    const options: TeamExecutorOptions = {
      createAgentForRole: async () => ({
        submit: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 30));
          concurrent--;
          return { content: "done" };
        },
      }),
    };
    await runAgentTeam(plan, options);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("propagates abort signal", async () => {
    const controller = new AbortController();
    const plan: TeamPlan = {
      roles: [{ name: "worker", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [{ id: "t1", roleId: "worker", input: "long", dependencies: [] }],
    };
    const options: TeamExecutorOptions = {
      signal: controller.signal,
      createAgentForRole: async () => ({
        submit: async (_input: string, signal?: AbortSignal) => {
          while (!signal?.aborted) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return { content: "aborted" };
        },
      }),
    };
    setTimeout(() => controller.abort(), 50);
    const result = await runAgentTeam(plan, options);
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("aborted");
  });
});
