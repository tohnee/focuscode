import { normalizeRelativePath, type ActionIntentV1, type ToolSpecV1 } from "@focuscode/contracts";
import type { EffectLedgerSnapshot } from "./effect-ledger.js";
import {
  TRUSTED_PROJECT_COMMAND,
  classifyShell,
  commandReferencesPath,
  extractApplyPatchPaths,
  PrefixRuleEngine,
  type CommandPrefixRule,
  type PrefixRuleCheckResult,
} from "./shell-policy.js";

export type PolicyDisposition = "grant" | "approval_required" | "deny";

/**
 * Conversational-agent approval modes. Setting PolicyConfig.approvalMode
 * switches PolicyEngine.evaluate to the session approval matrix, the single
 * rule source behind the agent-runtime PermissionController.
 */
export type ApprovalMode = "ask" | "auto-edit" | "full-auto" | "deny";

export interface PolicyDecision {
  disposition: PolicyDisposition;
  reason: string;
  riskScore: number;
}

export interface PolicyConfig {
  protectedPaths: string[];
  maxChangedFiles: number;
  maxChangedLines: number;
  maxRiskScore: number;
  allowNetwork: boolean;
  allowSecrets: boolean;
  autoGrantRegisteredCommands: boolean;
  autoGrantSafeWrites: boolean;
  /**
   * Session approval matrix selector. When set, evaluate() applies the
   * conversational agent's grant/approval_required/deny semantics; when
   * omitted, the kernel default envelope applies (write/command/git ⇒
   * approval_required, read-only ⇒ grant, protected paths hard-denied).
   */
  approvalMode?: ApprovalMode;
  /**
   * Trust gate for repository-controlled verification commands; only relevant
   * when approvalMode is "auto-edit".
   */
  projectTrusted?: boolean;
  /**
   * User-configurable command prefix rules. When set, PolicyEngine constructs a
   * PrefixRuleEngine (running its load-time self-test) and applies the rules
   * inside evaluate(): prefix deny is immediate (stricter-than-engine), prefix
   * allow promotes non-deny decisions to grant but cannot bypass hard denials
   * (critical commands, protected paths, capability checks). This makes both
   * the legacy PermissionController path and the effect spine path decide
   * identically — the P0 fix for the spine prefixRules split-brain.
   */
  prefixRules?: CommandPrefixRule[];
}

export interface ApprovalRequest {
  intent: ActionIntentV1;
  tool: ToolSpecV1;
  reason: string;
  currentLedger: EffectLedgerSnapshot;
  projectedRiskScore: number;
}

export interface ApprovalPort {
  request(request: ApprovalRequest): Promise<boolean>;
}

export class PolicyEngine {
  private readonly prefixEngine: PrefixRuleEngine | undefined;

  constructor(private readonly config: PolicyConfig) {
    // Construct the prefix engine (runs self-test) only when rules are
    // provided. An empty array still constructs the engine but is a no-op.
    this.prefixEngine = config.prefixRules ? new PrefixRuleEngine(config.prefixRules) : undefined;
  }

  evaluate(
    intent: ActionIntentV1,
    tool: ToolSpecV1,
    ledger: EffectLedgerSnapshot,
    projectedRiskScore: number,
  ): PolicyDecision {
    // Prefix rule check (P0: spine prefixRules). Prefix deny is immediate
    // (stricter-than-engine): always wins, even in full-auto, before any
    // capability/budget check. Prefix allow is held back and applied only to
    // non-deny decisions, so hard denials (critical commands, protected
    // paths, unadvertised effects, capability/budget checks) cannot be
    // bypassed. This mirrors the legacy PermissionController contract so both
    // paths decide identically.
    let prefixAllow: PrefixRuleCheckResult | undefined;
    if (this.prefixEngine && tool.id === "bash") {
      const command = readCommandArgument(intent.arguments);
      if (typeof command === "string") {
        const result = this.prefixEngine.check(command);
        if (result) {
          if (result.effect === "deny") {
            return {
              disposition: "deny",
              reason: `Prefix rule denied: ${result.reason}`,
              riskScore: projectedRiskScore,
            };
          }
          prefixAllow = result;
        }
      }
    }

    const decision = this.evaluateCore(intent, tool, ledger, projectedRiskScore);

    // Hard deny from the core cannot be overridden by prefix allow.
    if (decision.disposition === "deny") return decision;

    // Prefix allow promotes approval_required (and grant) to grant without
    // prompting. It cannot override a hard deny (already returned above).
    if (prefixAllow) {
      return {
        disposition: "grant",
        reason: `Prefix rule allowed: ${prefixAllow.reason}`,
        riskScore: projectedRiskScore,
      };
    }
    return decision;
  }

