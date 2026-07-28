import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { createCodingAgent } from "../src/index.js";

/**
 * TDD RED→GREEN for P1-5: OAuth access token provider via SDK.
 *
 * Covers the previously-untested `accessTokenProvider` injection point on
 * `createCodingAgent`. The provider is invoked lazily on each model request
 * by `resolveCredential` in `model-clients.ts`; it is NOT called during
 * `CodingAgent.create()`. These tests exercise the contract through the SDK
 * composition root without depending on a real OAuth server.
 */
describe("createCodingAgent accessTokenProvider", () => {
  it("invokes the access token provider lazily on submit, not on create", async () => {
    const repoRoot = await createTestDirectory("sdk-oauth-lazy");
    let calls = 0;
    const created = await createCodingAgent({
      cwd: repoRoot,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      authType: "bearer",
      accessTokenProvider: async () => {
        calls++;
        return "test-token";
      },
    });

    // Provider must NOT be called during construction.
    expect(calls).toBe(0);
    expect(created.agent).toBeDefined();

    // submit() triggers a model request which calls the provider; the request
    // itself fails because the baseUrl is unreachable, but the provider runs.
    await expect(created.agent.submit("hi")).rejects.toThrow();
    expect(calls).toBeGreaterThan(0);
  });

  it("propagates access token provider errors through submit", async () => {
    const repoRoot = await createTestDirectory("sdk-oauth-error");
    const created = await createCodingAgent({
      cwd: repoRoot,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      authType: "bearer",
      accessTokenProvider: async () => {
        throw new Error("OAuth refresh failed");
      },
    });

    await expect(created.agent.submit("hi")).rejects.toThrow(/OAuth refresh failed/);
  });

  it("does not invoke the provider when authType is none", async () => {
    const repoRoot = await createTestDirectory("sdk-oauth-none");
    let calls = 0;
    const created = await createCodingAgent({
      cwd: repoRoot,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      authType: "none",
      accessTokenProvider: async () => {
        calls++;
        return "should-not-be-used";
      },
    });

    expect(calls).toBe(0);
    await expect(created.agent.submit("hi")).rejects.toThrow();
    // authType=none short-circuits in resolveCredential before calling provider
    expect(calls).toBe(0);
  });
});
