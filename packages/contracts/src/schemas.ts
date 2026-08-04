import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const Strict = { additionalProperties: false } as const;

export const DigestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
export type Digest = Static<typeof DigestSchema>;
export const IsoDateTimeSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});

export const ArtifactRefSchema = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    mediaType: Type.String({ minLength: 1 }),
    digest: DigestSchema,
    label: Type.Optional(Type.String()),
  },
  Strict,
);
export type ArtifactRefV1 = Static<typeof ArtifactRefSchema>;

export const AcceptanceCriterionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    verificationCommandId: Type.Optional(Type.String({ minLength: 1 })),
  },
  Strict,
);

export const ScopeConstraintSchema = Type.Object(
  {
    include: Type.Optional(Type.Array(Type.String())),
    exclude: Type.Optional(Type.Array(Type.String())),
    maxFiles: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChangedLines: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  Strict,
);

export const TaskSpecSchema = Type.Object(
  {
    schemaVersion: Type.Literal("task-spec.v1"),
    repoId: Type.String({ minLength: 1 }),
    baseRef: Type.String({ minLength: 1 }),
    mode: Type.Union([
      Type.Literal("explore"),
      Type.Literal("change"),
      Type.Literal("review"),
      Type.Literal("verify"),
    ]),
    objective: Type.String({ minLength: 1 }),
    acceptanceCriteria: Type.Array(AcceptanceCriterionSchema),
    scope: Type.Optional(ScopeConstraintSchema),
    requestedProfile: Type.Optional(
      Type.Union([
        Type.Literal("balanced"),
        Type.Literal("quality"),
        Type.Literal("local"),
        Type.Literal("fast"),
      ]),
    ),
  },
  Strict,
);
export type TaskSpecV1 = Static<typeof TaskSpecSchema>;

export const ActorRefSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("user"), Type.Literal("service"), Type.Literal("agent")]),
  },
  Strict,
);
export type ActorRefV1 = Static<typeof ActorRefSchema>;

export const BudgetSchema = Type.Object(
  {
    maxTurns: Type.Integer({ minimum: 1, maximum: 200 }),
    maxActions: Type.Integer({ minimum: 0, maximum: 2_000 }),
    maxWallTimeMs: Type.Integer({ minimum: 1_000 }),
    maxChangedFiles: Type.Integer({ minimum: 0 }),
    maxChangedLines: Type.Integer({ minimum: 0 }),
  },
  Strict,
);
export type BudgetV1 = Static<typeof BudgetSchema>;

export const ExecutionContextSchema = Type.Object(
  {
    schemaVersion: Type.Literal("execution-context.v1"),
    taskId: Type.String({ minLength: 1 }),
    tenantId: Type.String({ minLength: 1 }),
    actor: ActorRefSchema,
    dataClass: Type.Union([Type.Literal("standard"), Type.Literal("restricted")]),
    policySnapshot: DigestSchema,
    budget: BudgetSchema,
    traceId: Type.String({ minLength: 1 }),
    createdAt: IsoDateTimeSchema,
  },
  Strict,
);
export type ExecutionContextV1 = Static<typeof ExecutionContextSchema>;

export const ToolRefSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    schemaDigest: DigestSchema,
  },
  Strict,
);
export type ToolRefV1 = Static<typeof ToolRefSchema>;

export const EffectClaimSchema = Type.Object(
  {
    class: Type.Union([
      Type.Literal("read"),
      Type.Literal("file_write"),
      Type.Literal("command"),
      Type.Literal("network"),
      Type.Literal("secret"),
      Type.Literal("git"),
      Type.Literal("delegation"),
    ]),
    resource: Type.Optional(Type.String()),
    description: Type.String({ minLength: 1 }),
  },
  Strict,
);
export type EffectClaimV1 = Static<typeof EffectClaimSchema>;

export const ActionIntentSchema = Type.Object(
  {
    schemaVersion: Type.Literal("action-intent.v1"),
    actionId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    tool: ToolRefSchema,
    arguments: Type.Unknown(),
    expectedEffects: Type.Array(EffectClaimSchema),
    justification: Type.String({ minLength: 1 }),
    baseState: Type.Optional(DigestSchema),
  },
  Strict,
);
export type ActionIntentV1 = Static<typeof ActionIntentSchema>;

export const WorkloadIdentitySchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1 }),
    workerId: Type.String({ minLength: 1 }),
    modelCertificateId: Type.String({ minLength: 1 }),
  },
  Strict,
);

