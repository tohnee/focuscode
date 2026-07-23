import {
  DomainEventSchema,
  assertSchema,
  newId,
  sha256Digest,
  type AppendAckV1,
  type AppendRequestV1,
  type DomainEventV1,
  type EffectContextV1,
  type EffectPort,
  type EffectReceiptV1,
  type FactPort,
  type KernelCheckpointV1,
  type VerificationReportV1,
  type VerificationRequestV1,
  type VerifyPort,
} from "@focuscode/contracts";

export class InMemoryFactStore implements FactPort {
  readonly events: DomainEventV1[] = [];
  checkpoint?: KernelCheckpointV1;

  async append(request: AppendRequestV1): Promise<AppendAckV1> {
    const taskEvents = this.events.filter((event) => event.taskId === request.taskId);
    if (taskEvents.length !== request.expectedVersion) {
      throw new Error(
        `Version conflict: expected ${request.expectedVersion}, actual ${taskEvents.length}`,
      );
    }
    const committed = request.events.map((event, index) => {
      const withoutDigest = { ...event, seq: request.expectedVersion + index + 1 };
      const committedEvent: DomainEventV1 = {
        ...withoutDigest,
        digest: sha256Digest(withoutDigest),
      };
      assertSchema(DomainEventSchema, committedEvent);
      return committedEvent;
    });
    this.events.push(...committed);
    return {
      firstSeq: committed[0]?.seq ?? request.expectedVersion,
      lastSeq: committed.at(-1)?.seq ?? request.expectedVersion,
      events: committed,
    };
  }

  async loadEvents(taskId: string, afterSeq = 0): Promise<DomainEventV1[]> {
    return structuredClone(
      this.events.filter((event) => event.taskId === taskId && event.seq > afterSeq),
    );
  }

  async loadCheckpoint(taskId: string): Promise<KernelCheckpointV1 | undefined> {
    return this.checkpoint?.taskId === taskId ? structuredClone(this.checkpoint) : undefined;
  }

  async saveCheckpoint(checkpoint: KernelCheckpointV1): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }
}

export class FakeEffectPort implements EffectPort {
  readonly submitted: string[] = [];

  async submit(
    intents: Parameters<EffectPort["submit"]>[0],
    _context: EffectContextV1,
  ): Promise<EffectReceiptV1[]> {
    return intents.map((intent) => {
      this.submitted.push(intent.actionId);
      return {
        schemaVersion: "effect-receipt.v1",
        actionId: intent.actionId,
        grantId: newId("grant"),
        status: "applied",
        observedEffects: intent.expectedEffects.map((effect) => ({
          class: effect.class,
          ...(effect.resource ? { resource: effect.resource } : {}),
          detail: {},
        })),
        artifacts: [],
        reconciliation: "matched",
      };
    });
  }
}

export class StaticVerifier implements VerifyPort {
  constructor(
    private readonly baselineConclusion: VerificationReportV1["conclusion"] = "PASS",
    private readonly targetConclusion: VerificationReportV1["conclusion"] = "PASS",
  ) {}

  async verify(request: VerificationRequestV1): Promise<VerificationReportV1> {
    const conclusion =
      request.phase === "baseline" ? this.baselineConclusion : this.targetConclusion;
    return {
      schemaVersion: "verification-report.v1",
      phase: request.phase,
      conclusion,
      results: [],
      summary: `Static verifier: ${conclusion}`,
    };
  }
}
