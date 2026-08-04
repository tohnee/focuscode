import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  CacheEpochManifestSchema,
  type CacheEpochManifestV1,
} from "../src/schemas.js";

describe("CacheEpochManifestV1", () => {
  const manifest: CacheEpochManifestV1 = {
    schemaVersion: "cache-epoch.v1",
    modelRevision: "kimi-k3-2026-06-15",
    chatTemplateHash: "a1b2",
    toolBundleHash: "c3d4",
    systemHash: "e5f6",
    reasoningProtocol: "openai",
    toolProtocol: "openai-chat",
    cacheMode: "openai-prefix",
  };

  it("validates a well-formed manifest", () => {
    expect(Value.Check(CacheEpochManifestSchema, manifest)).toBe(true);
  });

  it("accepts optional protocol fields omitted", () => {
    const minimal = {
      schemaVersion: "cache-epoch.v1",
      modelRevision: "m",
      toolBundleHash: "x",
      systemHash: "y",
    };
    expect(Value.Check(CacheEpochManifestSchema, minimal)).toBe(true);
  });

  it("rejects a missing toolBundleHash", () => {
    expect(
      Value.Check(CacheEpochManifestSchema, {
        schemaVersion: "cache-epoch.v1",
        modelRevision: "m",
        systemHash: "y",
      }),
    ).toBe(false);
  });
});