export const CapabilitySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    resource: Type.Optional(Type.String()),
  },
  Strict,
);

export const GrantConstraintSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    value: Type.Unknown(),
  },
  Strict,
);

export const CapabilityGrantSchema = Type.Object(
  {
    schemaVersion: Type.Literal("capability-grant.v1"),
    grantId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    subject: WorkloadIdentitySchema,
    capabilities: Type.Array(CapabilitySchema),
    constraints: Type.Array(GrantConstraintSchema),
    expiresAt: IsoDateTimeSchema,
    fencingToken: Type.String({ minLength: 1 }),
    policySnapshotDigest: DigestSchema,
  },
  Strict,
);
export type CapabilityGrantV1 = Static<typeof CapabilityGrantSchema>;

export const EffectObservationSchema = Type.Object(
  {
    class: Type.String({ minLength: 1 }),
    resource: Type.Optional(Type.String()),
    detail: Type.Unknown(),
  },
  Strict,
);
export type EffectObservationV1 = Static<typeof EffectObservationSchema>;

export const EffectReceiptSchema = Type.Object(
  {
    schemaVersion: Type.Literal("effect-receipt.v1"),
    actionId: Type.String({ minLength: 1 }),
    grantId: Type.String({ minLength: 1 }),
    grant: Type.Optional(CapabilityGrantSchema),
    status: Type.Union([
      Type.Literal("applied"),
      Type.Literal("rejected"),
      Type.Literal("partial"),
      Type.Literal("unknown"),
    ]),
    observedEffects: Type.Array(EffectObservationSchema),
    artifacts: Type.Array(ArtifactRefSchema),
    before: Type.Optional(DigestSchema),
    after: Type.Optional(DigestSchema),
    reconciliation: Type.Union([
      Type.Literal("matched"),
      Type.Literal("mismatch"),
      Type.Literal("required"),
    ]),
    message: Type.Optional(Type.String()),
  },
  Strict,
);
export type EffectReceiptV1 = Static<typeof EffectReceiptSchema>;

export const ToolSpecSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    inputSchema: Type.Record(Type.String(), Type.Unknown()),
    outputSchema: Type.Record(Type.String(), Type.Unknown()),
    schemaDigest: DigestSchema,
    effectClasses: Type.Array(Type.String()),
    idempotency: Type.Union([
      Type.Literal("read"),
      Type.Literal("idempotent"),
      Type.Literal("conditional"),
      Type.Literal("non_idempotent"),
    ]),
    requiredCapabilities: Type.Array(Type.String()),
  },
  Strict,
);
export type ToolSpecV1 = Static<typeof ToolSpecSchema>;

export const RespondDecisionSchema = Type.Object(
  {
    kind: Type.Literal("respond"),
    content: Type.Array(Type.String()),
  },
  Strict,
);

export const AskUserDecisionSchema = Type.Object(
  {
    kind: Type.Literal("ask_user"),
    questions: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
  },
  Strict,
);

export const ToolIntentDecisionSchema = Type.Object(
  {
    kind: Type.Literal("tool_intent"),
    intents: Type.Array(ActionIntentSchema, { minItems: 1, maxItems: 8 }),
  },
  Strict,
);

export const PlanRevisionDecisionSchema = Type.Object(
  {
    kind: Type.Literal("plan_revision"),
    steps: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
    evidence: Type.Array(ArtifactRefSchema),
  },
  Strict,
);

export const DelegationIntentDecisionSchema = Type.Object(
  {
    kind: Type.Literal("delegate_intent"),
    delegation: Type.Unknown(),
  },
  Strict,
);

export const CompletionCandidateDecisionSchema = Type.Object(
  {
    kind: Type.Literal("completion_candidate"),
    summary: Type.String({ minLength: 1 }),
    evidence: Type.Array(ArtifactRefSchema),
    residualRisks: Type.Array(Type.String()),
  },
  Strict,
);

export const ModelDecisionSchema = Type.Union([
  RespondDecisionSchema,
  AskUserDecisionSchema,
  ToolIntentDecisionSchema,
  DelegationIntentDecisionSchema,
  PlanRevisionDecisionSchema,
  CompletionCandidateDecisionSchema,
]);
export type ModelDecisionV1 = Static<typeof ModelDecisionSchema>;

export const UsageRecordSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    cachedInputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    estimatedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  Strict,
);
export type UsageRecordV1 = Static<typeof UsageRecordSchema>;

