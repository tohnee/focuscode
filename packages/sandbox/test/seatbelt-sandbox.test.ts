import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { SeatbeltSandbox } from "../src/seatbelt.js";
import type { ProcessInvocation, ProcessRunner } from "../src/types.js";

function capture(results: Array<Partial<Awaited<ReturnType<ProcessRunner>>>> = []) {
  const invocations: ProcessInvocation[] = [];
  const runner: ProcessRunner = async (invocation) => {
    invocations.push(invocation);
    const result = results.shift();
    return {
      exitCode: result?.exitCode ?? 0,
      stdout: result?.stdout ?? "ok",
      stderr: result?.stderr ?? "",
      timedOut: result?.timedOut ?? false,
      durationMs: result?.durationMs ?? 1,
      invocation: { executable: invocation.executable, arguments: invocation.arguments },
    };
  };
  return { invocations, runner };
}

describe("SeatbeltSandbox — unit (cross-platform)", () => {
  it("exposes kind === 'seatbelt'", () => {
    const sb = new SeatbeltSandbox({ workspaceRoot: "/repo", platform: "darwin" });
    expect(sb.kind).toBe("seatbelt");
  });

  it("health() returns unavailable on non-darwin platforms", async () => {
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "linux",
      processRunner: capture().runner,
    });
    const health = await sb.health();
    expect(health.available).toBe(false);
    expect(health.backend).toBe("seatbelt");
    expect(health.detail).toContain("macOS-only");
  });

  it("health() returns available on darwin when sandbox-exec --version succeeds", async () => {
    const { runner } = capture([{ stdout: "sandbox-exec 4\n" }]);
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: runner,
    });
    const health = await sb.health();
    expect(health.available).toBe(true);
    expect(health.backend).toBe("seatbelt");
    expect(health.isolation).toBe("kernel");
  });

  it("health() returns unavailable on darwin when sandbox-exec is missing", async () => {
    const { runner } = capture([{ exitCode: 127, stderr: "command not found" }]);
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: runner,
    });
    const health = await sb.health();
    expect(health.available).toBe(false);
    expect(health.detail).toContain("not found");
  });

  it("execute() invokes sandbox-exec -p <profile> -- <shell> -lc <command>", async () => {
    const captured = capture();
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: captured.runner,
    });
    const result = await sb.execute({
      command: "echo hi",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 1_000,
    });
    expect(result.backend).toBe("seatbelt");
    const invocation = captured.invocations[0];
    expect(invocation?.executable).toBe("sandbox-exec");
    expect(invocation?.arguments[0]).toBe("-p");
    // Profile is the second argument; the command follows after "--"
    const profileIndex = 1;
    const profile = invocation?.arguments[profileIndex] ?? "";
    expect(profile).toContain("(allow process-exec");
    const dashDashIndex = invocation?.arguments.indexOf("--") ?? -1;
    expect(dashDashIndex).toBeGreaterThan(1);
    const shellArgs = invocation?.arguments.slice(dashDashIndex + 1);
    expect(shellArgs?.[0]).toBe(process.env.SHELL ?? "/bin/sh");
    expect(shellArgs?.[1]).toBe("-lc");
    expect(shellArgs?.[2]).toBe("echo hi");
  });

  it("execute() builds a profile that allows /usr/bin, /bin, /usr/lib and workspace writes", async () => {
    const captured = capture();
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: captured.runner,
    });
    await sb.execute({
      command: "true",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 1_000,
    });
    const profile = captured.invocations[0]?.arguments[1] ?? "";
    // Must allow reading system binaries so the shell can execute.
    expect(profile).toContain("/usr/bin");
    expect(profile).toContain("/bin");
    expect(profile).toContain("/usr/lib");
    // Must allow read/write inside the workspace root.
    expect(profile).toContain("/repo");
    // Must deny file-write* outside the allowed subpaths (default deny).
    expect(profile).toContain("(deny file-write*");
  });

  it("execute() rejects a cwd that escapes the workspace root", async () => {
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: capture().runner,
    });
    await expect(
      sb.execute({
        command: "pwd",
        cwd: "/outside",
        workspaceRoot: "/repo",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("escapes workspace");
  });

  it("execute() forwards timeoutMs and signal to the runner", async () => {
    const captured = capture();
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: captured.runner,
    });
    const controller = new AbortController();
    await sb.execute({
      command: "sleep 1",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(captured.invocations[0]?.timeoutMs).toBe(5_000);
    expect(captured.invocations[0]?.signal).toBe(controller.signal);
  });

  it("health() uses sandbox-exec binary from options", async () => {
    const captured = capture([{ stdout: "sandbox-exec 4\n" }]);
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      sandboxExecBinary: "/usr/bin/sandbox-exec",
      processRunner: captured.runner,
    });
    await sb.health();
    expect(captured.invocations[0]?.executable).toBe("/usr/bin/sandbox-exec");
    expect(captured.invocations[0]?.arguments).toContain("--version");
  });

  it("execute() uses the node binary path in the profile allow list", async () => {
    const captured = capture();
    const sb = new SeatbeltSandbox({
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: captured.runner,
    });
    await sb.execute({
      command: "node -v",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 1_000,
    });
    const profile = captured.invocations[0]?.arguments[1] ?? "";
    // The node binary path should be allowed so child node processes can exec.
    expect(profile).toContain(process.execPath);
  });
});

describe("SeatbeltSandbox — integration (darwin only)", () => {
  let workspace: string;

  beforeEach(async () => {
    if (process.platform !== "darwin") return;
    workspace = await mkdtemp(join(tmpdir(), "focuscode-seatbelt-"));
    await writeFile(join(workspace, "marker.txt"), "inside\n");
  });

  afterEach(async () => {
    if (process.platform !== "darwin") return;
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  it.skipIf(process.platform !== "darwin")(
    "denies writes outside the workspace root under real sandbox-exec",
    async () => {
      const sb = new SeatbeltSandbox({ workspaceRoot: workspace });
      const health = await sb.health();
      if (!health.available) {
        // sandbox-exec not present in this environment — skip gracefully.
        return;
      }
      const outsidePath = join(tmpdir(), `focuscode-seatbelt-leak-${process.pid}`);
      const result = await sb.execute({
        command: `echo content > ${outsidePath} && echo wrote-ok || echo wrote-failed`,
        cwd: workspace,
        workspaceRoot: workspace,
        timeoutMs: 5_000,
      });
      // The seatbelt profile must deny the write to the outside path.
      expect(result.stdout).toContain("wrote-failed");
      expect(result.stdout).not.toContain("wrote-ok");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "allows writes inside the workspace root under real sandbox-exec",
    async () => {
      const sb = new SeatbeltSandbox({ workspaceRoot: workspace });
      const health = await sb.health();
      if (!health.available) return;
      const result = await sb.execute({
        command: `echo inside > marker.txt && cat marker.txt`,
        cwd: workspace,
        workspaceRoot: workspace,
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("inside");
    },
  );
});
