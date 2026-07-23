import type {
  ActionIntentV1,
  AtomicDecisionResultV1,
  CertifiedModelRefV1,
  DomainEventV1,
  EffectReceiptV1,
  ExecutionContextV1,
  KernelCheckpointV1,
  NewDomainEventV1,
  TurnInputV1,
  VerificationReportV1,
} from "./schemas.js";

export interface DecisionPort {
  decide(input: TurnInputV1, model: CertifiedModelRefV1): Promise<AtomicDecisionResultV1>;
}

export interface EffectContextV1 {
  execution: ExecutionContextV1;
  model: CertifiedModelRefV1;
  workerId: string;
}

export interface EffectPort {
  /**
   * Submit intents for policy-gated execution. When `signal` is provided the
   * runtime must thread it into the underlying tool execution so an in-flight
   * tool can be cancelled; cancellation between intents always applies.
   */
  submit(
    intents: ActionIntentV1[],
    context: EffectContextV1,
    signal?: AbortSignal,
  ): Promise<EffectReceiptV1[]>;
}

export interface AppendRequestV1 {
  taskId: string;
  expectedVersion: number;
  events: NewDomainEventV1[];
}

export interface AppendAckV1 {
  firstSeq: number;
  lastSeq: number;
  events: DomainEventV1[];
}

export interface FactPort {
  append(request: AppendRequestV1): Promise<AppendAckV1>;
  loadEvents(taskId: string, afterSeq?: number): Promise<DomainEventV1[]>;
  loadCheckpoint(taskId: string): Promise<KernelCheckpointV1 | undefined>;
  saveCheckpoint(checkpoint: KernelCheckpointV1): Promise<void>;
}

export interface VerificationRequestV1 {
  taskId: string;
  phase: "baseline" | "target";
  baseline?: VerificationReportV1;
}

export interface VerifyPort {
  verify(request: VerificationRequestV1): Promise<VerificationReportV1>;
}
