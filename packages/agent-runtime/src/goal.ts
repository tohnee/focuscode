import type {
  AgentTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

export type GoalStatus = "pending" | "in_progress" | "done" | "failed";

export interface GoalVerifyResult {
  satisfied: boolean;
  evidence?: string | undefined;
}

export type GoalVerifier = () => Promise<GoalVerifyResult>;

export interface Goal {
  description: string;
  status: GoalStatus;
  verifier?: GoalVerifier | undefined;
  attempts: number;
  lastEvidence?: string | undefined;
}

export interface GoalState {
  readonly description: string;
  readonly status: GoalStatus;
  readonly attempts: number;
  readonly lastEvidence?: string | undefined;
  start(): void;
  complete(): void;
  fail(): void;
  verify(): Promise<GoalVerifyResult>;
}

export function createGoalState(description: string, verifier?: GoalVerifier): GoalState {
  let status: GoalStatus = "pending";
  let attempts = 0;
  let lastEvidence: string | undefined;
  return {
    get description() {
      return description;
    },
    get status() {
      return status;
    },
    get attempts() {
      return attempts;
    },
    get lastEvidence() {
      return lastEvidence;
    },
    start() {
      if (status !== "pending" && status !== "in_progress") {
        throw new Error(`Cannot start a ${status} goal`);
      }
      status = "in_progress";
    },
    complete() {
      if (status === "done" || status === "failed") {
        throw new Error(`Cannot complete a ${status} goal`);
      }
      status = "done";
    },
    fail() {
      status = "failed";
    },
    async verify() {
      if (!verifier) {
        status = "done";
        return { satisfied: true };
      }
      attempts += 1;
      const result = await verifier();
      lastEvidence = result.evidence;
      if (result.satisfied) {
        status = "done";
      }
      return result;
    },
  };
}

const goalToolDefinition: ToolDefinition = {
  name: "goal",
  label: "Goal",
  description:
    "Set, update, or query the current goal. Actions: set|start|complete|status. " +
    "Use this to declare intent before executing, and to mark completion with evidence.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "start", "complete", "status"] },
      description: { type: "string", description: "Goal description (for 'set' action)" },
      evidence: { type: "string", description: "Completion evidence (for 'complete' action)" },
    },
    required: ["action"],
  },
  effect: "write",
};

export function createGoalTool(): AgentTool {
  return {
    definition: goalToolDefinition,
    async execute(
      args: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const action = String(args.action ?? "");
      if (action === "status") {
        return { content: "goal tool: no active goal state in tool-only mode" };
      }
      return {
        content: `goal action '${action}' recorded; use GoalState API for stateful tracking`,
      };
    },
  };
}
