import { relative, resolve, sep } from "node:path";
import {
  PolicyEngine,
  classifyShell,
  type CommandPrefixRule,
  type EffectLedgerSnapshot,
  type PolicyDecision,
  type PrefixRuleCheckResult,
  PrefixRuleEngine,
} from "@focuscode/action-domain";
import { buildActionIntent, buildSessionToolSpec } from "./effect-gateway.js";
import type {
  AgentToolCall,
  ApprovalHandler,
  ApprovalMode,
  PermissionDecision,
  PermissionRequest,
  ToolDefinition,
} from "./types.js";

// The rule tables (shell classification, protected-path matching) and the
// approval matrix are single-sourced in @focuscode/action-domain; re-export
// the helpers existing callers import from here.
export { classifyShell, commandReferencesPath } from "@focuscode/action-domain";

export interface PermissionControllerOptions {
  cwd: string;
  mode: ApprovalMode;
  projectTrusted: boolean;
  protectedPaths: string[];
  approve?: ApprovalHandler;
  /** User-configurable command prefix rules; evaluated before shell classification. */
  prefixRules?: CommandPrefixRule[];
}

/** Synthetic task id for one-call policy checks; never submitted to an EffectPort. */
const PERMISSION_CHECK_TASK_ID = "permission-check";

/** Local checks evaluate one call at a time, so the cumulative ledger is empty. */
const EMPTY_LEDGER: EffectLedgerSnapshot = {
  changedFiles: [],
  changedLines: 0,
  commands: 0,
  networkRequests: 0,
  secretUses: 0,
  riskScore: 0,
  actionIds: [],
};

/**
 * Local permission adapter over the action-domain PolicyEngine. All rule
 * semantics (shell classification, protected resources, the approval mode
 * matrix) live in PolicyEngine under PolicyConfig.approvalMode; this class
 * only maps PolicyDecisions onto the session PermissionRequest /
 * PermissionDecision shapes and drives the approval handler.
 */
export class PermissionController {
  readonly mode: ApprovalMode;
  private readonly engine: PolicyEngine;
  private readonly prefixEngine: PrefixRuleEngine | undefined;

  constructor(private readonly options: PermissionControllerOptions) {
    this.mode = options.mode;
    this.engine = new PolicyEngine({
      protectedPaths: options.protectedPaths,
      // Single-call checks run against an empty ledger with zero risk, so the
      // cumulative budgets never fire here; the effect spine owns them.
      // allowNetwork stays on because the session matrix gates network tools
      // by mode, exactly like the legacy rule table did.
      maxChangedFiles: 1_000,
      maxChangedLines: 1_000_000,
      maxRiskScore: 100_000,
      allowNetwork: true,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: false,
      approvalMode: options.mode,
      projectTrusted: options.projectTrusted,
    });
    // Construct the prefix engine (runs self-test) only when rules are
    // provided. An empty array still constructs the engine but is a no-op.
    this.prefixEngine = options.prefixRules ? new PrefixRuleEngine(options.prefixRules) : undefined;
  }

  evaluate(tool: ToolDefinition, call: AgentToolCall): PermissionDecision {
    const decision = this.decide(tool, call);
    return { allowed: decision.disposition === "grant", reason: decision.reason };
  }

  async authorize(
    tool: ToolDefinition,
    call: AgentToolCall,
    notify?: (request: PermissionRequest) => void | Promise<void>,
  ): Promise<PermissionDecision> {
    const decision = this.decide(tool, call);
    if (decision.disposition === "grant") return { allowed: true, reason: decision.reason };
    // PolicyEngine only returns approval_required in ask mode, and never for
    // critical shell commands, so no further guard is needed before prompting.
    if (decision.disposition !== "approval_required" || !this.options.approve) {
      return { allowed: false, reason: decision.reason };
    }
    const request: PermissionRequest = {
      tool,
      arguments: call.arguments,
      reason: decision.reason,
      risk: permissionRisk(tool, call),
    };
    await notify?.(request);
    const allowed = await this.options.approve(request);
    return {
      allowed,
      reason: allowed ? "Approved by user" : "Denied by user",
    };
  }

  private decide(tool: ToolDefinition, call: AgentToolCall): PolicyDecision {
    // Prefix rules take precedence over shell classification: a deny rule
    // short-circuits to deny, an allow rule short-circuits to grant. Both
    // bypass the PolicyEngine shell-classification path, but protected-path
    // checks still apply to commands that do not match any prefix rule.
    if (this.prefixEngine && tool.name === "bash") {
      const command = call.arguments.command;
      if (typeof command === "string") {
        const result: PrefixRuleCheckResult | undefined = this.prefixEngine.check(command);
        if (result) {
          if (result.effect === "deny") {
            return {
              disposition: "deny",
              reason: `Prefix rule denied: ${result.reason}`,
              riskScore: 0,
            };
          }
          return {
            disposition: "grant",
            reason: `Prefix rule allowed: ${result.reason}`,
            riskScore: 0,
          };
        }
      }
    }
    return this.engine.evaluate(
      buildActionIntent(call, tool, PERMISSION_CHECK_TASK_ID),
      buildSessionToolSpec(tool),
      EMPTY_LEDGER,
      0,
    );
  }
}

function permissionRisk(tool: ToolDefinition, call: AgentToolCall): PermissionRequest["risk"] {
  const shellRisk = tool.name === "bash" ? classifyShell(call.arguments.command) : undefined;
  return shellRisk?.risk ?? (tool.effect === "write" ? "medium" : "high");
}

export function displayWorkspacePath(cwd: string, path: string): string {
  const candidate = resolve(cwd, path);
  const rel = relative(resolve(cwd), candidate);
  return rel.split(sep).join("/");
}
