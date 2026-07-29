import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { resolveAgentConfig } from "../src/index.js";

/**
 * P1-2: settingSources 三层语义 (project / local / user)
 *
 * 配置加载层级（低 → 高优先级）:
 *   user   ~/.focuscode/config.json             (全局用户配置)
 *   project <cwd>/.focuscode/agent.json         (项目共享配置，需 projectTrusted)
 *   local   <cwd>/.focuscode.local/agent.json   (本地个人覆盖，不入 git)
 *
 * settingSources 字段声明允许加载哪些层，默认全部启用。
 * 即便 settingSources 包含 "project"，仍需 projectTrusted=true 才加载项目层。
 * local 层是个人本地配置，不受 projectTrusted 限制。
 *
 * 测试统一使用 ollama provider（本地推理，无需 API key），通过 model id 区分层级。
 */
describe("settingSources three-layer config semantics", () => {
  async function writeLayer(
    root: string,
    layer: "global" | "project" | "local",
    config: Record<string, unknown>,
  ): Promise<string> {
    if (layer === "global") {
      await mkdir(join(root, "global"), { recursive: true });
      const path = join(root, "global", "config.json");
      await writeFile(path, JSON.stringify(config));
      return path;
    }
    if (layer === "project") {
      await mkdir(join(root, ".focuscode"), { recursive: true });
      const path = join(root, ".focuscode", "agent.json");
      await writeFile(path, JSON.stringify(config));
      return path;
    }
    // local
    await mkdir(join(root, ".focuscode.local"), { recursive: true });
    const path = join(root, ".focuscode.local", "agent.json");
    await writeFile(path, JSON.stringify(config));
    return path;
  }

  function baseConfig(model: string): Record<string, unknown> {
    return { schemaVersion: "focuscode-agent.v1", provider: "ollama", model };
  }

  it("loads only global when no project or local exists", async () => {
    const root = await createTestDirectory("ss-global-only");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: join(root, ".focuscode", "agent.json"),
      localConfigPath: join(root, ".focuscode.local", "agent.json"),
    });
    expect(config.sources).toEqual([globalPath]);
    expect(config.model.model).toBe("g-model");
    expect(config.settingSources).toEqual(["user", "project", "local"]);
  });

  it("merges project over global", async () => {
    const root = await createTestDirectory("ss-project-over-global");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      projectTrusted: true,
    });
    expect(config.sources).toEqual([globalPath, projectPath]);
    expect(config.model.model).toBe("p-model");
  });

  it("merges local over project over global", async () => {
    const root = await createTestDirectory("ss-local-over-project");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const localPath = await writeLayer(root, "local", baseConfig("l-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: true,
    });
    expect(config.sources).toEqual([globalPath, projectPath, localPath]);
    expect(config.model.model).toBe("l-model");
  });

  it("local shallow-merges agent subfields over project", async () => {
    const root = await createTestDirectory("ss-local-shallow-merge");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const localPath = await writeLayer(root, "local", {
      ...baseConfig("p-model"),
      agent: { checkpoints: false },
    });
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: true,
    });
    // local.agent.checkpoints=false overrides project default (true)
    expect(config.agent.checkpoints).toBe(false);
    // Other agent defaults preserved from merge chain
    expect(config.agent.effectSpine).toBe(true);
  });

  it("respects settingSources: ['user', 'project'] — skips local", async () => {
    const root = await createTestDirectory("ss-skip-local");
    const globalPath = await writeLayer(root, "global", {
      ...baseConfig("g-model"),
      settingSources: ["user", "project"],
    });
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const localPath = await writeLayer(root, "local", baseConfig("l-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: true,
    });
    expect(config.sources).toEqual([globalPath, projectPath]);
    expect(config.model.model).toBe("p-model");
    expect(config.settingSources).toEqual(["user", "project"]);
  });

  it("respects settingSources: ['user'] — skips project and local", async () => {
    const root = await createTestDirectory("ss-user-only");
    const globalPath = await writeLayer(root, "global", {
      ...baseConfig("g-model"),
      settingSources: ["user"],
    });
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const localPath = await writeLayer(root, "local", baseConfig("l-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: true,
    });
    expect(config.sources).toEqual([globalPath]);
    expect(config.model.model).toBe("g-model");
    expect(config.settingSources).toEqual(["user"]);
  });

  it("defaults to all three layers when settingSources is absent", async () => {
    const root = await createTestDirectory("ss-default-all");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: join(root, ".focuscode", "agent.json"),
      localConfigPath: join(root, ".focuscode.local", "agent.json"),
    });
    expect(config.settingSources).toEqual(["user", "project", "local"]);
  });

  it("loads local even when projectTrusted is false", async () => {
    const root = await createTestDirectory("ss-local-without-trust");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const localPath = await writeLayer(root, "local", baseConfig("l-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: false,
    });
    // project is not loaded (untrusted), but local is (personal override)
    expect(config.sources).toEqual([globalPath, localPath]);
    expect(config.model.model).toBe("l-model");
  });

  it("overrides take highest priority over local", async () => {
    const root = await createTestDirectory("ss-overrides-highest");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const projectPath = await writeLayer(root, "project", baseConfig("p-model"));
    const localPath = await writeLayer(root, "local", baseConfig("l-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: true,
      model: "override-model",
    });
    expect(config.model.model).toBe("override-model");
  });

  it("honors custom localConfigPath override", async () => {
    const root = await createTestDirectory("ss-custom-local-path");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const customLocalDir = join(root, "custom", "local");
    await mkdir(customLocalDir, { recursive: true });
    const customLocalPath = join(customLocalDir, "my-config.json");
    await writeFile(customLocalPath, JSON.stringify(baseConfig("custom-local")));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      localConfigPath: customLocalPath,
    });
    expect(config.sources).toEqual([globalPath, customLocalPath]);
    expect(config.model.model).toBe("custom-local");
  });

  it("rejects local config with wrong schemaVersion", async () => {
    const root = await createTestDirectory("ss-local-bad-schema");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const localPath = await writeLayer(root, "local", {
      schemaVersion: "focuscode-agent.v999",
      provider: "ollama",
      model: "l-model",
    });
    await expect(
      resolveAgentConfig(root, {
        globalConfigPath: globalPath,
        localConfigPath: localPath,
      }),
    ).rejects.toThrow(/Unsupported agent config schema/);
  });

  it("rejects invalid settingSources values", async () => {
    const root = await createTestDirectory("ss-invalid-sources");
    const globalPath = await writeLayer(root, "global", {
      ...baseConfig("g-model"),
      settingSources: ["user", "remote"],
    });
    await expect(
      resolveAgentConfig(root, {
        globalConfigPath: globalPath,
      }),
    ).rejects.toThrow(/settingSources must contain only/);
  });

  it("project settingSources is ignored — only user layer declares", async () => {
    // settingSources 在 project 层声明应被忽略，以防止项目篡改加载策略
    const root = await createTestDirectory("ss-project-ignored");
    const globalPath = await writeLayer(root, "global", baseConfig("g-model"));
    const projectPath = await writeLayer(root, "project", {
      ...baseConfig("p-model"),
      settingSources: ["user"], // 应被忽略
    });
    const localPath = await writeLayer(root, "local", baseConfig("l-model"));
    const config = await resolveAgentConfig(root, {
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      localConfigPath: localPath,
      projectTrusted: true,
    });
    // project 的 settingSources 被忽略，三层全部加载
    expect(config.sources).toEqual([globalPath, projectPath, localPath]);
    expect(config.settingSources).toEqual(["user", "project", "local"]);
  });

  it("exposes settingSources in resolved config even when all layers absent", async () => {
    const root = await createTestDirectory("ss-empty-sources");
    const config = await resolveAgentConfig(root, {
      provider: "ollama",
      model: "x",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
      localConfigPath: join(root, "missing-local.json"),
    });
    expect(config.settingSources).toEqual(["user", "project", "local"]);
    expect(config.sources).toEqual([]);
  });
});
