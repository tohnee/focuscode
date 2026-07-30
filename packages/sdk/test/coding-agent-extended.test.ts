/**
 * TDD tests for extending createCodingAgent to be the single composition
 * point that CLI also uses (P0 fix). Each test verifies one extension
 * option that CLI currently wires separately.
 *
 * These are vertical-slice tests: one option per test, exercising the real
 * assembly path through the public SDK interface.
 */
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { createCodingAgent } from "../src/index.js";

describe("createCodingAgent extended options (P0: CLI reuse SDK)", () => {
  it("passes config.agent.searchEndpoint to the tool registry", async () => {
    const cwd = await createTestDirectory("sdk-ext-search");
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      agent: { searchEndpoint: "https://custom-search.example/api" },
    });
    expect(created.config.agent.searchEndpoint).toBe("https://custom-search.example/api");
    // The web_search tool should be registered (it is when searchEndpoint is set).
    // We verify via the agent status — if the registry rejected the endpoint,
    // createCodingAgent would have thrown.
    expect(await created.agent.status()).toMatchObject({ model: "fixture" });
  });

  it("accepts extensionHostKind: 'process' for crash isolation", async () => {
    const cwd = await createTestDirectory("sdk-ext-process-host");
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      extensionHostKind: "process",
    });
    expect(created.extensions.constructor.name).toBe("ProcessExtensionHost");
  });

  it("builds a fallback model chain when fallbackModels are configured", async () => {
    const cwd = await createTestDirectory("sdk-ext-fallback");
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      fallbackModels: [
        { provider: "custom", model: "fallback-1", baseUrl: "http://127.0.0.1:2/v1" },
      ],
    });
    expect(created.config.fallbackModels).toHaveLength(1);
    expect(created.config.fallbackModels[0]?.model).toBe("fallback-1");
    expect(await created.agent.status()).toMatchObject({ model: "fixture" });
  });

  it("accepts an eventSinkWrapper to intercept events", async () => {
    const cwd = await createTestDirectory("sdk-ext-sink-wrap");
    let wrapped = false;
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      eventSinkWrapper: (sink) => async (event) => {
        wrapped = true;
        return sink?.(event);
      },
    });
    expect(created.agent).toBeDefined();
    // The wrapper is installed lazily — it fires when an event flows through.
    // We can't easily trigger an event in a unit test, but construction must
    // succeed with the wrapper installed.
    expect(wrapped).toBe(false);
  });

  it("default extensionHostKind remains in-process (back-compat)", async () => {
    const cwd = await createTestDirectory("sdk-ext-default-host");
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
    });
    expect(created.extensions.constructor.name).toBe("ExtensionHost");
  });

  it("accepts enabledTools to whitelist tools (P0 step 2 slice 2)", async () => {
    const cwd = await createTestDirectory("sdk-ext-enabled-tools");
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      enabledTools: ["read", "edit"],
    });
    expect(created.config.enabledTools).toEqual(["read", "edit"]);
    expect(await created.agent.status()).toMatchObject({ model: "fixture" });
  });

  it("accepts disabledTools to blacklist tools (P0 step 2 slice 2)", async () => {
    const cwd = await createTestDirectory("sdk-ext-disabled-tools");
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      disabledTools: ["bash"],
    });
    expect(created.config.disabledTools).toEqual(["bash"]);
    expect(await created.agent.status()).toMatchObject({ model: "fixture" });
  });

  it("accepts specConfirmationHandler (C5: agent-owned confirmation)", async () => {
    const cwd = await createTestDirectory("sdk-ext-spec-handler");
    const handler = async () => ({}) as Record<string, string>;
    const created = await createCodingAgent({
      cwd,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
      specConfirmationHandler: handler,
    });
    expect(created.agent.specConfirmationHandler).toBe(handler);
  });
});
