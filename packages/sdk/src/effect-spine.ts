import { LocalActionRuntime, ToolRegistry, type ToolExecutor } from "@focuscode/action-backends";
import {
  PolicyEngine,
  classifyShell,
  type ApprovalMode,
  type ApprovalPort,
  type ApprovalRequest,
  type PolicyConfig,
} from "@focuscode/action-domain";
import {
  SESSION_EFFECT_PROFILE,
  buildSessionToolSpec,
  type AgentTool,
  type AgentToolRegistry,
  type ApprovalHandler,
  type ModelProfile,
  type PermissionRequest,
  type ToolDefinition,
} from "@focuscode/agent-runtime";
import {
  newId,
  sha256Digest,
  type CertifiedModelRefV1,
  type EffectContextV1,
  type EffectPort,
  type ExecutionContextV1,
} from "@focuscode/contracts";

export interface SessionEffectSpineOptions {
  cwd: string;
  /** The session tool registry; the same AgentTool instances back the spine. */
  registry: AgentToolRegistry;
  /** Stable task identifier for the spine; composition roots use the session id. */
  taskId: string;
  model: ModelProfile;
  permission: {
    mode: ApprovalMode;
    projectTrusted: boolean;
    protectedPaths: string[];
  };
  /** Bridges PolicyEngine approvals to the session approval handler; omit to deny. */
  approve?: ApprovalHandler;
  /**
   * Invoked right before the approval handler runs. Composition roots wire
   * this to CodingAgent.notifyApprovalRequired so spine approvals emit the
   * same approval_required event (with audit fan-out) as the legacy path.
   */
  onApprovalRequired?: (request: PermissionRequest) => void | Promise<void>;
  workerId?: string;
}

export interface SessionEffectSpine {
  effectPort: EffectPort;
  effectContext: EffectContextV1;
  runtime: LocalActionRuntime;
  /** Repoint the approval matrix when the session approval mode changes. */
  setApprovalMode(mode: ApprovalMode): void;
}

/**
 * Wire the session tool loop into the audited Policy → Grant → Receipt spine.
 * The returned effectPort/effectContext plug straight into
 * AgentRuntimeOptions; agent-runtime itself only depends on contracts.
 * Rule semantics are single-sourced in the action-domain PolicyEngine
 * (PolicyConfig.approvalMode), so the spine and the legacy path decide
 * identically.
 */
export function createSessionEffectSpine(options: SessionEffectSpineOptions): SessionEffectSpine {
  const tools = new ToolRegistry();
  const definitions = new Map<string, ToolDefinition>();
  // Adapt every registered session tool; sync runs again on each submit so
  // extension tools registered after startup stay visible to the spine.
  const sync = (): void => {
    for (const tool of options.registry.values()) {
      if (tools.get(tool.definition.name)) continue;
      tools.register(adaptSessionTool(tool, options.cwd));
      definitions.set(tool.definition.name, tool.definition);
    }
  };
  sync();
  const policy = new PolicyEngine(sessionPolicyConfig(options.permission));
  const runtime = new LocalActionRuntime(
    tools,
    policy,
    bridgeApproval(options.approve, definitions, options.onApprovalRequired),
  );
  const effectPort: EffectPort = {
    submit(intents, context, signal) {
      sync();
      return runtime.submit(intents, context, signal);
    },
  };
  return {
    effectPort,
    effectContext: sessionEffectContext(options),
    runtime,
    setApprovalMode: (mode) => policy.setApprovalMode(mode),
  };
}

/**
 * One approval prompt per action: LocalActionRuntime calls this port at most
 * once per intent, and the bridge reuses the session's existing handler after
 * surfacing the approval_required signal. Without a handler (print/json/rpc
 * modes) approvals deny, mirroring PermissionController.authorize.
 */
