import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory, type ScriptedStep } from "@focuscode/testkit";
import { createLocalHarness } from "../src/index.js";

/**
 * TDD RED→GREEN for P1-6: Model Pack loading failure paths via SDK.
 *
 * `createLocalHarness` calls `loadModelPack(options.modelPackPath ?? DEFAULT_PACK_PATH)`
 * which in turn calls `assertModelPack`. These tests cover the previously
 * untested failure modes:
 *   1. pack file does not exist (ENOENT)
 *   2. pack file is valid JSON but fails schema assertion
 *   3. pack file is invalid JSON
 *
 * Source: packages/model-gateway/src/model-pack.ts
 */
describe("createLocalHarness model pack failures", () => {
  it("rejects when modelPackPath points to a non-existent file", async () => {
    const repoRoot = await createTestDirectory("sdk-pack-missing-repo");
    const stateDirectory = await createTestDirectory("sdk-pack-missing-state");
    const missingPack = join(stateDirectory, "no-such-pack.json");

    await expect(
      createLocalHarness({
        repoRoot,
        stateDirectory,
        modelPackPath: missingPack,
        model: { kind: "scripted", steps: [] as ScriptedStep[] },
      }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("rejects when model pack JSON fails schema assertion", async () => {
    const repoRoot = await createTestDirectory("sdk-pack-bad-schema-repo");
    const stateDirectory = await createTestDirectory("sdk-pack-bad-schema-state");
    const badPack = join(stateDirectory, "bad-pack.json");
    await writeFile(
      badPack,
      JSON.stringify({
        schemaVersion: "not-the-right-version",
        id: "test",
      }),
    );

    await expect(
      createLocalHarness({
        repoRoot,
        stateDirectory,
        modelPackPath: badPack,
        model: { kind: "scripted", steps: [] as ScriptedStep[] },
      }),
    ).rejects.toThrow(/Unsupported Model Pack version|Model Pack/);
  });

  it("rejects when model pack file is invalid JSON", async () => {
    const repoRoot = await createTestDirectory("sdk-pack-bad-json-repo");
    const stateDirectory = await createTestDirectory("sdk-pack-bad-json-state");
    const badJsonPack = join(stateDirectory, "broken-pack.json");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(badJsonPack, "{ this is not valid json,,,");

    await expect(
      createLocalHarness({
        repoRoot,
        stateDirectory,
        modelPackPath: badJsonPack,
        model: { kind: "scripted", steps: [] as ScriptedStep[] },
      }),
    ).rejects.toThrow(/JSON|Unexpected token/i);
  });
});
