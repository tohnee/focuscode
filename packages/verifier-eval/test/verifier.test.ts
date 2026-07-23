import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SafeCommandRunner } from "@focuscode/action-backends";
import { createTestDirectory } from "@focuscode/testkit";
import { RegisteredCommandVerifier } from "../src/index.js";

describe("RegisteredCommandVerifier", () => {
  it("distinguishes a baseline failure from a repaired target", async () => {
    const root = await createTestDirectory("verifier");
    const marker = join(root, "ok.txt");
    const runner = new SafeCommandRunner(
      [
        {
          id: "check",
          argv: [
            process.execPath,
            "-e",
            "const fs=require('node:fs');process.exit(fs.existsSync('ok.txt')?0:1)",
          ],
        },
      ],
      { cwd: root },
    );
    const verifier = new RegisteredCommandVerifier(runner, ["check"]);
    const baseline = await verifier.verify({ taskId: "task", phase: "baseline" });
    expect(baseline.conclusion).toBe("BASELINE_FAIL");
    await writeFile(marker, "ok\n");
    const target = await verifier.verify({ taskId: "task", phase: "target", baseline });
    expect(target.conclusion).toBe("PASS");
  });

  it("returns PARTIAL when no deterministic command is registered", async () => {
    const root = await createTestDirectory("verifier-empty");
    const verifier = new RegisteredCommandVerifier(new SafeCommandRunner([], { cwd: root }), []);
    expect((await verifier.verify({ taskId: "task", phase: "target" })).conclusion).toBe("PARTIAL");
  });
});