function bridgeApproval(
  approve: ApprovalHandler | undefined,
  definitions: Map<string, ToolDefinition>,
  onApprovalRequired: ((request: PermissionRequest) => void | Promise<void>) | undefined,
): ApprovalPort {
  return {
    async request(request: ApprovalRequest): Promise<boolean> {
      if (!approve) return false;
      const definition = definitions.get(request.tool.id);
      if (!definition) return false;
      const argumentsValue = asRecord(request.intent.arguments);
      const shellRisk =
        definition.name === "bash" ? classifyShell(argumentsValue.command) : undefined;
      const permissionRequest: PermissionRequest = {
        tool: definition,
        arguments: argumentsValue,
        reason: request.reason,
        risk: shellRisk?.risk ?? (definition.effect === "write" ? "medium" : "high"),
      };
      await onApprovalRequired?.(permissionRequest);
      return approve(permissionRequest);
    },
  };
}

function adaptSessionTool(tool: AgentTool, cwd: string): ToolExecutor {
  const definition = tool.definition;
  const profile = SESSION_EFFECT_PROFILE[definition.effect];
  return {
    spec: buildSessionToolSpec(definition),
    async execute(argumentsValue, signal) {
      const args = asRecord(argumentsValue);
      const result = await tool.execute(args, { cwd, ...(signal ? { signal } : {}) });
      if (result.isError) throw new Error(result.content);
      return {
        observedEffects: [
          {
            class: profile.effectClass,
            ...(typeof args.path === "string" ? { resource: args.path } : {}),
            detail: { tool: definition.name },
          },
        ],
        artifacts: [],
        output: result.content,
      };
    },
  };
}

/**
 * Session envelope derived from the approval mode: the PolicyEngine approval
 * matrix is the single rule source for grants, prompts and denials, so the
 * kernel budgets stay generous to avoid hard-denying legitimate long
 * sessions; hard denials (protected paths, critical commands) come from the
 * matrix itself.
 */
function sessionPolicyConfig(permission: SessionEffectSpineOptions["permission"]): PolicyConfig {
  return {
    protectedPaths: permission.protectedPaths,
    maxChangedFiles: 1_000,
    maxChangedLines: 1_000_000,
    maxRiskScore: 100_000,
    allowNetwork: true,
    allowSecrets: false,
    autoGrantRegisteredCommands: false,
    autoGrantSafeWrites: false,
    approvalMode: permission.mode,
    projectTrusted: permission.projectTrusted,
  };
}

function sessionEffectContext(options: SessionEffectSpineOptions): EffectContextV1 {
  const model: CertifiedModelRefV1 = {
    modelId: `${options.model.provider}/${options.model.model}`,
    modelRevision: sha256Digest(options.model.model),
    tokenizer: sha256Digest(`${options.model.provider}:tokenizer`),
    chatTemplate: sha256Digest(`${options.model.provider}:chat-template`),
    modelPack: sha256Digest("session-agent"),
    deploymentProfile: sha256Digest(options.model.baseUrl),
    certificateId: `session-model:${options.model.provider}/${options.model.model}`,
    certifiedCapabilities: ["session-tools"],
    riskLevel: "change",
  };
  const execution: ExecutionContextV1 = {
    schemaVersion: "execution-context.v1",
    taskId: options.taskId,
    tenantId: "local",
    actor: { id: "local-user", kind: "user" },
    dataClass: "standard",
    policySnapshot: sha256Digest({
      mode: options.permission.mode,
      projectTrusted: options.permission.projectTrusted,
      protectedPaths: options.permission.protectedPaths,
    }),
    budget: {
      maxTurns: 200,
      maxActions: 2_000,
      maxWallTimeMs: 3_600_000,
      maxChangedFiles: 1_000,
      maxChangedLines: 1_000_000,
    },
    traceId: newId("trace"),
    createdAt: new Date().toISOString(),
  };
  return { execution, model, workerId: options.workerId ?? `session-worker:${process.pid}` };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
