import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  AgentToolRegistry,
  ExtensionHost,
  expandFileMentions,
  expandPromptTemplate,
  listProviderPresets,
  loadAgentResources,
  renderResourcePrompt,
  resolveAgentConfig,
} from "../src/index.js";

describe("configuration and resources", () => {
  it("merges trusted project configuration over global defaults", async () => {
    const root = await createTestDirectory("agent-config");
    const global = join(root, "global.json");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      global,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "global-model",
        approval: "deny",
        contextWindow: 8_000,
      }),
    );
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        model: "project-model",
        approval: "auto-edit",
        disabledTools: ["bash"],
      }),
    );
    const config = await resolveAgentConfig(root, {
      globalConfigPath: global,
      projectConfigPath: project,
      projectTrusted: true,
    });
    expect(config.model).toMatchObject({ provider: "ollama", model: "project-model" });
    expect(config.approval).toBe("auto-edit");
    expect(config.disabledTools).toEqual(["bash"]);
    expect(listProviderPresets().map((item) => item.id)).toContain("deepseek");
    expect(listProviderPresets().map((item) => item.id)).toEqual(
      expect.arrayContaining(["kimi", "qwen", "glm", "deepseek", "minimax"]),
    );

    const custom = await resolveAgentConfig(root, {
      provider: "private-local",
      model: "custom-model",
      globalConfigPath: join(root, "missing-global.json"),
      projectConfigPath: join(root, "missing-project.json"),
      providers: {
        "private-local": {
          protocol: "openai-chat",
          baseUrl: "http://127.0.0.1:9999/v1",
          defaultContextWindow: 32_000,
          defaultMaxOutputTokens: 2_000,
        },
      },
    });
    expect(custom.model).toMatchObject({
      provider: "private-local",
      baseUrl: "http://127.0.0.1:9999/v1",
      contextWindow: 32_000,
    });
    expect(custom.sandbox).toMatchObject({
      kind: "auto",
      network: "none",
      allowHostFallback: false,
    });
  });

  it("ships native profiles for the five requested open-model providers", async () => {
    const root = await createTestDirectory("agent-provider-profiles");
    const cases = [
      ["kimi", "kimi-k3", "openai", "openai-chat"],
      ["qwen", "qwen3-coder-plus", "qwen", "openai-chat"],
      ["glm", "glm-5.2", "zai", "openai-chat"],
      ["deepseek", "deepseek-v4-pro", "deepseek", "openai-chat"],
      ["minimax", "MiniMax-M3", "openai", "anthropic-messages"],
    ] as const;
    for (const [provider, model, thinkingFormat, protocol] of cases) {
      const config = await resolveAgentConfig(root, {
        provider,
        apiKey: "fixture-key",
        globalConfigPath: join(root, "missing.json"),
        projectConfigPath: join(root, "missing-project.json"),
      });
      expect(config.model).toMatchObject({ provider, model, protocol });
      expect(config.model.compatibility.thinkingFormat).toBe(thinkingFormat);
      expect(config.model.reliability.maxRetries).toBe(2);
    }
    const minimax = await resolveAgentConfig(root, {
      provider: "minimax",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(minimax.model.compatibility.anthropicThinking).toBe("adaptive");
    const vision = await resolveAgentConfig(root, {
      provider: "qwen",
      model: "qwen-vl-max",
      apiKey: "fixture-key",
      models: {
        "qwen/qwen-vl-max": {
          capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
          maxOutputTokens: 32_000,
          reliability: { maxRetries: 4 },
        },
      },
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(vision.model.capabilities.input).toContain("image");
    expect(vision.model.maxOutputTokens).toBe(32_000);
    expect(vision.model.reliability.maxRetries).toBe(4);
  });

  it("declares Kimi prompt_cache_key as the provider cache key field", async () => {
    const root = await createTestDirectory("kimi-prompt-cache-key");
    const config = await resolveAgentConfig(root, {
      provider: "kimi",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(config.model.compatibility.cacheControl).toMatchObject({
      mode: "openai-prefix",
      minPrefixTokens: 1024,
      promptCacheKeyField: "prompt_cache_key",
    });
    const cn = await resolveAgentConfig(root, {
      provider: "kimi-cn",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(cn.model.compatibility.cacheControl?.promptCacheKeyField).toBe("prompt_cache_key");
  });

  it("enforces enterprise provider, model, media, extension and sandbox boundaries", async () => {
    const root = await createTestDirectory("agent-enterprise-policy");
    const base = {
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
      enterprise: {
        enabled: true,
        allowedProviders: ["deepseek"],
        allowedModels: ["deepseek/deepseek-chat"],
      },
      sandbox: {
        kind: "docker" as const,
        image: "focuscode/sandbox@sha256:" + "a".repeat(64),
        allowHostFallback: false,
      },
    };
    const config = await resolveAgentConfig(root, base);
    expect(config.enterprise.enabled).toBe(true);
    expect(config.media.allowRemoteImages).toBe(false);
    expect(config.extensions.host).toBe("process");
    await expect(resolveAgentConfig(root, { ...base, provider: "qwen" })).rejects.toThrow(
      "denies provider",
    );
    await expect(resolveAgentConfig(root, { ...base, sandbox: { kind: "host" } })).rejects.toThrow(
      "isolated sandbox",
    );
    await expect(
      resolveAgentConfig(root, { ...base, media: { allowRemoteImages: true } }),
    ).rejects.toThrow("remote image");
    await expect(
      resolveAgentConfig(root, { ...base, requireExtensionSignatures: false }),
    ).rejects.toThrow("signed extension");
    await expect(
      resolveAgentConfig(root, { ...base, extensions: { host: "in-process" } }),
    ).rejects.toThrow("process extension host");
  });

  it("pins revisions via enterprise allowlists and resolves fingerprint policy", async () => {
    const root = await createTestDirectory("agent-revision-pin");
    const base = {
      provider: "deepseek",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    };
    // Built-in presets ship a default revision for the five provider families.
    const resolved = await resolveAgentConfig(root, base);
    expect(resolved.model.revision).toBe("deepseek-v4-pro-2026-06-15");
    expect(resolved.model.reliability).toMatchObject({
      maxRetries: 2,
      circuitThreshold: 5,
      circuitCooldownMs: 30_000,
      maxConcurrency: 8,
    });

    const sandbox = {
      kind: "docker" as const,
      image: "focuscode/sandbox@sha256:" + "a".repeat(64),
    };
    const enterprise = (allowedModels: string[]) => ({
      ...base,
      enterprise: { enabled: true, allowedProviders: ["deepseek"], allowedModels },
      sandbox,
    });
    // Unpinned entries keep exact-match semantics on model and provider/model.
    await expect(resolveAgentConfig(root, enterprise(["deepseek-v4-pro"]))).resolves.toBeTruthy();
    // A pinned entry matches only the exact configured revision.
    await expect(
      resolveAgentConfig(root, enterprise(["deepseek/deepseek-v4-pro@deepseek-v4-pro-2026-06-15"])),
    ).resolves.toBeTruthy();
    await expect(
      resolveAgentConfig(root, enterprise(["deepseek/deepseek-v4-pro@deepseek-v4-pro-2026-01-01"])),
    ).rejects.toThrow("denies model");
    // A pinned entry never matches a model without a known revision.
    await expect(
      resolveAgentConfig(root, {
        provider: "ollama",
        model: "llama",
        globalConfigPath: join(root, "missing.json"),
        projectConfigPath: join(root, "missing-project.json"),
        enterprise: {
          enabled: true,
          allowedProviders: ["ollama"],
          allowedModels: ["ollama/llama@pinned-rev"],
        },
        sandbox,
      }),
    ).rejects.toThrow("denies model");

    // Explicit revision override via the models map.
    const pinned = await resolveAgentConfig(root, {
      ...base,
      models: { "deepseek/deepseek-v4-pro": { revision: "measured-revision-001" } },
    });
    expect(pinned.model.revision).toBe("measured-revision-001");

    // Fingerprint config: default fail outside enterprise, warn in enterprise.
    const drift = await resolveAgentConfig(root, { ...base, expectedSystemFingerprint: "fp_1" });
    expect(drift.model.systemFingerprintPolicy).toBe("fail");
    const enterpriseDrift = await resolveAgentConfig(root, {
      ...enterprise(["deepseek/deepseek-v4-pro"]),
      expectedSystemFingerprint: "fp_1",
    });
    expect(enterpriseDrift.model.systemFingerprintPolicy).toBe("warn");
    const explicit = await resolveAgentConfig(root, {
      ...base,
      expectedSystemFingerprint: "fp_1",
      systemFingerprintPolicy: "off" as const,
    });
    expect(explicit.model.systemFingerprintPolicy).toBe("off");
    await expect(
      resolveAgentConfig(root, { ...base, systemFingerprintPolicy: "loud" as never }),
    ).rejects.toThrow("systemFingerprintPolicy must be one of");
  });

  it("rejects malformed provider, sandbox and keymap configuration", async () => {
    const root = await createTestDirectory("agent-invalid-config");
    const global = join(root, "global.json");
    await writeFile(
      global,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "fixture",
        protocol: "made-up",
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        globalConfigPath: global,
        projectConfigPath: join(root, "missing.json"),
      }),
    ).rejects.toThrow("protocol must be one of");
    await writeFile(
      global,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "fixture",
        sandbox: { kind: "vm", vmHost: "agent@vm" },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        globalConfigPath: global,
        projectConfigPath: join(root, "missing.json"),
      }),
    ).rejects.toThrow("requires vmHost and vmWorkspace");
    await writeFile(
      global,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "fixture",
        tui: { keymap: { "ctrl+x": "teleport" } },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        globalConfigPath: global,
        projectConfigPath: join(root, "missing.json"),
      }),
    ).rejects.toThrow("Invalid TUI action");
  });

  it("applies skills and loop configuration defaults and validates input", async () => {
    const root = await createTestDirectory("agent-skills-loop");
    const base = {
      provider: "ollama",
      model: "fixture",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    };
    // Defaults: manifest undefined, maxIterations 8, tokenBudget 200_000.
    const defaults = await resolveAgentConfig(root, base);
    expect(defaults.skills.manifest).toBeUndefined();
    expect(defaults.loop.maxIterations).toBe(8);
    expect(defaults.loop.tokenBudget).toBe(200_000);

    // Inline manifest is preserved verbatim.
    const inline = await resolveAgentConfig(root, {
      ...base,
      skills: {
        manifest: {
          schemaVersion: "focuscode-skills.v1",
          skills: [
            {
              name: "tdd",
              description: "TDD",
              trigger: { keywords: ["test"] },
              prompt: "Write failing test first.",
              allowedTools: ["read", "write"],
            },
          ],
        },
      },
      loop: { maxIterations: 4, tokenBudget: 50_000 },
    });
    expect(inline.skills.manifest).toMatchObject({ schemaVersion: "focuscode-skills.v1" });
    expect(inline.loop.maxIterations).toBe(4);
    expect(inline.loop.tokenBudget).toBe(50_000);

    // String path is preserved (loading happens in the agent runtime).
    const pathConfig = await resolveAgentConfig(root, {
      ...base,
      skills: { manifest: "./skills.json" },
    });
    expect(pathConfig.skills.manifest).toBe("./skills.json");

    // Bounds clamping: maxIterations below 1 is clamped to 1, above 100 to 100.
    const clampedLow = await resolveAgentConfig(root, {
      ...base,
      loop: { maxIterations: 0, tokenBudget: 100 },
    });
    expect(clampedLow.loop.maxIterations).toBe(1);
    const clampedHigh = await resolveAgentConfig(root, {
      ...base,
      loop: { maxIterations: 999, tokenBudget: 100 },
    });
    expect(clampedHigh.loop.maxIterations).toBe(100);

    // Invalid manifest schema version is rejected.
    await expect(
      resolveAgentConfig(root, {
        ...base,
        skills: {
          manifest: {
            schemaVersion: "focuscode-skills.v0",
            skills: [],
          },
        },
      }),
    ).rejects.toThrow("skills.manifest.schemaVersion must be focuscode-skills.v1");

    // Non-number loop fields are rejected.
    await expect(
      resolveAgentConfig(root, {
        ...base,
        loop: { maxIterations: "eight" as never, tokenBudget: 100 },
      }),
    ).rejects.toThrow("loop.maxIterations must be a finite number");
  });

  it("supports multi-language diagnostics configuration", async () => {
    const root = await createTestDirectory("agent-diagnostics-multi");
    const base = {
      provider: "ollama",
      model: "fixture",
      apiKey: "fixture-key",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    };
    // Object form: enabled with explicit provider list.
    const multi = await resolveAgentConfig(root, {
      ...base,
      agent: { diagnostics: { providers: ["typescript", "python"] } },
    });
    expect(multi.agent.diagnostics).toEqual({
      enabled: true,
      providers: ["typescript", "python"],
    });

    // Boolean true → enabled, providers undefined (auto-detect all).
    const boolTrue = await resolveAgentConfig(root, {
      ...base,
      agent: { diagnostics: true },
    });
    expect(boolTrue.agent.diagnostics).toEqual({ enabled: true, providers: undefined });

    // Boolean false → disabled.
    const boolFalse = await resolveAgentConfig(root, {
      ...base,
      agent: { diagnostics: false },
    });
    expect(boolFalse.agent.diagnostics).toEqual({ enabled: false, providers: undefined });

    // Default (undefined) → enabled, providers undefined.
    const defaultConfig = await resolveAgentConfig(root, base);
    expect(defaultConfig.agent.diagnostics).toEqual({ enabled: true, providers: undefined });

    // Object form without providers → enabled, providers undefined.
    const objNoProviders = await resolveAgentConfig(root, {
      ...base,
      agent: { diagnostics: {} },
    });
    expect(objNoProviders.agent.diagnostics).toEqual({ enabled: true, providers: undefined });

    // Invalid provider id is rejected.
    await expect(
      resolveAgentConfig(root, {
        ...base,
        agent: { diagnostics: { providers: ["invalid-lang"] } },
      }),
    ).rejects.toThrow(/diagnostics.providers/);

    // Non-array providers is rejected.
    await expect(
      resolveAgentConfig(root, {
        ...base,
        agent: { diagnostics: { providers: "typescript" as never } },
      }),
    ).rejects.toThrow(/diagnostics.providers must be a string array/);

    // Non-boolean, non-object is rejected.
    await expect(
      resolveAgentConfig(root, {
        ...base,
        agent: { diagnostics: "yes" as never },
      }),
    ).rejects.toThrow(/agent.diagnostics must be boolean or object/);
  });

  it("discovers instructions, skills, prompts and extensions only when trusted", async () => {
    const root = await createTestDirectory("agent-resources");
    const home = await createTestDirectory("agent-home");
    await mkdir(join(root, ".focuscode", "skills", "review"), { recursive: true });
    await mkdir(join(root, ".focuscode", "prompts"), { recursive: true });
    await mkdir(join(root, ".focuscode", "extensions"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use small changes.\n");
    await writeFile(
      join(root, ".focuscode", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nCheck the diff.\n",
    );
    await writeFile(
      join(root, ".focuscode", "prompts", "fix.md"),
      "---\ndescription: Fix a bug\n---\nFix: $ARGUMENTS\n",
    );
    const extensionPath = join(root, ".focuscode", "extensions", "fixture.mjs");
    await writeFile(
      extensionPath,
      `export const name = "fixture";
export default function(api) {
  api.appendSystemPrompt("extension prompt");
  api.registerCommand({name:"hello",description:"hello",execute:(args)=>"hi "+args});
  api.registerTool({definition:{name:"fixture_tool",label:"Fixture",description:"fixture",parameters:{type:"object"},effect:"read"},execute:async()=>({content:"fixture result"})});
}`,
    );
    await writeFile(join(root, "attached.txt"), "attachment body\n");
    const resources = await loadAgentResources({
      cwd: root,
      projectTrusted: true,
      homeDirectory: home,
    });
    expect(resources.instructions.map((item) => item.path)).toContain(join(root, "AGENTS.md"));
    expect(resources.skills).toMatchObject([{ name: "review", description: "Review changes" }]);
    expect(expandPromptTemplate(resources.prompts[0]!, "issue")).toContain("Fix: issue");
    expect(renderResourcePrompt(resources)).toContain("Use small changes");
    expect(await expandFileMentions(root, "inspect @attached.txt")).toContain("attachment body");

    const registry = new AgentToolRegistry();
    const host = new ExtensionHost(registry);
    expect(await host.load(resources.extensionPaths)).toMatchObject([{ name: "fixture" }]);
    expect(registry.get("fixture_tool")).toBeDefined();
    expect(await host.getCommand("hello")?.execute("world", { sessionId: "s", cwd: root })).toBe(
      "hi world",
    );
    expect(host.systemPrompt()).toContain("extension prompt");
    expect(await host.reload()).toHaveLength(1);
    expect(registry.get("fixture_tool")).toBeDefined();

    const untrusted = await loadAgentResources({
      cwd: root,
      projectTrusted: false,
      homeDirectory: home,
    });
    expect(untrusted.skills).toEqual([]);
    expect(untrusted.extensionPaths).toEqual([]);
  });
});
