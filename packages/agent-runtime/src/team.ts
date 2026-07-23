/**
 * Agent Teams: structured multi-role orchestration.
 *
 * A `TeamPlan` declares a set of roles (each with its own instructions,
 * allowed tools and max rounds) and a DAG of tasks assigned to those roles.
 * `validateTeamPlan` checks structural invariants before execution:
 * unique role/task ids, known role references, valid dependency edges and
 * no cycles. The executor (`runAgentTeam`) maps each task to a graph node
 * and reuses `runTaskGraph` for parallel scheduling.
 */

import { SessionStore } from "./session-store.js";
import { AgentToolRegistry } from "./tools.js";
import type {
  AgentRuntimeOptions,
  AgentTool,
  ModelClient,
  ModelProfile,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";
import {
  createTaskGraph,
  runTaskGraph,
  type TaskExecutionContext,
  type TaskNode,
} from "./graph.js";

export interface TeamRole {
  /** Role identifier, e.g. "planner", "coder", "reviewer". */
  readonly name: string;
  /** System prompt instructions for this role. */
  readonly instructions: string;
  /** Tool names this role is allowed to use (subset of the parent registry). */
  readonly allowedTools: readonly string[];
  /** Maximum rounds for this role's child agent. */
  readonly maxRounds: number;
}

export interface TeamTask {
  readonly id: string;
  /** Which role executes this task. */
  readonly roleId: string;
  /** The task prompt sent to the child agent. */
  readonly input: string;
  /** Other task ids that must complete before this one starts. */
  readonly dependencies: readonly string[];
}

export interface TeamPlan {
  readonly roles: readonly TeamRole[];
  readonly tasks: readonly TeamTask[];
}

export interface TeamTaskResult {
  readonly taskId: string;
  readonly roleId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

export interface TeamResult {
  readonly completed: boolean;
  readonly reason: "all_succeeded" | "task_failed" | "aborted";
  readonly taskResults: readonly TeamTaskResult[];
}

const MAX_TASK_INPUT_CHARS = 4_000;
const MAX_ROLE_INSTRUCTIONS_CHARS = 8_000;
const MAX_ROUNDS_LIMIT = 20;

/**
 * Validate structural invariants of a team plan. Throws on the first
 * violation. Checks: non-empty roles, unique role names, valid maxRounds,
 * unique task ids, known role references, valid dependency edges, and no
 * cyclic dependencies (DFS).
 */
export function validateTeamPlan(plan: TeamPlan): void {
  if (plan.roles.length === 0) {
    throw new Error("Team plan must have at least one role");
  }
  const roleNames = new Set<string>();
  for (const role of plan.roles) {
    if (!role.name || typeof role.name !== "string") {
      throw new Error("Team role name must be a non-empty string");
    }
    if (roleNames.has(role.name)) {
      throw new Error(`Duplicate role name: ${role.name}`);
    }
    roleNames.add(role.name);
    if (!role.instructions || typeof role.instructions !== "string") {
      throw new Error(`Role ${role.name} instructions must be a non-empty string`);
    }
    if (role.instructions.length > MAX_ROLE_INSTRUCTIONS_CHARS) {
      throw new Error(
        `Role ${role.name} instructions exceed ${MAX_ROLE_INSTRUCTIONS_CHARS} characters`,
      );
    }
    if (
      !Number.isInteger(role.maxRounds) ||
      role.maxRounds < 1 ||
      role.maxRounds > MAX_ROUNDS_LIMIT
    ) {
      throw new Error(`Role ${role.name} maxRounds must be an integer 1..${MAX_ROUNDS_LIMIT}`);
    }
  }
  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    if (!task.id || typeof task.id !== "string") {
      throw new Error("Team task id must be a non-empty string");
    }
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    taskIds.add(task.id);
    if (!roleNames.has(task.roleId)) {
      throw new Error(`Task ${task.id} references unknown role: ${task.roleId}`);
    }
    if (!task.input || typeof task.input !== "string") {
      throw new Error(`Task ${task.id} input must be a non-empty string`);
    }
    if (task.input.length > MAX_TASK_INPUT_CHARS) {
      throw new Error(`Task ${task.id} input exceeds ${MAX_TASK_INPUT_CHARS} characters`);
    }
    for (const dep of task.dependencies) {
      if (!taskIds.has(dep) && !plan.tasks.some((t) => t.id === dep)) {
        throw new Error(`Task ${task.id} depends on non-existent task: ${dep}`);
      }
    }
  }
  // DFS cycle check on the task dependency graph.
  const visited = new Map<string, "visiting" | "done">();
  function hasCycle(id: string): boolean {
    const state = visited.get(id);
    if (state === "visiting") return true;
    if (state === "done") return false;
    visited.set(id, "visiting");
    const task = plan.tasks.find((t) => t.id === id);
    if (task) {
      for (const dep of task.dependencies) {
        if (hasCycle(dep)) return true;
      }
    }
    visited.set(id, "done");
    return false;
  }
  for (const task of plan.tasks) {
    if (hasCycle(task.id)) {
      throw new Error(`Cycle detected in team plan involving task: ${task.id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// runAgentTeam: map a TeamPlan to a TaskGraph and execute it via runTaskGraph.
// One child agent is created per role and reused across that role's tasks.
// ---------------------------------------------------------------------------

/** Minimal runner surface that a team child agent must satisfy. */
export interface TeamAgentRunner {
  submit(input: string, signal?: AbortSignal): Promise<{ content: string }>;
}

export interface TeamExecutorOptions {
  /** Factory: create a child agent for the given role. Called once per role. */
  createAgentForRole(role: TeamRole): Promise<TeamAgentRunner>;
  /** Abort signal for the entire team execution. */
  signal?: AbortSignal;
  /** Continue executing independent tasks after a failure; default false. */
  continueOnError?: boolean;
  /** Maximum concurrent tasks; default 4. */
  maxConcurrency?: number;
}

/**
 * Execute a team plan by mapping each task to a graph node (with the role's
 * pre-created agent as executor) and running the resulting DAG through
 * `runTaskGraph`. Returns a `TeamResult` with per-task status.
 */
export async function runAgentTeam(
  plan: TeamPlan,
  options: TeamExecutorOptions,
): Promise<TeamResult> {
  validateTeamPlan(plan);
  const { createAgentForRole, signal, continueOnError = false, maxConcurrency = 4 } = options;

  // Pre-create one agent per role; agents are reused across that role's tasks.
  const roleAgents = new Map<string, TeamAgentRunner>();
  for (const role of plan.roles) {
    roleAgents.set(role.name, await createAgentForRole(role));
  }

  // Build TaskGraph nodes from team tasks.
  const taskNodes: TaskNode[] = plan.tasks.map((task) => ({
    id: task.id,
    dependencies: task.dependencies,
    executor: async (execCtx: TaskExecutionContext) => {
      const agent = roleAgents.get(task.roleId);
      if (!agent) throw new Error(`No agent for role: ${task.roleId}`);
      const result = await agent.submit(task.input, execCtx.signal);
      return result.content;
    },
  }));

  const graph = createTaskGraph(taskNodes);
  const graphResult = await runTaskGraph(graph, {
    continueOnError,
    maxConcurrency,
    ...(signal ? { signal } : {}),
  });

  // Map graph results back to TeamTaskResult[], preserving plan.tasks order.
  const taskResults: TeamTaskResult[] = plan.tasks.map((task) => {
    if (graphResult.results.has(task.id)) {
      return {
        taskId: task.id,
        roleId: task.roleId,
        status: "succeeded" as const,
        output: graphResult.results.get(task.id),
      };
    }
    if (graphResult.errors.has(task.id)) {
      const err = graphResult.errors.get(task.id);
      return {
        taskId: task.id,
        roleId: task.roleId,
        status: "failed" as const,
        ...(err?.message ? { error: err.message } : {}),
      };
    }
    return {
      taskId: task.id,
      roleId: task.roleId,
      status: "skipped" as const,
    };
  });

  const reason: TeamResult["reason"] =
    graphResult.reason === "all_succeeded"
      ? "all_succeeded"
      : graphResult.reason === "aborted"
        ? "aborted"
        : "task_failed";

  return { completed: graphResult.completed, reason, taskResults };
}

// ---------------------------------------------------------------------------
// team tool: lets the model declare a set of roles and a DAG of tasks assigned
// to those roles, then orchestrate them via runAgentTeam. Each role gets its
// own child agent with a trimmed tool registry (only the role's allowedTools).
// ---------------------------------------------------------------------------

const TEAM_MAX_TASKS = 50;
const TEAM_RESULT_EXCERPT = 500;
/**
 * Tools never handed to a team child agent: no nested team, no graph, no
 * delegate, no shell. (todo is always re-registered by the CodingAgent
 * constructor, so excluding it here would be misleading — it is harmless for
 * child agents, same as in the graph tool.)
 */
const TEAM_EXCLUDED_TOOLS = new Set(["team", "graph", "delegate", "bash"]);

/** The surface the team tool needs from its host agent. */
export interface TeamToolContext {
  readonly cwd: string;
  readonly model: ModelProfile;
  readonly modelClient: ModelClient;
  readonly registry: AgentToolRegistry;
  readonly permission: AgentRuntimeOptions["permission"];
  readonly instructions?: string[];
  /**
   * Config-level defaults for team execution. The model may override
   * `continueOnError` per-call via the tool argument; `maxConcurrency` and
   * `maxTasks` are always capped by these values.
   */
  readonly teamDefaults?: {
    maxConcurrency: number;
    continueOnError: boolean;
    maxTasks: number;
  };
  createAgent(options: AgentRuntimeOptions): Promise<{
    submit(input: string, signal?: AbortSignal): Promise<{ content: string }>;
  }>;
}

/**
 * Build the `team` tool. The tool lets the model declare a set of roles
 * (each with its own instructions and allowed tool subset) and a DAG of tasks
 * assigned to those roles. Each role gets one child agent (reused across that
 * role's tasks) with a trimmed tool registry. The tool returns a textual
 * summary of per-task outcomes; full child outputs are truncated to keep the
 * parent's context window manageable.
 */
export function createTeamTool(getContext: () => TeamToolContext): AgentTool {
  return {
    definition: {
      name: "team",
      label: "Agent team",
      description:
        "Orchestrate multiple role-specialized child agents to collaboratively " +
        "complete a set of tasks with dependencies. Each role gets its own " +
        "instructions and tool subset. Returns a summary of per-task outcomes " +
        "(succeeded/failed/skipped).",
      parameters: {
        type: "object",
        required: ["roles", "tasks"],
        properties: {
          roles: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["name", "instructions", "maxRounds"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 64 },
                instructions: { type: "string", minLength: 1, maxLength: 8_000 },
                allowedTools: { type: "array", items: { type: "string" } },
                maxRounds: { type: "integer", minimum: 1, maximum: 20 },
              },
              additionalProperties: false,
            },
          },
          tasks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "roleId", "input"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                roleId: { type: "string" },
                input: { type: "string", minLength: 1, maxLength: 4_000 },
                dependencies: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
          continueOnError: { type: "boolean" },
        },
        additionalProperties: false,
      },
      effect: "write",
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const rawRoles = Array.isArray(args.roles) ? (args.roles as unknown[]) : [];
      const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : [];
      if (rawRoles.length === 0) {
        return { content: "team: no roles provided", isError: true };
      }
      if (rawTasks.length === 0) {
        return { content: "team: no tasks provided", isError: true };
      }
      const host = getContext();
      const maxTasks = host.teamDefaults?.maxTasks ?? TEAM_MAX_TASKS;
      if (rawTasks.length > maxTasks) {
        return { content: `team: too many tasks (max ${maxTasks})`, isError: true };
      }
      const plan: TeamPlan = {
        roles: rawRoles.map((raw) => {
          const r = raw as {
            name: string;
            instructions: string;
            allowedTools?: string[];
            maxRounds: number;
          };
          return {
            name: r.name,
            instructions: r.instructions,
            allowedTools: Array.isArray(r.allowedTools) ? r.allowedTools : [],
            maxRounds: typeof r.maxRounds === "number" ? r.maxRounds : 8,
          };
        }),
        tasks: rawTasks.map((raw) => {
          const t = raw as {
            id: string;
            roleId: string;
            input: string;
            dependencies?: string[];
          };
          return {
            id: t.id,
            roleId: t.roleId,
            input: t.input,
            dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
          };
        }),
      };
      try {
        validateTeamPlan(plan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `team: invalid plan — ${message}`, isError: true };
      }
      const continueOnError =
        typeof args.continueOnError === "boolean"
          ? args.continueOnError
          : (host.teamDefaults?.continueOnError ?? false);
      const maxConcurrency = host.teamDefaults?.maxConcurrency ?? 4;
      // Pre-build a child registry that excludes team/graph/delegate/bash.
      // Each role further filters this down to its allowedTools.
      const childRegistryBase = new AgentToolRegistry(
        host.registry.values().filter((t) => !TEAM_EXCLUDED_TOOLS.has(t.definition.name)),
      );
      let result: TeamResult;
      try {
        result = await runAgentTeam(plan, {
          continueOnError,
          maxConcurrency,
          ...(context.signal ? { signal: context.signal } : {}),
          createAgentForRole: async (role) => {
            const roleTools = childRegistryBase
              .values()
              .filter((t) => role.allowedTools.includes(t.definition.name));
            const roleRegistry = new AgentToolRegistry(roleTools);
            const child = await host.createAgent({
              cwd: host.cwd,
              model: host.model,
              modelClient: host.modelClient,
              tools: roleRegistry.values(),
              toolRegistry: roleRegistry,
              permission: host.permission,
              sessionStore: new SessionStore("team", false),
              maxRounds: role.maxRounds,
              ...(role.instructions ? { instructions: [role.instructions] } : {}),
            });
            return child;
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `team: execution failed — ${message}`, isError: true };
      }
      const succeeded = result.taskResults.filter((r) => r.status === "succeeded").length;
      const failed = result.taskResults.filter((r) => r.status === "failed").length;
      const skipped = result.taskResults.filter((r) => r.status === "skipped").length;
      const lines: string[] = [
        `team: ${result.completed ? "completed" : "incomplete"} (${result.reason})`,
        `tasks: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
      ];
      for (const tr of result.taskResults) {
        const icon = tr.status === "succeeded" ? "ok" : tr.status === "failed" ? "fail" : "skip";
        const detail =
          tr.status === "succeeded"
            ? (tr.output ?? "").slice(0, TEAM_RESULT_EXCERPT)
            : tr.status === "failed"
              ? (tr.error ?? "unknown error")
              : "skipped";
        lines.push(`  ${icon} ${tr.taskId} [${tr.roleId}]: ${detail}`);
      }
      return {
        content: lines.join("\n"),
        metadata: {
          completed: result.completed,
          reason: result.reason,
          succeeded,
          failed,
          skipped,
        },
      };
    },
  };
}
