import { readFile } from "node:fs/promises";
import { sha256Digest, type CertifiedModelRefV1, type ModelPackV1 } from "@focuscode/contracts";

export interface LoadedModelPack {
  pack: ModelPackV1;
  digest: `sha256:${string}`;
  sourcePath: string;
}

export async function loadModelPack(path: string): Promise<LoadedModelPack> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertModelPack(value);
  return { pack: value, digest: sha256Digest(value), sourcePath: path };
}

export function assertModelPack(value: unknown): asserts value is ModelPackV1 {
  if (!value || typeof value !== "object") throw new Error("Model Pack must be an object");
  const pack = value as Record<string, unknown>;
  if (pack.schemaVersion !== "model-pack.v1") throw new Error("Unsupported Model Pack version");
  for (const key of ["id", "family", "revision", "systemPrompt"] as const) {
    if (typeof pack[key] !== "string" || pack[key].length === 0) {
      throw new Error(`Model Pack ${key} must be a non-empty string`);
    }
  }
  if (pack.responseFormat !== "json") throw new Error("Alpha Model Packs must use JSON decisions");
  if (!pack.contextEnvelope || typeof pack.contextEnvelope !== "object") {
    throw new Error("Model Pack contextEnvelope is required");
  }
  if (!pack.recovery || typeof pack.recovery !== "object") {
    throw new Error("Model Pack recovery policy is required");
  }
}

export function createDevelopmentModelRef(
  loaded: LoadedModelPack,
  modelId: string,
): CertifiedModelRefV1 {
  return {
    modelId,
    modelRevision: sha256Digest({ modelId, revision: "operator-selected" }),
    tokenizer: sha256Digest({ modelId, tokenizer: "operator-selected" }),
    chatTemplate: sha256Digest({ pack: loaded.pack.id, template: "json-decision.v1" }),
    modelPack: loaded.digest,
    deploymentProfile: sha256Digest({ transport: "openai-compatible", modelId }),
    certificateId: `dev-sandbox:${loaded.pack.id}:${modelId}`,
    certifiedCapabilities: ["explore", "change", "json_decision"],
    riskLevel: "sandbox-only",
  };
}

export function assertPackBinding(loaded: LoadedModelPack, model: CertifiedModelRefV1): void {
  if (loaded.digest !== model.modelPack) {
    throw new Error(
      `Model certificate is bound to ${model.modelPack}, but the loaded Pack is ${loaded.digest}`,
    );
  }
}
