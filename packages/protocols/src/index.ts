import { sha256Digest, type ArtifactRefV1, type Digest } from "@focuscode/contracts";

export interface ProtocolCapabilitiesV1 {
  protocolVersion: string;
  events: boolean;
  diff: boolean;
  approval: "none" | "coarse" | "fine";
  cancel: boolean;
  checkpoint: boolean;
}

export interface CapabilityNegotiationResultV1 {
  selectedVersion: string;
  enabled: string[];
  disabled: Array<{ capability: string; reason: string }>;
  safeMode: "full" | "read-only" | "unsupported";
}

export function negotiateAcpCapabilities(
  client: ProtocolCapabilitiesV1,
  server: ProtocolCapabilitiesV1,
): CapabilityNegotiationResultV1 {
  if (client.protocolVersion !== server.protocolVersion) {
    return {
      selectedVersion: server.protocolVersion,
      enabled: [],
      disabled: [{ capability: "protocol", reason: "Version mismatch" }],
      safeMode: "unsupported",
    };
  }
  const enabled: string[] = [];
  const disabled: Array<{ capability: string; reason: string }> = [];
  for (const capability of ["events", "diff", "cancel", "checkpoint"] as const) {
    if (client[capability] && server[capability]) enabled.push(capability);
    else disabled.push({ capability, reason: "Not supported by both peers" });
  }
  const fineApproval = client.approval === "fine" && server.approval === "fine";
  if (fineApproval) enabled.push("fine-approval");
  else disabled.push({ capability: "fine-approval", reason: "Fine-grained approval unavailable" });
  return {
    selectedVersion: server.protocolVersion,
    enabled,
    disabled,
    safeMode: fineApproval && enabled.includes("checkpoint") ? "full" : "read-only",
  };
}

export interface McpToolPinV1 {
  serverId: string;
  serverVersion: string;
  toolName: string;
  schemaDigest: Digest;
  transportDigest: Digest;
}

export class McpSchemaChangedError extends Error {
  constructor(
    readonly expected: McpToolPinV1,
    readonly observed: McpToolPinV1,
  ) {
    super(`MCP tool changed after approval: ${expected.serverId}/${expected.toolName}`);
    this.name = "McpSchemaChangedError";
  }
}

export function assertMcpToolPin(expected: McpToolPinV1, observed: McpToolPinV1): void {
  if (sha256Digest(expected) !== sha256Digest(observed)) {
    throw new McpSchemaChangedError(expected, observed);
  }
}

export interface DelegationSpecV1 {
  schemaVersion: "delegation-spec.v1";
  delegationId: string;
  objective: string;
  inputs: ArtifactRefV1[];
  allowedData: string[];
  allowedCapabilities: string[];
  outputSchemaDigest: Digest;
  maxTurns: number;
  deadline: string;
  maxDelegationDepth: number;
}

export function assertReadOnlyDelegation(spec: DelegationSpecV1): void {
  const forbidden = spec.allowedCapabilities.filter(
    (capability) => !["repo.read", "artifact.read", "analysis.respond"].includes(capability),
  );
  if (forbidden.length > 0) {
    throw new Error(`Alpha A2A gateway rejects write capabilities: ${forbidden.join(", ")}`);
  }
  if (spec.maxDelegationDepth > 1) throw new Error("Alpha A2A gateway permits one delegation hop");
}

export type NativeCapsuleTrustLevel = "C0" | "C1" | "C2" | "C3";

export interface NativeCapsuleManifestV1 {
  capsuleId: string;
  interceptsAllTools: boolean;
  exportsTypedEvents: boolean;
  supportsCancel: boolean;
  supportsCheckpoint: boolean;
  confinesNetworkAndFiles: boolean;
}

export function classifyNativeCapsule(manifest: NativeCapsuleManifestV1): NativeCapsuleTrustLevel {
  if (
    manifest.interceptsAllTools &&
    manifest.exportsTypedEvents &&
    manifest.supportsCancel &&
    manifest.supportsCheckpoint &&
    manifest.confinesNetworkAndFiles
  ) {
    return "C0";
  }
  if (manifest.interceptsAllTools && manifest.confinesNetworkAndFiles) return "C1";
  if (manifest.confinesNetworkAndFiles) return "C2";
  return "C3";
}
