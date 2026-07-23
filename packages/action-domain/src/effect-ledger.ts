import type { ActionIntentV1, EffectReceiptV1 } from "@focuscode/contracts";

export interface EffectLedgerSnapshot {
  changedFiles: string[];
  changedLines: number;
  commands: number;
  networkRequests: number;
  secretUses: number;
  riskScore: number;
  actionIds: string[];
}

export class EffectLedger {
  private readonly changedFiles = new Set<string>();
  private readonly actionIds = new Set<string>();
  private changedLines = 0;
  private commands = 0;
  private networkRequests = 0;
  private secretUses = 0;
  private riskScore = 0;

  hasAction(actionId: string): boolean {
    return this.actionIds.has(actionId);
  }

  projectedRisk(intent: ActionIntentV1): number {
    const delta = intent.expectedEffects.reduce((score, effect) => {
      switch (effect.class) {
        case "read":
          return score;
        case "file_write":
          return score + 2;
        case "command":
          return score + 3;
        case "git":
          return score + 5;
        case "network":
        case "secret":
          return score + 10;
        case "delegation":
          return score + 4;
      }
    }, 0);
    return this.riskScore + delta;
  }

  record(receipt: EffectReceiptV1): void {
    if (this.actionIds.has(receipt.actionId)) return;
    this.actionIds.add(receipt.actionId);
    for (const effect of receipt.observedEffects) {
      const detail =
        effect.detail && typeof effect.detail === "object"
          ? (effect.detail as Record<string, unknown>)
          : {};
      switch (effect.class) {
        case "file_write":
          if (effect.resource) this.changedFiles.add(effect.resource);
          this.changedLines += numberOrZero(detail.changedLines);
          this.riskScore += 2;
          break;
        case "command":
          this.commands += 1;
          this.riskScore += 3;
          break;
        case "network":
          this.networkRequests += 1;
          this.riskScore += 10;
          break;
        case "secret":
          this.secretUses += 1;
          this.riskScore += 10;
          break;
        case "git":
          this.riskScore += 5;
          break;
        case "delegation":
          this.riskScore += 4;
          break;
      }
    }
  }

  snapshot(): EffectLedgerSnapshot {
    return {
      changedFiles: [...this.changedFiles].sort(),
      changedLines: this.changedLines,
      commands: this.commands,
      networkRequests: this.networkRequests,
      secretUses: this.secretUses,
      riskScore: this.riskScore,
      actionIds: [...this.actionIds].sort(),
    };
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
