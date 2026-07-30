import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  AgentToolRegistry,
  CodingAgent,
  PermissionController,
  SessionStore,
  type AgentEvent,
  type AgentTool,
  type AgentToolCall,
  type ModelClient,
  type ModelProfile,
  type PermissionRequest,
  type ToolDefinition,
} from "@focuscode/agent-runtime";
import type { CommandPrefixRule } from "@focuscode/action-domain";
import { createSessionEffectSpine } from "../src/index.js";

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

/**
 * Fixture bash tool: does NOT execute anything. Returns a success string so
 * that granted commands produce a non-error result. Denied commands never
 * reach execute(), so the return value only matters for the allow/grant path.
 */
function fixtureBashTool(): AgentTool {
  return {
    definition: {
      name: "bash",
      label: "Bash",
      description: "Fixture bash tool for prefix-rule policy tests",
      parameters: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string" } },
      },
      effect: "shell",
    },
    async execute(args) {
      return { content: `executed: ${String(args.command)}` };
    },
  };
}

const bashDefinition: ToolDefinition = fixtureBashTool().definition;

function call(command: string): AgentToolCall {
  return { id: "call", name: "bash", arguments: { command } };
}

const denyRules: CommandPrefixRule[] = [
  {
    prefix: "npm publish",
    effect: "deny",
    reason: "Package publication is irreversible",
    match: ["npm publish", "npm publish --access public"],
    notMatch: ["npm install", "npm test"],
  },
];

const allowRules: CommandPrefixRule[] = [
  {
    prefix: "git status",
    effect: "allow",
    reason: "read-only git status explicitly allowed",
    match: ["git status", "git status --short"],
    notMatch: ["git push"],
  },
];

describe("P0: spine prefixRules E2E — wiring and same-decision regression", () => {
  it("TC-SPINE-PREFIX-01: prefix deny denies bash through the spine, no effect recorded", async () => {
    const root = await createTestDirectory("spine-prefix-deny");
    const registry = new AgentToolRegistry([fixtureBashTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_prefix_deny",
      model,
      permission: {
        mode: "full-auto",
        projectTrusted: false,
        protectedPaths: [".env"],
        prefixRules: denyRules,
      },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: false, protectedPaths: [".env"] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });

    const result = await agent.runTool("bash", { command: "npm publish --access public" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied");
    expect(result.content).toContain("Prefix rule denied");
    // Denied commands must not record an effect.
    expect(spine.runtime.ledgerSnapshot().actionIds).toHaveLength(0);
  });

  it("TC-SPINE-PREFIX-02: prefix allow grants bash without approval prompt in ask mode", async () => {
    const root = await createTestDirectory("spine-prefix-allow");
    const registry = new AgentToolRegistry([fixtureBashTool()]);
    const approvals: PermissionRequest[] = [];
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_prefix_allow",
      model,
      permission: {
        mode: "ask",
        projectTrusted: false,
        protectedPaths: [".env"],
        prefixRules: allowRules,
      },
      approve: (request) => {
        approvals.push(request);
        return Promise.resolve(true);
      },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: {
        mode: "ask",
        projectTrusted: false,
        protectedPaths: [".env"],
        approve: () => {
          throw new Error("session PermissionController must not prompt on the spine path");
        },
      },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });

    const result = await agent.runTool("bash", { command: "git status" });
    // Prefix allow → grant without prompting.
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("executed: git status");
    expect(approvals).toHaveLength(0);
    // Granted command records an effect.
    expect(spine.runtime.ledgerSnapshot().actionIds).toHaveLength(1);
  });

  it("TC-SPINE-PREFIX-03: prefix allow cannot bypass critical command (rm -rf /) deny on spine", async () => {
    const root = await createTestDirectory("spine-prefix-critical");
    const registry = new AgentToolRegistry([fixtureBashTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_prefix_critical",
      model,
      permission: {
        mode: "full-auto",
        projectTrusted: true,
        protectedPaths: [".env"],
        prefixRules: [{ prefix: "rm", effect: "allow", reason: "test allow rm" }],
      },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [".env"] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });

    const result = await agent.runTool("bash", { command: "rm -rf /" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Critical shell command blocked");
    expect(spine.runtime.ledgerSnapshot().actionIds).toHaveLength(0);
  });

  it("TC-SPINE-PREFIX-04: prefix allow cannot bypass protected path (cat .env) deny on spine", async () => {
    const root = await createTestDirectory("spine-prefix-protected");
    const registry = new AgentToolRegistry([fixtureBashTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_prefix_protected",
      model,
      permission: {
        mode: "full-auto",
        projectTrusted: true,
        protectedPaths: [".env"],
        prefixRules: [{ prefix: "cat", effect: "allow", reason: "test allow cat" }],
      },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [".env"] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });

    const result = await agent.runTool("bash", { command: "cat .env" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("protected resource");
    expect(spine.runtime.ledgerSnapshot().actionIds).toHaveLength(0);
  });

  it("TC-SPINE-PREFIX-05: spine without prefixRules ignores prefix logic (no regression)", async () => {
    const root = await createTestDirectory("spine-no-prefix");
    const registry = new AgentToolRegistry([fixtureBashTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_no_prefix",
      model,
      permission: {
        mode: "full-auto",
        projectTrusted: false,
        protectedPaths: [".env"],
      },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: false, protectedPaths: [".env"] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });

    // git status is a recognized read-only command → grant even without prefix rules.
    const result = await agent.runTool("bash", { command: "git status" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("executed: git status");
  });

  it("TC-SPINE-PREFIX-06: same-decision regression — spine and legacy agree on a command matrix", async () => {
    // The P0 fix moves PrefixRuleEngine into PolicyEngine so both paths share
    // the single rule source. This test guards against future divergence by
    // comparing the end-to-end allowed/denied verdict for a matrix of commands
    // under identical prefix rules.
    const rules: CommandPrefixRule[] = [
      {
        prefix: "npm publish",
        effect: "deny",
        reason: "blocked",
        match: ["npm publish"],
        notMatch: ["npm install"],
      },
      {
        prefix: "git status",
        effect: "allow",
        reason: "allowed",
        match: ["git status"],
        notMatch: ["git push"],
      },
    ];
    const commands = [
      "npm publish",
      "npm install",
      "git status",
      "git push",
      "rm -rf /",
      "cat .env",
      "echo hello",
    ];

    const legacy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: rules,
    });

    for (const command of commands) {
      const legacyDecision = legacy.evaluate(bashDefinition, call(command));
      // The spine uses the same PolicyEngine; verify the disposition matches.
      // We check via the spine's runtime policy by running the tool and
      // checking isError.
      const root = await createTestDirectory(`spine-matrix-${command.replace(/\W+/g, "_")}`);
      const registry = new AgentToolRegistry([fixtureBashTool()]);
      const spine = createSessionEffectSpine({
        cwd: root,
        registry,
        taskId: `task_matrix_${command.replace(/\W+/g, "_")}`,
        model,
        permission: {
          mode: "full-auto",
          projectTrusted: true,
          protectedPaths: [".env"],
          prefixRules: rules,
        },
      });
      const agent = await CodingAgent.create({
        cwd: root,
        model,
        modelClient: unusedModelClient,
        tools: registry.values(),
        toolRegistry: registry,
        permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [".env"] },
        sessionStore: new SessionStore("unused", false),
        effectPort: spine.effectPort,
        effectContext: spine.effectContext,
      });
      const result = await agent.runTool("bash", { command });
      const spineAllowed = result.isError !== true;
      expect(spineAllowed).toBe(legacyDecision.allowed);
    }
  });
});
