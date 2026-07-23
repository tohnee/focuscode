import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPackBinding, createDevelopmentModelRef, loadModelPack } from "../src/index.js";

// Ablation pair: the DeepSeek family pack must stay a strict, deliberate
// deviation from the generic OpenAI-compatible baseline — same canonical JSON
// decision contract, different family tuning. If either side drifts (same
// digest, same envelope, same family string), the comparison is no longer
// attributable and this test fails.
describe("generic-vs-specific Model Pack ablation", () => {
  it("loads the ablation pair with distinct digests and family tuning", async () => {
    const generic = await loadModelPack(resolve("model-packs/generic-openai/pack.json"));
    const specific = await loadModelPack(resolve("model-packs/deepseek-specific/pack.json"));

    // Same declarative contract and response format.
    expect(specific.pack.schemaVersion).toBe("model-pack.v1");
    expect(specific.pack.responseFormat).toBe(generic.pack.responseFormat);
    expect(specific.pack.recovery).toEqual(generic.pack.recovery);

    // Distinct identity: id, family, and content digest must all differ.
    expect(specific.pack.id).not.toBe(generic.pack.id);
    expect(specific.pack.family).toBe("deepseek");
    expect(generic.pack.family).toBe("openai-compatible");
    expect(specific.digest).not.toBe(generic.digest);

    // Family-specific tuning: the envelopes must actually diverge.
    expect(specific.pack.contextEnvelope).not.toEqual(generic.pack.contextEnvelope);
    expect(specific.pack.maxToolIntentsPerTurn).not.toBe(generic.pack.maxToolIntentsPerTurn);
    expect(specific.pack.systemPrompt).not.toBe(generic.pack.systemPrompt);
    expect(specific.pack.systemPrompt).toContain("reasoning_content");
  });

  it("binds development certificates to their own pack only", async () => {
    const generic = await loadModelPack(resolve("model-packs/generic-openai/pack.json"));
    const specific = await loadModelPack(resolve("model-packs/deepseek-specific/pack.json"));
    const genericRef = createDevelopmentModelRef(generic, "fixture-model");
    const specificRef = createDevelopmentModelRef(specific, "deepseek-v4-pro");

    expect(() => assertPackBinding(generic, genericRef)).not.toThrow();
    expect(() => assertPackBinding(specific, specificRef)).not.toThrow();
    // Cross-binding must fail: a certificate is bound to exactly one pack digest.
    expect(() => assertPackBinding(generic, specificRef)).toThrow(/bound to/);
    expect(() => assertPackBinding(specific, genericRef)).toThrow(/bound to/);
  });
});