export const CacheEpochManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("cache-epoch.v1"),
    /** 模型 revision;来自 ModelProfile.revision。 */
    modelRevision: Type.String({ minLength: 1 }),
    /** chat template 指纹;暂用 provider+protocol 组合的 hash 占位。 */
    chatTemplateHash: Type.Optional(Type.String()),
    /** 核心工具 schema 的稳定指纹(JSON canonical sha256)。 */
    toolBundleHash: Type.String({ minLength: 1 }),
    /** stable system 段(含 instructions/extensionPrompt)的 sha256。 */
    systemHash: Type.String({ minLength: 1 }),
    /** thinkingFormat 方言("openai"|"deepseek"|"qwen"|"zai")。 */
    reasoningProtocol: Type.Optional(Type.String()),
    /** wire protocol("openai-chat"|"anthropic-messages"|...)。 */
    toolProtocol: Type.Optional(Type.String()),
    /** cacheControl.mode("openai-prefix"|"anthropic-ephemeral"|"none")。 */
    cacheMode: Type.Optional(Type.String()),
  },
  Strict,
);
export type CacheEpochManifestV1 = Static<typeof CacheEpochManifestSchema>;

export interface ParserDiagnosticV1 {
  code: string;
  message: string;
}

export interface AtomicDecisionResultV1 {
  status: "complete" | "invalid" | "truncated" | "provider_error";
  decision?: ModelDecisionV1;
  providerStateRef?: string;
  usage: UsageRecordV1;
  rawArtifact?: ArtifactRefV1;
  parserDiagnostics: ParserDiagnosticV1[];
}

export const CanonicalFrameSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    content: Type.String(),
    provenance: Type.Array(Type.String()),
    trust: Type.Union([
      Type.Literal("system"),
      Type.Literal("owner"),
      Type.Literal("repository"),
      Type.Literal("tool"),
      Type.Literal("model"),
    ]),
    acl: Type.Array(Type.String()),
    createdAt: IsoDateTimeSchema,
    expiresAt: Type.Optional(IsoDateTimeSchema),
    digest: DigestSchema,
    tokenEstimate: Type.Integer({ minimum: 0 }),
    priority: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  Strict,
);
export type CanonicalFrameV1 = Static<typeof CanonicalFrameSchema>;

export const TaskStateSchema = Type.Union([
  Type.Literal("CREATED"),
  Type.Literal("PREFLIGHT"),
  Type.Literal("WAITING_INPUT"),
  Type.Literal("READY"),
  Type.Literal("RUNNING"),
  Type.Literal("WAITING_APPROVAL"),
  Type.Literal("PAUSED"),
  Type.Literal("VERIFYING"),
  Type.Literal("REVIEW_READY"),
  Type.Literal("RECONCILING"),
  Type.Literal("BLOCKED"),
  Type.Literal("ACCEPTED"),
  Type.Literal("REJECTED"),
  Type.Literal("CANCELLING"),
  Type.Literal("CANCELLED"),
  Type.Literal("FAILED"),
  Type.Literal("EXPIRED"),
]);
export type TaskStateV1 = Static<typeof TaskStateSchema>;

export const DomainEventSchema = Type.Object(
  {
    schemaVersion: Type.Literal("domain-event.v1"),
    eventId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    seq: Type.Integer({ minimum: 1 }),
    kind: Type.String({ minLength: 1 }),
    at: IsoDateTimeSchema,
    actor: ActorRefSchema,
    payload: Type.Unknown(),
    digest: DigestSchema,
  },
  Strict,
);
export type DomainEventV1 = Static<typeof DomainEventSchema>;
export type NewDomainEventV1 = Omit<DomainEventV1, "seq" | "digest">;

export const CertifiedModelRefSchema = Type.Object(
  {
    modelId: Type.String({ minLength: 1 }),
    modelRevision: DigestSchema,
    tokenizer: DigestSchema,
    chatTemplate: DigestSchema,
    modelPack: DigestSchema,
    deploymentProfile: DigestSchema,
    certificateId: Type.String({ minLength: 1 }),
    certifiedCapabilities: Type.Array(Type.String()),
    riskLevel: Type.Union([
      Type.Literal("sandbox-only"),
      Type.Literal("explore"),
      Type.Literal("change"),
      Type.Literal("pilot"),
    ]),
    /** Optional certificate expiry; the kernel fails closed once it passes. */
    expiresAt: Type.Optional(IsoDateTimeSchema),
  },
  Strict,
);
export type CertifiedModelRefV1 = Static<typeof CertifiedModelRefSchema>;

