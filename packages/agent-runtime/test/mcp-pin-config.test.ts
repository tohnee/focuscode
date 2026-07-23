import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { resolveAgentConfig } from "../src/index.js";

const VALID_PIN = {
  serverId: "fake",
  serverVersion: "1.2.3",
  toolName: "echo",
  schemaDigest: "sha256:abc",
  transportDigest: "sha256:def",
};

describe("mcp.pins config resolution", () => {
  it("parses declared pins into ResolvedAgentConfig.mcp.pins", async () => {
    const root = await createTestDirectory("mcp-pins-parse");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: {
          servers: [{ id: "fake", command: "true" }],
          pins: [VALID_PIN],
        },
      }),
    );
    const config = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    expect(config.mcp.pins).toHaveLength(1);
    expect(config.mcp.pins[0]).toMatchObject({
      serverId: "fake",
      toolName: "echo",
      schemaDigest: "sha256:abc",
    });
  });

  it("defaults mcp.pins to an empty array when not declared", async () => {
    const root = await createTestDirectory("mcp-pins-default");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: { servers: [] },
      }),
    );
    const config = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    expect(config.mcp.pins).toEqual([]);
  });

  it("defaults both mcp.servers and mcp.pins when mcp is absent", async () => {
    const root = await createTestDirectory("mcp-pins-absent");
    const config = await resolveAgentConfig(root, {
      provider: "ollama",
      model: "x",
      globalConfigPath: join(root, "missing.json"),
      projectConfigPath: join(root, "missing-project.json"),
    });
    expect(config.mcp.servers).toEqual([]);
    expect(config.mcp.pins).toEqual([]);
  });

  it("returns a defensive copy so callers cannot mutate the resolved pins", async () => {
    const root = await createTestDirectory("mcp-pins-copy");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: { pins: [VALID_PIN] },
      }),
    );
    const config = await resolveAgentConfig(root, {
      projectConfigPath: project,
      projectTrusted: true,
    });
    config.mcp.pins[0]!.serverId = "mutated";
    expect(VALID_PIN.serverId).toBe("fake");
  });

  it("rejects a non-array mcp.pins", async () => {
    const root = await createTestDirectory("mcp-pins-not-array");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: { pins: "not-an-array" },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/mcp\.pins must be an array/);
  });

  it("rejects a pin with an empty serverId", async () => {
    const root = await createTestDirectory("mcp-pins-empty-id");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: {
          pins: [{ ...VALID_PIN, serverId: "" }],
        },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/mcp\.pins\[0\]\.serverId must be a non-empty string/);
  });

  it("rejects a pin missing the schemaDigest field", async () => {
    const root = await createTestDirectory("mcp-pins-missing-digest");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    const { schemaDigest: _omit, ...missingDigest } = VALID_PIN;
    void _omit;
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: { pins: [missingDigest] },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/mcp\.pins\[0\]\.schemaDigest must be a non-empty string/);
  });

  it("rejects a pin that is not an object", async () => {
    const root = await createTestDirectory("mcp-pins-non-object");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: { pins: ["not-an-object"] },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/mcp\.pins\[0\] must be an object/);
  });

  it("rejects a pin with a control character in the toolName", async () => {
    const root = await createTestDirectory("mcp-pins-control-char");
    const project = join(root, ".focuscode", "agent.json");
    await mkdir(join(root, ".focuscode"));
    await writeFile(
      project,
      JSON.stringify({
        schemaVersion: "focuscode-agent.v1",
        provider: "ollama",
        model: "x",
        mcp: {
          pins: [{ ...VALID_PIN, toolName: "bad\u0000name" }],
        },
      }),
    );
    await expect(
      resolveAgentConfig(root, {
        projectConfigPath: project,
        projectTrusted: true,
      }),
    ).rejects.toThrow(/mcp\.pins\[0\]\.toolName must be a non-empty string/);
  });
});
