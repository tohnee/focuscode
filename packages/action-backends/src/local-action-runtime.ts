import {
  ActionIntentSchema,
  assertSchema,
  newId,
  sha256Digest,
  type ActionIntentV1,
  type CapabilityGrantV1,
  type EffectContextV1,
  type EffectPort,
  type EffectReceiptV1,
} from "@focuscode/contracts";
import {
  EffectLedger,
  PolicyEngine,
  type ApprovalPort,
  type EffectLedgerSnapshot,
} from "@focuscode/action-domain";
import { ToolRegistry } from "./tool-registry.js";
import type { ReceiptJournal } from "./receipt-journal.js";

interface CachedReceipt {
  intentDigest: string;
  receipt: EffectReceiptV1;
}

export class LocalActionRuntime implements EffectPort {
  private readonly ledger = new EffectLedger();
  private readonly receipts = new Map<string, CachedReceipt>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: PolicyEngine,
    private readonly approval: ApprovalPort,
    private readonly now: () => Date = () => new Date(),
    private readonly journal?: ReceiptJournal,
  ) {}

  toolSpecs() {
    return this.registry.specs();
  }

  ledgerSnapshot(): EffectLedgerSnapshot {
    return this.ledger.snapshot();
  }

  /**
   * Receipts durable across restarts (only when a journal is injected). Crash
   * recovery reads these to audit which actions already produced a receipt;
   * the in-process idempotency cache above is intentionally not rebuilt from
   * them (fresh actionIds mean there is nothing to dedup after a restart).
   */
  journalReceipts(): Promise<EffectReceiptV1[]> {
    return this.journal ? this.journal.load() : Promise.resolve([]);
  }

  async submit(
    intents: ActionIntentV1[],
    context: EffectContextV1,
    signal?: AbortSignal,
  ): Promise<EffectReceiptV1[]> {
    const receipts: EffectReceiptV1[] = [];
    for (const intent of intents) receipts.push(await this.executeOne(intent, context, signal));
    return receipts;
  }

  private async executeOne(
    intent: ActionIntentV1,
    context: EffectContextV1,
    signal?: AbortSignal,
  ): Promise<EffectReceiptV1> {
    assertSchema(ActionIntentSchema, intent, "action intent");
    if (intent.taskId !== context.execution.taskId) {
      throw new Error(`Action ${intent.actionId} targets a different task`);
    }
    const intentDigest = sha256Digest(intent);
    const cached = this.receipts.get(intent.actionId);
    if (cached) {
      if (cached.intentDigest !== intentDigest) {
        throw new Error(`Action id ${intent.actionId} was reused with different content`);
      }
      return cached.receipt;
    }
    const tool = this.registry.get(intent.tool.id);
    if (!tool) return this.cache(intentDigest, this.rejected(intent, "Unknown tool"));
    if (
      tool.spec.version !== intent.tool.version ||
      tool.spec.schemaDigest !== intent.tool.schemaDigest
    ) {
      return this.cache(
        intentDigest,
        this.rejected(intent, "Tool version or schema digest changed"),
      );
    }
    const projectedRisk = this.ledger.projectedRisk(intent);
    const decision = this.policy.evaluate(intent, tool.spec, this.ledger.snapshot(), projectedRisk);
    if (decision.disposition === "deny") {
      return this.cache(intentDigest, this.rejected(intent, decision.reason));
    }
    if (decision.disposition === "approval_required") {
      const approved = await this.approval.request({
        intent,
        tool: tool.spec,
        reason: decision.reason,
        currentLedger: this.ledger.snapshot(),
        projectedRiskScore: decision.riskScore,
      });
      if (!approved) return this.cache(intentDigest, this.rejected(intent, "Denied by user"));
    }

    const grantId = newId("grant");
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    const grant: CapabilityGrantV1 = {
      schemaVersion: "capability-grant.v1" as const,
      grantId,
      taskId: intent.taskId,
      subject: {
        taskId: intent.taskId,
        workerId: context.workerId,
        modelCertificateId: context.model.certificateId,
      },
      capabilities: tool.spec.requiredCapabilities.map((name) => ({ name })),
      constraints: [
        { kind: "tool.schema_digest", value: tool.spec.schemaDigest },
        { kind: "expires_at", value: expiresAt },
      ],
      expiresAt,
      fencingToken: newId("fence"),
      policySnapshotDigest: context.execution.policySnapshot,
    };

    try {
      const result = await tool.execute(intent.arguments, signal);
      const receipt: EffectReceiptV1 = {
        schemaVersion: "effect-receipt.v1",
        actionId: intent.actionId,
        grantId,
        grant,
        status: "applied",
        observedEffects: result.observedEffects,
        artifacts: result.artifacts,
        ...(result.before ? { before: result.before } : {}),
        ...(result.after ? { after: result.after } : {}),
        reconciliation: "matched",
        message: JSON.stringify(result.output),
      };
      this.ledger.record(receipt);
      return this.cache(intentDigest, receipt);
    } catch (error) {
      return this.cache(
        intentDigest,
        this.rejected(intent, error instanceof Error ? error.message : String(error), grant),
      );
    }
  }

  private rejected(
    intent: ActionIntentV1,
    message: string,
    grant?: CapabilityGrantV1,
  ): EffectReceiptV1 {
    return {
      schemaVersion: "effect-receipt.v1",
      actionId: intent.actionId,
      grantId: grant?.grantId ?? newId("denied"),
      ...(grant ? { grant } : {}),
      status: "rejected",
      observedEffects: [],
      artifacts: [],
      reconciliation: "matched",
      message,
    };
  }

  /**
   * Cache a receipt after durably journaling it (receipt-before-result). The
   * journal append is best-effort: a failed append cannot undo a side effect
   * that already ran, so we surface a warning rather than mis-report the tool
   * as not executed. Full fail-closed UNKNOWN reconciliation is deferred.
   */
  private async cache(intentDigest: string, receipt: EffectReceiptV1): Promise<EffectReceiptV1> {
    if (this.journal) {
      try {
        await this.journal.append(receipt);
      } catch (error) {
        process.stderr.write(
          `Warning: receipt journal append failed (effect may be unreconciled): ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
    this.receipts.set(receipt.actionId, { intentDigest, receipt });
    return receipt;
  }
}