  private evaluateCore(
    intent: ActionIntentV1,
    tool: ToolSpecV1,
    ledger: EffectLedgerSnapshot,
    projectedRiskScore: number,
  ): PolicyDecision {
    const effectClasses = new Set(intent.expectedEffects.map((effect) => effect.class));
    const unadvertised = [...effectClasses].filter(
      (effectClass) => !tool.effectClasses.includes(effectClass),
    );
    if (unadvertised.length > 0) {
      return {
        disposition: "deny",
        reason: `Intent claims effects not declared by tool: ${unadvertised.join(", ")}`,
        riskScore: projectedRiskScore,
      };
    }

    if (this.config.approvalMode === undefined) {
      // Kernel envelope: protected paths are a hard deny. Besides the
      // structured path argument, shell-class intents also scan the command
      // text so references such as `cat ~/.ssh/id_rsa` cannot slip past the
      // write-capability guard.
      const path = readPathArgument(intent.arguments);
      if (path && this.isProtected(path)) {
        return {
          disposition: "deny",
          reason: `Protected path is outside this task's write capability: ${path}`,
          riskScore: projectedRiskScore,
        };
      }
      const command = readCommandArgument(intent.arguments);
      if (command !== undefined && tool.effectClasses.includes("command")) {
        const reference = this.protectedCommandReference(command);
        if (reference) {
          return {
            disposition: "deny",
            reason: `Shell command references protected resource: ${reference}`,
            riskScore: projectedRiskScore,
          };
        }
      }
    }
    if (effectClasses.has("network") && !this.config.allowNetwork) {
      return {
        disposition: "deny",
        reason: "Network effects are disabled by the policy snapshot",
        riskScore: projectedRiskScore,
      };
    }
    if (effectClasses.has("secret") && !this.config.allowSecrets) {
      return {
        disposition: "deny",
        reason: "Secret capabilities are not available in the local alpha runtime",
        riskScore: projectedRiskScore,
      };
    }
    if (projectedRiskScore > this.config.maxRiskScore) {
      return {
        disposition: "deny",
        reason: `Cumulative risk ${projectedRiskScore} exceeds ${this.config.maxRiskScore}`,
        riskScore: projectedRiskScore,
      };
    }
    if (ledger.changedFiles.length >= this.config.maxChangedFiles) {
      return {
        disposition: "deny",
        reason: `Changed-file budget ${this.config.maxChangedFiles} has been exhausted`,
        riskScore: projectedRiskScore,
      };
    }
    if (ledger.changedLines >= this.config.maxChangedLines) {
      return {
        disposition: "deny",
        reason: `Changed-line budget ${this.config.maxChangedLines} has been exhausted`,
        riskScore: projectedRiskScore,
      };
    }

    if (tool.id === "run_registered_command" && this.config.autoGrantRegisteredCommands) {
      return {
        disposition: "grant",
        reason: "Command is owner-registered and allowed by this execution profile",
        riskScore: projectedRiskScore,
      };
    }
    if (tool.id === "apply_edit_ir" && this.config.autoGrantSafeWrites) {
      return {
        disposition: "grant",
        reason: "Bounded edit is auto-granted by this task's explicit execution profile",
        riskScore: projectedRiskScore,
      };
    }
    if (this.config.approvalMode !== undefined) {
      return this.evaluateSessionRules(intent, tool, projectedRiskScore);
    }
    if (tool.id === "apply_edit_ir" || effectClasses.has("command") || effectClasses.has("git")) {
      return {
        disposition: "approval_required",
        reason: "This action changes workspace state or starts a process",
        riskScore: projectedRiskScore,
      };
    }
    return {
      disposition: "grant",
      reason: "Read-only action is within the current capability envelope",
      riskScore: projectedRiskScore,
    };
  }

