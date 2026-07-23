import {
  newId,
  sha256Digest,
  type ActionIntentV1,
  type EffectClaimV1,
  type EffectReceiptV1,
  type ToolSpecV1,
} from "@focuscode/contracts";
import type { AgentToolCall, ToolDefinition, ToolExecutionResult } from "./types.js";

/**
 * Version stamped on ToolSpecV1 specs adapted from session ToolDefinitions.
 * The composition root must stamp the same value so LocalActionRuntime's
 * version/digest drift check passes; keep a single source here.
 */
export const SESSION_TOOL_SPEC_VERSION = "1.0.0";

export interface SessionEffectProfile {
  effectClass: EffectClaimV1["class"];
  capability: string;
  idempotency: ToolSpecV1["idempotency"];
}

/**
 * One-to-one enumerable mapping from the session ToolDefinition effect enum to
 * the canonical effect class, capability and idempotency of ToolSpecV1.
 */
export const SESSION_EFFECT_PROFILE: Record<ToolDefinition["effect"], SessionEffectProfile> = {
  read: { effectClass: "read", capability: "repo.read", idempotency: "read" },
  write: { effectClass: "file_write", capability: "repo.write", idempotency: "non_idempotent" },
  shell: { effectClass: "command", capability: "process.shell", idempotency: "non_idempotent" },
  git: { effectClass: "git", capability: "repo.git", idempotency: "idempotent" },
  network: { effectClass: "network", capability: "net.fetch", idempotency: "non_idempotent" },
};

/**
 * Build the canonical ToolSpecV1 for a session ToolDefinition. Both the
 * composition root's spine adapter and the local PermissionController adapter
 * stamp specs from this single source so their policy decisions agree.
 */
export function buildSessionToolSpec(definition: ToolDefinition): ToolSpecV1 {
  const profile = SESSION_EFFECT_PROFILE[definition.effect];
  return {
    id: definition.name,
    version: SESSION_TOOL_SPEC_VERSION,
    description: definition.description || definition.name,
    inputSchema: definition.parameters,
    outputSchema: { type: "object", properties: { content: { type: "string" } } },
    schemaDigest: sha256Digest(definition.parameters),
    effectClasses: [profile.effectClass],
    idempotency: profile.idempotency,
    requiredCapabilities: [profile.capability],
  };
}

/**
 * Translate one session tool call into a canonical ActionIntentV1.
 *
 * actionId is a fresh `newId("action")` per invocation, not the provider call
 * id: the session loop submits each tool call exactly once and never replays
 * inside a process, so the EffectPort idempotency cache has nothing to dedup
 * here. Worse, provider call ids are not unique across turns in prompt-json
 * mode (`call_${index}` repeats every round), so keying the cache on call.id
 * would hard-fail with "action id reused" or return stale receipts when a
 * command is legitimately re-issued. A fresh actionId preserves the legacy
 * execute-exactly-once-per-decision semantics; crash/replay dedup stays with
 * the kernel path.
 */
export function buildActionIntent(
  call: AgentToolCall,
  definition: ToolDefinition,
  taskId: string,
): ActionIntentV1 {
  const profile = SESSION_EFFECT_PROFILE[definition.effect];
  const resource = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
  return {
    schemaVersion: "action-intent.v1",
    actionId: newId("action"),
    taskId,
    tool: {
      id: definition.name,
      version: SESSION_TOOL_SPEC_VERSION,
      schemaDigest: sha256Digest(definition.parameters),
    },
    arguments: call.arguments,
    expectedEffects: [
      {
        class: profile.effectClass,
        ...(resource ? { resource } : {}),
        description: `${definition.name} (${profile.effectClass})`,
      },
    ],
    justification: `Session tool call ${call.name} (${call.id})`,
  };
}

/**
 * Translate an EffectReceiptV1 back into the session ToolExecutionResult
 * shape. Grant linkage (grantId, receiptDigest, grant expiry) rides in
 * metadata so tool_end events and the audit journal can join session effects
 * to the spine without logging arguments or output content.
 */
export function receiptToToolResult(receipt: EffectReceiptV1): ToolExecutionResult {
  const metadata: Record<string, unknown> = {
    grantId: receipt.grantId,
    receiptDigest: sha256Digest(receipt),
    ...(receipt.grant ? { grantExpiresAt: receipt.grant.expiresAt } : {}),
  };
  if (receipt.status === "applied") {
    return { content: receiptContent(receipt), metadata };
  }
  const message = receipt.message ?? "no detail";
  // A rejected receipt without a grant is a policy denial (mirrors the legacy
  // "Permission denied" shape); one carrying a grant failed during execution
  // and its message is the raw tool error.
  const content = receipt.grant ? message : `Permission denied: ${message}`;
  return { content, isError: true, metadata };
}

/**
 * LocalActionRuntime serializes tool output as JSON text in receipt.message;
 * unwrap the common string case so the transcript keeps the exact legacy
 * content, and fall back to the raw message for anything else.
 */
function receiptContent(receipt: EffectReceiptV1): string {
  const message = receipt.message ?? "";
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "string" ? parsed : message;
  } catch {
    return message;
  }
}
