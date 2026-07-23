import { describe, expect, it } from "vitest";
import {
  AgentToolRegistry,
  CodingAgent,
  SessionStore,
  type AgentEvent,
  type AgentTool,
  type ApprovalMode,
  type ModelClient,
  type ModelProfile,
  type PermissionRequest,
  type ToolExecutionResult,
} from "@focuscode/agent-runtime";
import { createSessionEffectSpine } from "../src/index.js";

/**
 * Legacy-vs-spine differential suite: the same tool calls run through the
 * direct PermissionController path and through the EffectPort spine must
 * produce identical tool results, identical "Permission denied:" wording and
 * an identical approval_required event sequence (grant linkage metadata is
 * spine-only and intentionally ignored).
 */

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture",
  protocol: "openai-chat",
  baseUrl: "http://fixture",
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
  temperature: 0,
  toolMode: "native",
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 10_000,
    maxRetries: 0,
    retryBaseDelayMs: 10,
    retryMaximumDelayMs: 100,
  },
};

const unusedModelClient: ModelClient = {
  protocol: "openai-chat",
  async complete() {
    throw new Error("model client is not used by runTool");
  },
};

function fixtureTools(): AgentTool[] {
  return [
    {
      definition: {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
        },
        effect: "read",
      },
      async execute(args) {
        return { content: `read ${String(args.path)}` };
      },
    },
    {
      definition: {
        name: "write",
        label: "Write Note",
        description: "Write a note file",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
        effect: "write",
      },
      async execute(args) {
        return { content: `wrote ${String(args.path)}` };
      },
    },
    {
      definition: {
        name: "bash",
        label: "Shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          required: ["command"],
          properties: { command: { type: "string" } },
        },
        effect: "shell",
      },
      async execute(args) {
        return { content: `ran ${String(args.command)}` };
      },
    },
  ];
}

/** Shared call list: read / write / shell-low / shell-medium / critical / protected write / protected shell / trusted-project command. */
const CALLS: Array<[string, Record<string, unknown>]> = [
  ["read", { path: "src/a.ts" }],
  ["write", { path: "src/b.ts", content: "x" }],
  ["bash", { command: "git status" }],
  ["bash", { command: "echo hello" }],
  ["bash", { command: "rm -rf /" }],
  ["write", { path: ".env", content: "SECRET=1" }],
  ["bash", { command: "cat ~/.ssh/id_rsa" }],
  ["bash", { command: "pnpm test" }],
];

const CRITICAL_DENIED =
  "Permission denied: Critical shell command blocked: recursive deletion of a broad system path";

interface ScenarioOptions {
  mode: ApprovalMode;
  projectTrusted?: boolean;
  approve?: (request: PermissionRequest) => boolean;
}

interface PathOutcome {
  results: ToolExecutionResult[];
  events: AgentEvent[];
}

async function runPath(
  pathKind: "legacy" | "spine",
  options: ScenarioOptions,
): Promise<PathOutcome> {
  const tools = fixtureTools();
  const registry = new AgentToolRegistry(tools);
  const events: AgentEvent[] = [];
  const approve = options.approve
    ? (request: PermissionRequest) => Promise.resolve(options.approve!(request))
    : undefined;
  const permission = {
    mode: options.mode,
    projectTrusted: options.projectTrusted ?? false,
    protectedPaths: [".env", ".ssh"],
    ...(approve ? { approve } : {}),
  };
  let agent: CodingAgent | undefined;
  const spine =
    pathKind === "spine"
      ? createSessionEffectSpine({
          cwd: "/tmp",
          registry,
          taskId: "task_parity",
          model,
          permission,
          ...(approve ? { approve } : {}),
          onApprovalRequired: (request) => agent?.notifyApprovalRequired(request),
        })
      : undefined;
  agent = await CodingAgent.create({
    cwd: "/tmp",
    model,
    modelClient: unusedModelClient,
    tools,
    toolRegistry: registry,
    permission,
    sessionStore: new SessionStore("unused", false),
    eventSink: (event) => events.push(event),
    ...(spine
      ? {
          effectPort: spine.effectPort,
          effectContext: spine.effectContext,
          onApprovalModeChange: (mode: ApprovalMode) => spine.setApprovalMode(mode),
        }
      : {}),
  });

  const results: ToolExecutionResult[] = [];
  for (const [name, argumentsValue] of CALLS) {
    results.push(await agent.runTool(name, argumentsValue));
  }
  return { results, events };
}

function resultsView(outcome: PathOutcome): unknown {
  return outcome.results.map((result) => ({
    content: result.content,
    isError: result.isError === true,
  }));
}

function approvalsView(outcome: PathOutcome): unknown {
  return outcome.events
    .filter(
      (event): event is Extract<AgentEvent, { type: "approval_required" }> =>
        event.type === "approval_required",
    )
    .map((event) => ({
      tool: event.request.tool.name,
      risk: event.request.risk,
      reason: event.request.reason,
      arguments: event.request.arguments,
    }));
}

function eventTypeCounts(outcome: PathOutcome): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of outcome.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

async function expectParity(options: ScenarioOptions): Promise<PathOutcome> {
  const [legacy, spine] = await Promise.all([
    runPath("legacy", options),
    runPath("spine", options),
  ]);
  expect(resultsView(spine)).toEqual(resultsView(legacy));
  expect(approvalsView(spine)).toEqual(approvalsView(legacy));
  expect(eventTypeCounts(spine)).toEqual(eventTypeCounts(legacy));
  return legacy;
}

