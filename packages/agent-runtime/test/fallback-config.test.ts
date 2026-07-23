import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { resolveAgentConfig } from "../src/index.js";

describe("fallbackModels config resolution", () => {
  it("parses declared fallbackModels into ModelProfile[]", async () => {
    const root = await createTestDirectory("fallback-parse");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "primary",
        fallbackModels: [{ provider: "openrouter", model: "secondary" }],
      }),
    );
    const config = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    expect(config.fallbackModels).toHaveLength(1);
    const fallback = config.fallbackModels[0]!;
    expect(fallback.provider).toBe("openrouter");
    expect(fallback.model).toBe("secondary");
    expect(fallback.protocol).toBe("openai-chat");
    expect(fallback.baseUrl).toBe("https://openrouter.ai/api/v1");
    // Resolved ModelProfile must carry the resolved reliability/compatibility
    // objects — not undefined — so downstream ModelClient construction works.
    expect(fallback.reliability).toEqual(expect.objectContaining({ maxRetries: 2 }));
    expect(fallback.compatibility).toEqual(expect.objectContaining({ thinkingFormat: "openai" }));
  });

  it("resolves multiple fallback models preserving order", async () => {
    const root = await createTestDirectory("fallback-order");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "primary",
        fallbackModels: [
          { provider: "openrouter", model: "secondary-a" },
          { provider: "groq", model: "secondary-b" },
        ],
      }),
    );
    const config = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    expect(config.fallbackModels.map((m) => `${m.provider}/${m.model}`)).toEqual([
      "openrouter/secondary-a",
      "groq/secondary-b",
    ]);
  });

  it("defaults fallbackModels to an empty array when not declared", async () => {
    const root = await createTestDirectory("fallback-default");
    const config = await resolveAgentConfig(root, {
      provider: "ollama",
      model: "x",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(config.fallbackModels).toEqual([]);
  });

  it("returns a defensive copy so callers cannot mutate the resolved chain", async () => {
    const root = await createTestDirectory("fallback-copy");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "primary",
        fallbackModels: [{ provider: "openrouter", model: "secondary" }],
      }),
    );
    const config = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    config.fallbackModels[0]!.model = "mutated";
    // The resolved config is a fresh object graph, so re-resolving from the
    // same source file must still observe the original model id.
    const config2 = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    expect(config2.fallbackModels[0]!.model).toBe("secondary");
  });

  it("rejects a non-array fallbackModels", async () => {
    const root = await createTestDirectory("fallback-not-array");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        fallbackModels: "not-an-array",
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/fallbackModels must be an array/);
  });

  it("rejects a fallback entry that is not an object", async () => {
    const root = await createTestDirectory("fallback-non-object");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        fallbackModels: ["not-an-object"],
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/fallbackModels\[0\] must be an object/);
  });

  it("rejects a fallback entry missing the provider field", async () => {
    const root = await createTestDirectory("fallback-missing-provider");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        fallbackModels: [{ model: "secondary" }],
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/fallbackModels\[0\]\.provider must be a non-empty string/);
  });

  it("rejects a fallback entry with an empty model id", async () => {
    const root = await createTestDirectory("fallback-empty-model");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        fallbackModels: [{ provider: "openrouter", model: "" }],
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/fallbackModels\[0\]\.model must be a non-empty string/);
  });

  it("enforces enterprise allowedProviders on fallback models", async () => {
    const root = await createTestDirectory("fallback-enterprise");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "primary",
        sandbox: { kind: "docker", image: "node:22-bookworm", requireImageDigest: false },
        enterprise: {
          enabled: true,
          allowedProviders: ["ollama"],
        },
        fallbackModels: [{ provider: "openrouter", model: "secondary" }],
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/Enterprise policy denies provider openrouter/);
  });
});
