import { describe, expect, it } from "vitest";
import {
  CertifiedModelRefSchema,
  TaskSpecSchema,
  assertSchema,
  normalizeRelativePath,
  sha256Digest,
  stableStringify,
} from "../src/index.js";

describe("canonical contracts", () => {
  it("accepts a valid TaskSpec and rejects provider-shaped surplus fields", () => {
    const task: unknown = {
      schemaVersion: "task-spec.v1",
      repoId: "repo",
      baseRef: "HEAD",
      mode: "change",
      objective: "Fix the bug",
      acceptanceCriteria: [{ id: "tests", description: "Tests pass" }],
    };
    expect(() => assertSchema(TaskSpecSchema, task)).not.toThrow();
    expect(() => assertSchema(TaskSpecSchema, { ...task, providerSessionId: "opaque" })).toThrow(
      /canonical schema/,
    );
  });

  it("produces stable digests independent of object insertion order", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(sha256Digest({ b: 2, a: 1 })).toBe(sha256Digest({ a: 1, b: 2 }));
  });

  it("collapses dot segments so path variants cannot disguise a protected target", () => {
    expect(normalizeRelativePath("src/../.env")).toBe(".env");
    expect(normalizeRelativePath("src/./foo.ts")).toBe("src/foo.ts");
    expect(normalizeRelativePath("./src//foo.ts")).toBe("src/foo.ts");
    expect(normalizeRelativePath("src\\..\\.env")).toBe(".env");
    expect(normalizeRelativePath("a/b/")).toBe("a/b");
    expect(normalizeRelativePath("a/../../b")).toBe("../b");
    expect(normalizeRelativePath("../outside")).toBe("../outside");
    expect(normalizeRelativePath("/abs/../x")).toBe("/x");
    expect(normalizeRelativePath("")).toBe("");
  });

  it("accepts an optional certificate expiresAt and stays backward compatible", () => {
    const digest = sha256Digest("fixture");
    const certificate: unknown = {
      modelId: "scripted-model",
      modelRevision: digest,
      tokenizer: digest,
      chatTemplate: digest,
      modelPack: digest,
      deploymentProfile: digest,
      certificateId: "fixture-certificate",
      certifiedCapabilities: ["explore"],
      riskLevel: "sandbox-only",
    };
    // Certificates issued before the field existed must still validate.
    expect(() => assertSchema(CertifiedModelRefSchema, certificate)).not.toThrow();
    expect(() =>
      assertSchema(CertifiedModelRefSchema, {
        ...certificate,
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertSchema(CertifiedModelRefSchema, { ...certificate, expiresAt: "next-tuesday" }),
    ).toThrow(/canonical schema/);
    // Strict shape still rejects provider-shaped surplus fields.
    expect(() =>
      assertSchema(CertifiedModelRefSchema, { ...certificate, providerSessionId: "opaque" }),
    ).toThrow(/canonical schema/);
  });
});