export const TurnInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal("turn-input.v1"),
    task: TaskSpecSchema,
    execution: ExecutionContextSchema,
    state: TaskStateSchema,
    turn: Type.Integer({ minimum: 1 }),
    publicPlan: Type.Array(Type.String()),
    tools: Type.Array(ToolSpecSchema),
    recentEvents: Type.Array(DomainEventSchema),
    recentEffects: Type.Array(EffectReceiptSchema),
  },
  Strict,
);
export type TurnInputV1 = Static<typeof TurnInputSchema>;

export const VerificationCommandResultSchema = Type.Object(
  {
    commandId: Type.String({ minLength: 1 }),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    stdout: Type.String(),
    stderr: Type.String(),
    durationMs: Type.Integer({ minimum: 0 }),
    timedOut: Type.Boolean(),
    digest: DigestSchema,
  },
  Strict,
);
export type VerificationCommandResultV1 = Static<typeof VerificationCommandResultSchema>;

export const VerificationReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal("verification-report.v1"),
    conclusion: Type.Union([
      Type.Literal("PASS"),
      Type.Literal("BASELINE_FAIL"),
      Type.Literal("PARTIAL"),
      Type.Literal("BLOCKED"),
      Type.Literal("UNKNOWN"),
      Type.Literal("REGRESSION"),
    ]),
    phase: Type.Union([Type.Literal("baseline"), Type.Literal("target")]),
    results: Type.Array(VerificationCommandResultSchema),
    summary: Type.String(),
  },
  Strict,
);
export type VerificationReportV1 = Static<typeof VerificationReportSchema>;

export const KernelCheckpointSchema = Type.Object(
  {
    schemaVersion: Type.Literal("kernel-checkpoint.v1"),
    taskId: Type.String({ minLength: 1 }),
    state: TaskStateSchema,
    eventVersion: Type.Integer({ minimum: 0 }),
    turn: Type.Integer({ minimum: 0 }),
    actionCount: Type.Integer({ minimum: 0 }),
    startedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    publicPlan: Type.Array(Type.String()),
    recentEffects: Type.Array(EffectReceiptSchema),
    model: CertifiedModelRefSchema,
    baseline: Type.Optional(VerificationReportSchema),
  },
  Strict,
);
export type KernelCheckpointV1 = Static<typeof KernelCheckpointSchema>;

export const MemoryRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal("memory-record.v1"),
    memoryId: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("repo_fact"),
      Type.Literal("convention"),
      Type.Literal("decision"),
      Type.Literal("failure_pattern"),
      Type.Literal("validation_fact"),
      Type.Literal("outcome"),
    ]),
    subject: Type.String({ minLength: 1 }),
    claim: Type.Unknown(),
    provenance: Type.Array(Type.String(), { minItems: 1 }),
    confidence: Type.Union([
      Type.Literal("deterministic"),
      Type.Literal("owner_confirmed"),
      Type.Literal("inferred"),
    ]),
    acl: Type.Array(Type.String()),
    validFrom: IsoDateTimeSchema,
    expiresAt: Type.Optional(IsoDateTimeSchema),
    supersedes: Type.Optional(Type.Array(Type.String())),
  },
  Strict,
);
export type MemoryRecordV1 = Static<typeof MemoryRecordSchema>;

export const MemoryWriteProposalSchema = Type.Object(
  {
    schemaVersion: Type.Literal("memory-write-proposal.v1"),
    proposalId: Type.String({ minLength: 1 }),
    taskId: Type.String({ minLength: 1 }),
    record: MemoryRecordSchema,
    proposedBy: ActorRefSchema,
    rationale: Type.String({ minLength: 1 }),
  },
  Strict,
);
export type MemoryWriteProposalV1 = Static<typeof MemoryWriteProposalSchema>;

export interface ModelPackV1 {
  schemaVersion: "model-pack.v1";
  id: string;
  family: string;
  revision: string;
  systemPrompt: string;
  responseFormat: "json";
  maxToolIntentsPerTurn: number;
  contextEnvelope: {
    maxInputChars: number;
    stablePrefixRatio: number;
    maxToolOutputChars: number;
  };
  recovery: { deterministicRepair: boolean; modelRetries: number };
}

export function assertSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label = "value",
): asserts value is Static<T> {
  if (Value.Check(schema, value)) return;
  const errors = [...Value.Errors(schema, value)]
    .slice(0, 8)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`${label} does not match its canonical schema: ${errors}`);
}