  /**
   * Repoint the session matrix at a new approval mode (interactive
   * approval-mode switching). Only meaningful when the config carries an
   * approvalMode; the kernel envelope is static per task.
   */
  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode;
  }

  /**
   * Session approval matrix: the exact grant/approval_required/deny semantics
   * previously owned by the agent-runtime PermissionController, kept here as
   * the single rule source so the legacy path and the effect spine decide
   * identically. "ask" turns denials into approval_required; critical shell
   * commands stay a hard deny in every mode.
   */
  private evaluateSessionRules(
    intent: ActionIntentV1,
    tool: ToolSpecV1,
    projectedRiskScore: number,
  ): PolicyDecision {
    const mode = this.config.approvalMode ?? "ask";
    const argumentsValue = intentArguments(intent.arguments);
    const invalid = argumentsValue._invalid;
    if (typeof invalid === "string") {
      return this.sessionRuling(invalid, mode, projectedRiskScore);
    }

    if (tool.id === "bash") {
      const command = argumentsValue.command;
      if (typeof command !== "string" || !command.trim()) {
        return this.sessionRuling(
          "Shell command must be a non-empty string",
          mode,
          projectedRiskScore,
        );
      }
      const classification = classifyShell(command);
      const protectedReference = this.protectedCommandReference(command);
      // Catastrophic commands are a hard deny in every mode and never prompt;
      // a protected reference takes the reference wording, matching the
      // legacy ordering that checked it before the classification.
      if (classification.risk === "critical") {
        return {
          disposition: "deny",
          reason: protectedReference
            ? `Shell command references protected resource: ${protectedReference}`
            : `Critical shell command blocked: ${classification.reason}`,
          riskScore: projectedRiskScore,
        };
      }
      if (protectedReference) {
        return this.sessionRuling(
          `Shell command references protected resource: ${protectedReference}`,
          mode,
          projectedRiskScore,
        );
      }
      if (classification.risk === "low") {
        return {
          disposition: "grant",
          reason: classification.reason,
          riskScore: projectedRiskScore,
        };
      }
      if (mode === "full-auto" && classification.risk !== "high") {
        return {
          disposition: "grant",
          reason: "Full-auto mode allows non-critical command",
          riskScore: projectedRiskScore,
        };
      }
      if (
        mode === "auto-edit" &&
        this.config.projectTrusted === true &&
        TRUSTED_PROJECT_COMMAND.test(command)
      ) {
        return {
          disposition: "grant",
          reason: "Trusted project verification command",
          riskScore: projectedRiskScore,
        };
      }
      if (mode === "deny") {
        return {
          disposition: "deny",
          reason: "Shell execution disabled",
          riskScore: projectedRiskScore,
        };
      }
      return this.sessionRuling(classification.reason, mode, projectedRiskScore);
    }

    const protectedResource = this.protectedSessionResource(tool.id, argumentsValue);
    if (protectedResource) {
      return this.sessionRuling(
        `Protected resource requires explicit access: ${protectedResource}`,
        mode,
        projectedRiskScore,
      );
    }
    if (tool.effectClasses.includes("read") || tool.id === "git_status" || tool.id === "git_diff") {
      return {
        disposition: "grant",
        reason: "Read-only workspace operation",
        riskScore: projectedRiskScore,
      };
    }
    if (mode === "full-auto") {
      return { disposition: "grant", reason: "Full-auto mode", riskScore: projectedRiskScore };
    }
    if (mode === "auto-edit" && tool.effectClasses.includes("file_write")) {
      return {
        disposition: "grant",
        reason: "Workspace edit allowed by auto-edit mode",
        riskScore: projectedRiskScore,
      };
    }
    if (mode === "deny") {
      return {
        disposition: "deny",
        reason: "Side effects disabled",
        riskScore: projectedRiskScore,
      };
    }
    return this.sessionRuling("Explicit approval required", mode, projectedRiskScore);
  }

  /** Denials that stay approval-gated under "ask" and final in other modes. */
  private sessionRuling(reason: string, mode: ApprovalMode, riskScore: number): PolicyDecision {
    return { disposition: mode === "ask" ? "approval_required" : "deny", reason, riskScore };
  }

  /**
   * Protected-resource lookup for session tools: the patch body of
   * apply_patch, and the structured path argument of the file/git tools that
   * carry one (mirroring the legacy PermissionController tool list).
   */
  private protectedSessionResource(
    toolId: string,
    argumentsValue: Record<string, unknown>,
  ): string | undefined {
    if (toolId === "apply_patch") {
      const patch = argumentsValue.patch;
      if (typeof patch !== "string") return undefined;
      const paths = extractApplyPatchPaths(patch);
      return this.normalizedProtectedPaths().find((protectedPath) =>
        paths.some((path) => path === protectedPath || path.startsWith(`${protectedPath}/`)),
      );
    }
    if (!["read", "write", "edit", "git_diff"].includes(toolId)) return undefined;
    const rawPath = argumentsValue.path;
    if (typeof rawPath !== "string") return undefined;
    const normalized = normalizeRelativePath(rawPath);
    return this.normalizedProtectedPaths().find(
      (protectedPath) => normalized === protectedPath || normalized.startsWith(`${protectedPath}/`),
    );
  }

  private protectedCommandReference(command: string): string | undefined {
    return this.normalizedProtectedPaths().find((path) => commandReferencesPath(command, path));
  }

  private normalizedProtectedPaths(): string[] {
    return this.config.protectedPaths.map(normalizeRelativePath);
  }

  private isProtected(path: string): boolean {
    const normalized = normalizeRelativePath(path);
    return this.normalizedProtectedPaths().some((protectedPath) => {
      return normalized === protectedPath || normalized.startsWith(`${protectedPath}/`);
    });
  }
}

function readPathArgument(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const path = (value as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

function readCommandArgument(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const command = (value as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function intentArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
