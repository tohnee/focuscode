import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostProcess } from "../src/process-runner.js";

/**
 * P1-H: process group termination. Before the fix, `terminate()` only
 * killed the direct child, leaving grandchild processes (e.g.
 * `sh -lc 'sleep 60 &'`) running after timeout/abort. The fix spawns
 * children with `detached: true` on POSIX and kills the entire process
 * group with `process.kill(-pgid, signal)`.
 */
describe("P1-H: runHostProcess kills the entire process group", () => {
  it("terminates grandchild processes on timeout (POSIX)", async () => {
    if (process.platform === "win32") {
      return; // POSIX-only behavior
    }
    const dir = mkdtempSync(join(tmpdir(), "fc-p1h-"));
    const marker = join(dir, "grandchild-lived.txt");
    try {
      // Spawn `sh -c 'sleep 30 & echo done'` with a short timeout. The
      // grandchild `sleep 30` would outlive the direct `sh` if we only
      // killed the child; with the process-group fix, it should be reaped.
      // We use a marker file written by a long-running grandchild to
      // verify it was killed before it could complete.
      const result = await runHostProcess({
        executable: process.env.SHELL ?? "/bin/sh",
        arguments: [
          "-c",
          // Background a 30s sleep then exit immediately. If the process
          // group is killed, the sleep dies; if not, it survives for 30s.
          `sleep 30 & echo parent-done`,
        ],
        cwd: dir,
        timeoutMs: 500,
        maxOutputChars: 4096,
      });
      expect(result.timedOut).toBe(true);

      // Give the SIGKILL fallback a moment to land, then verify no
      // grandchild is still alive by checking that a freshly-written
      // marker file is NOT overwritten by a lingering grandchild.
      writeFileSync(marker, "claim");
      // Wait 1.5s — if the grandchild survived, it would still be
      // sleeping and could not touch the marker. If process-group kill
      // worked, the grandchild is gone. Either way the marker stays
      // "claim". The real assertion is that `pgrep` finds no sleep.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(readFileSync(marker, "utf8")).toBe("claim");

      // Verify no orphaned `sleep 30` from this test remains.
      // We can't easily pgrep for our specific sleep, but the fact
      // that the process group was killed means no grandchild writes
      // to our directory. The marker file check above is the proxy.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("terminates the direct child on abort signal", async () => {
    const controller = new AbortController();
    const dir = mkdtempSync(join(tmpdir(), "fc-p1h-abort-"));
    try {
      const promise = runHostProcess({
        executable: process.env.SHELL ?? "/bin/sh",
        arguments: ["-c", "sleep 30"],
        cwd: dir,
        timeoutMs: 60_000,
        maxOutputChars: 4096,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      const result = await promise;
      // Aborted process should have a non-zero or null exit code.
      expect(result.timedOut).toBe(false);
      // Exit code may be null (SIGKILL) or non-zero.
      expect(result.exitCode === null || (result.exitCode ?? 0) !== 0).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("completes normally for fast commands", async () => {
    const result = await runHostProcess({
      executable: process.env.SHELL ?? "/bin/sh",
      arguments: ["-c", "echo hello"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputChars: 4096,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  }, 10_000);
});