describe("legacy/spine behavioral parity", () => {
  it("ask mode with an approving handler prompts identically on both paths", async () => {
    const outcome = await expectParity({ mode: "ask", approve: () => true });
    expect(approvalsView(outcome)).toEqual([
      {
        tool: "write",
        risk: "medium",
        reason: "Explicit approval required",
        arguments: { path: "src/b.ts", content: "x" },
      },
      {
        tool: "bash",
        risk: "medium",
        reason: "General shell command requires approval",
        arguments: { command: "echo hello" },
      },
      {
        tool: "write",
        risk: "medium",
        reason: "Protected resource requires explicit access: .env",
        arguments: { path: ".env", content: "SECRET=1" },
      },
      {
        tool: "bash",
        risk: "medium",
        reason: "Shell command references protected resource: .ssh",
        arguments: { command: "cat ~/.ssh/id_rsa" },
      },
      {
        tool: "bash",
        risk: "medium",
        reason: "Project command can execute repository-controlled code",
        arguments: { command: "pnpm test" },
      },
    ]);
    // The critical command never prompts, and every approved call applied.
    expect(resultsView(outcome)).toEqual([
      { content: "read src/a.ts", isError: false },
      { content: "wrote src/b.ts", isError: false },
      { content: "ran git status", isError: false },
      { content: "ran echo hello", isError: false },
      { content: CRITICAL_DENIED, isError: true },
      { content: "wrote .env", isError: false },
      { content: "ran cat ~/.ssh/id_rsa", isError: false },
      { content: "ran pnpm test", isError: false },
    ]);
  });

  it("ask mode with a denying handler produces identical denial wording", async () => {
    const outcome = await expectParity({
      mode: "ask",
      approve: (request) => request.tool.name === "write" && request.arguments.path !== ".env",
    });
    expect(resultsView(outcome)).toEqual([
      { content: "read src/a.ts", isError: false },
      { content: "wrote src/b.ts", isError: false },
      { content: "ran git status", isError: false },
      { content: "Permission denied: Denied by user", isError: true },
      { content: CRITICAL_DENIED, isError: true },
      { content: "Permission denied: Denied by user", isError: true },
      { content: "Permission denied: Denied by user", isError: true },
      { content: "Permission denied: Denied by user", isError: true },
    ]);
    expect(approvalsView(outcome)).toHaveLength(5);
  });

  it("full-auto mode grants routine work and hard-denies protected/critical calls", async () => {
    const outcome = await expectParity({ mode: "full-auto" });
    expect(resultsView(outcome)).toEqual([
      { content: "read src/a.ts", isError: false },
      { content: "wrote src/b.ts", isError: false },
      { content: "ran git status", isError: false },
      { content: "ran echo hello", isError: false },
      { content: CRITICAL_DENIED, isError: true },
      {
        content: "Permission denied: Protected resource requires explicit access: .env",
        isError: true,
      },
      {
        content: "Permission denied: Shell command references protected resource: .ssh",
        isError: true,
      },
      { content: "ran pnpm test", isError: false },
    ]);
    expect(approvalsView(outcome)).toEqual([]);
  });

  it("auto-edit grants writes and trusted project commands only", async () => {
    const outcome = await expectParity({ mode: "auto-edit", projectTrusted: true });
    expect(resultsView(outcome)).toEqual([
      { content: "read src/a.ts", isError: false },
      { content: "wrote src/b.ts", isError: false },
      { content: "ran git status", isError: false },
      {
        content: "Permission denied: General shell command requires approval",
        isError: true,
      },
      { content: CRITICAL_DENIED, isError: true },
      {
        content: "Permission denied: Protected resource requires explicit access: .env",
        isError: true,
      },
      {
        content: "Permission denied: Shell command references protected resource: .ssh",
        isError: true,
      },
      { content: "ran pnpm test", isError: false },
    ]);
    expect(approvalsView(outcome)).toEqual([]);
  });

  it("deny mode blocks side effects while reads stay free", async () => {
    const outcome = await expectParity({ mode: "deny" });
    expect(resultsView(outcome)).toEqual([
      { content: "read src/a.ts", isError: false },
      { content: "Permission denied: Side effects disabled", isError: true },
      { content: "ran git status", isError: false },
      { content: "Permission denied: Shell execution disabled", isError: true },
      { content: CRITICAL_DENIED, isError: true },
      {
        content: "Permission denied: Protected resource requires explicit access: .env",
        isError: true,
      },
      {
        content: "Permission denied: Shell command references protected resource: .ssh",
        isError: true,
      },
      { content: "Permission denied: Shell execution disabled", isError: true },
    ]);
    expect(approvalsView(outcome)).toEqual([]);
  });

  it("changeApproval repoints the spine matrix mid-session", async () => {
    const tools = fixtureTools();
    const registry = new AgentToolRegistry(tools);
    let agent: CodingAgent | undefined;
    const spine = createSessionEffectSpine({
      cwd: "/tmp",
      registry,
      taskId: "task_mode_switch",
      model,
      permission: { mode: "deny", projectTrusted: false, protectedPaths: [] },
      onApprovalRequired: (request) => agent?.notifyApprovalRequired(request),
    });
    agent = await CodingAgent.create({
      cwd: "/tmp",
      model,
      modelClient: unusedModelClient,
      tools,
      toolRegistry: registry,
      permission: { mode: "deny", projectTrusted: false, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
      onApprovalModeChange: (mode) => spine.setApprovalMode(mode),
    });
    const denied = await agent.runTool("write", { path: "a.txt", content: "x" });
    expect(denied).toMatchObject({ content: "Permission denied: Side effects disabled" });
    agent.changeApproval("full-auto");
    const granted = await agent.runTool("write", { path: "a.txt", content: "x" });
    expect(granted).toMatchObject({ content: "wrote a.txt" });
  });
});
