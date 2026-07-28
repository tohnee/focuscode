import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { createCodingAgent } from "../src/index.js";

/**
 * TDD RED→GREEN for P1-4: session resume via SDK.
 *
 * Covers the previously-untested path where a caller passes `sessionId` to
 * `createCodingAgent` to resume an existing session instead of creating a new
 * one. This mirrors `CodingAgent.create({ sessionId })` but is exercised
 * through the SDK composition root.
 */
describe("createCodingAgent session resume", () => {
  it("resumes an existing session when sessionId is provided", async () => {
    const repoRoot = await createTestDirectory("sdk-resume");
    const sessionDirectory = await createTestDirectory("sdk-resume-state");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "placeholder.txt"), "initial\n");

    // First agent: create a persistent session and capture its id.
    const first = await createCodingAgent({
      cwd: repoRoot,
      sessionDirectory,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: true,
      projectTrusted: false,
    });
    const sessionId = first.agent.sessionId;
    expect(sessionId).toMatch(/^session_/);

    // Second agent: pass the same sessionId to resume.
    const resumed = await createCodingAgent({
      cwd: repoRoot,
      sessionDirectory,
      sessionId,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: true,
      projectTrusted: false,
    });

    expect(resumed.agent.sessionId).toBe(sessionId);
  });

  it("rejects resume when sessionId does not exist in the store", async () => {
    const repoRoot = await createTestDirectory("sdk-resume-missing");
    const sessionDirectory = await createTestDirectory("sdk-resume-missing-state");

    await expect(
      createCodingAgent({
        cwd: repoRoot,
        sessionDirectory,
        sessionId: "session-does-not-exist",
        provider: "custom",
        model: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
        approval: "deny",
        sandbox: { kind: "host" },
        persistentSession: true,
        projectTrusted: false,
      }),
    ).rejects.toThrow(/session/i);
  });

  it("rejects resume when the resumed session cwd differs from the requested cwd", async () => {
    const repoRootA = await createTestDirectory("sdk-resume-cwd-a");
    const repoRootB = await createTestDirectory("sdk-resume-cwd-b");
    const sessionDirectory = await createTestDirectory("sdk-resume-cwd-state");

    const first = await createCodingAgent({
      cwd: repoRootA,
      sessionDirectory,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: true,
      projectTrusted: false,
    });
    const sessionId = first.agent.sessionId;

    await expect(
      createCodingAgent({
        cwd: repoRootB,
        sessionDirectory,
        sessionId,
        provider: "custom",
        model: "fixture",
        baseUrl: "http://127.0.0.1:1/v1",
        approval: "deny",
        sandbox: { kind: "host" },
        persistentSession: true,
        projectTrusted: false,
      }),
    ).rejects.toThrow(/workspace/i);
  });
});
