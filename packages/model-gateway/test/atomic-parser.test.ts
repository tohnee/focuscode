import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ModelPackV1 } from "@focuscode/contracts";
import { AtomicDecisionParser } from "../src/index.js";

const pack: ModelPackV1 = {
  schemaVersion: "model-pack.v1",
  id: "test-pack",
  family: "fixture",
  revision: "1",
  systemPrompt: "fixture",
  responseFormat: "json",
  maxToolIntentsPerTurn: 2,
  contextEnvelope: { maxInputChars: 10_000, stablePrefixRatio: 0.5, maxToolOutputChars: 1_000 },
  recovery: { deterministicRepair: true, modelRetries: 0 },
};

const response = JSON.stringify({
  kind: "completion_candidate",
  summary: "done",
  evidence: [],
  residualRisks: [],
});

describe("AtomicDecisionParser", () => {
  it("is invariant to arbitrary stream chunk boundaries", () => {
    const parser = new AtomicDecisionParser(pack);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 40 }),
        (sizes) => {
          const chunks: string[] = [];
          let offset = 0;
          for (const size of sizes) {
            if (offset >= response.length) break;
            chunks.push(response.slice(offset, offset + size));
            offset += size;
          }
          if (offset < response.length) chunks.push(response.slice(offset));
          const parsed = parser.parse({ chunks, finishReason: "stop" });
          expect(parsed.status).toBe("complete");
          expect(parsed.decision).toEqual(JSON.parse(response));
        },
      ),
    );
  });

  it("rejects a truncated turn before exposing a decision", () => {
    const parsed = new AtomicDecisionParser(pack).parse({
      chunks: [response.slice(0, 10)],
      finishReason: "length",
    });
    expect(parsed.status).toBe("truncated");
    expect(parsed.decision).toBeUndefined();
  });

  it("performs one deterministic fence repair but still validates the schema", () => {
    const parser = new AtomicDecisionParser(pack);
    expect(
      parser.parse({ chunks: [`\`\`\`json\n${response}\n\`\`\``], finishReason: "stop" }).status,
    ).toBe("complete");
    expect(parser.parse({ chunks: ['{"kind":"unknown"}'], finishReason: "stop" }).status).toBe(
      "invalid",
    );
  });
});
