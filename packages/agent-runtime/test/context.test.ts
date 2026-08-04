import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../src/index.js";
import {
  ConversationContext,
  economicCompactionSignal,
  type CompactionEconomics,
  type SessionEntry,
  type SessionSnapshot,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost/v1",
  contextWindow: 4_096,
  maxOutputTokens: 512,
  temperature: 0,
  toolMode: "auto",
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 300_000,
    maxRetries: 0,
    retryBaseDelayMs: 500,
    retryMaximumDelayMs: 10_000,
  },
};

const now = "2026-08-01T00:00:00.000Z";

function entries(count: number, content = "x".repeat(800)): SessionEntry[] {
  const result: SessionEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push({
      entryId: `entry_${index}`,
      parentId: index > 0 ? `entry_${index - 1}` : undefined,
      createdAt: now,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index} ${content}`,
      },
    });
  }
  return result;
}

function snapshot(branch: SessionEntry[]): SessionSnapshot {
  return {
    header: {
      schemaVersion: "focuscode-session.v1",
      sessionId: "sess_context_test",
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
      model: { provider: "fixture", model: "fixture-model", protocol: "openai-chat" },
    },
    entries: branch,
    activeLeafId: branch[branch.length - 1]?.entryId,
  };
}

describe("economicCompactionSignal", () => {
  it("returns false below the 60% pressure floor", () => {
    const economics: CompactionEconomics = {
      missPricePerM: 15,
      hitPricePerM: 1.5,
      expectedRemainingTurns: 20,
    };
    expect(
      economicCompactionSignal({
        estimatedTokens: 6_000,
        usable: 10_000,
        branchLength: 10,
        compactableTokens: 8_000,
        economics,
      }),
    ).toBe(false);
  });

  it("returns false when the branch is too short", () => {
    const economics: CompactionEconomics = {
      missPricePerM: 15,
      hitPricePerM: 1.5,
      expectedRemainingTurns: 20,
    };
    expect(
      economicCompactionSignal({
        estimatedTokens: 8_000,
        usable: 10_000,
        branchLength: 6,
        compactableTokens: 8_000,
        economics,
      }),
    ).toBe(false);
  });

  it("returns true when the cache-price gap and remaining turns make early compaction clearly profitable", () => {
    const economics: CompactionEconomics = {
      missPricePerM: 15,
      hitPricePerM: 1.5,
      expectedRemainingTurns: 20,
    };
    expect(
      economicCompactionSignal({
        estimatedTokens: 70_000,
        usable: 100_000,
        branchLength: 20,
        compactableTokens: 50_000,
        economics,
      }),
    ).toBe(true);
  });

  it("returns false when hits are almost as expensive as misses with a single remaining turn", () => {
    const economics: CompactionEconomics = {
      missPricePerM: 15,
      hitPricePerM: 14,
      expectedRemainingTurns: 1,
    };
    expect(
      economicCompactionSignal({
        estimatedTokens: 70_000,
        usable: 100_000,
        branchLength: 20,
        compactableTokens: 50_000,
        economics,
      }),
    ).toBe(false);
  });

  it("defaults to a fixed summary price and risk margin when unset", () => {
    const economics: CompactionEconomics = {
      missPricePerM: 15,
      expectedRemainingTurns: 20,
    };
    // Same inputs as the profitable case above; defaults (outputPricePerM,
    // riskMargin) must not change the outcome direction.
    expect(
      economicCompactionSignal({
        estimatedTokens: 70_000,
        usable: 100_000,
        branchLength: 20,
        compactableTokens: 50_000,
        economics,
      }),
    ).toBe(true);
  });
});

describe("ConversationContext economic compaction", () => {
  it("compacts earlier when economics show a large cache-price gap and many turns remain", () => {
    const branch = entries(12);
    const snap = snapshot(branch);
    const usable = model.contextWindow - model.maxOutputTokens;
    const plain = new ConversationContext(model).compile(snap);
    // Fixture must land above the 60% economic floor but below the 82% pressure point.
    expect(plain.estimatedTokens).toBeGreaterThan(usable * 0.6);
    expect(plain.estimatedTokens).toBeLessThanOrEqual(usable * 0.82);
    expect(plain.shouldCompact).toBe(false);

    const economics: CompactionEconomics = {
      missPricePerM: 15,
      hitPricePerM: 1.5,
      expectedRemainingTurns: 10,
    };
    const compiled = new ConversationContext(model, economics).compile(snap);
    expect(compiled.shouldCompact).toBe(true);
    expect(compiled.compactableEntries.length).toBeGreaterThan(0);
  });

  it("does not early-compact a tiny context even with generous economics", () => {
    const branch = entries(10);
    const snap = snapshot(branch);
    const economics: CompactionEconomics = {
      missPricePerM: 15,
      hitPricePerM: 1.5,
      expectedRemainingTurns: 20,
    };
    const compiled = new ConversationContext(model, economics).compile(snap);
    const usable = model.contextWindow - model.maxOutputTokens;
    expect(compiled.estimatedTokens).toBeLessThanOrEqual(usable * 0.6);
    expect(compiled.shouldCompact).toBe(false);
  });

  it("keeps pressure-only behavior when no economics are provided", () => {
    const context = new ConversationContext(model);
    // Below the 82% pressure point: no compaction.
    expect(context.compile(snapshot(entries(12))).shouldCompact).toBe(false);
    // Above the 82% pressure point: pressure fires exactly as before.
    expect(context.compile(snapshot(entries(14)), 1_000).shouldCompact).toBe(true);
  });
});
