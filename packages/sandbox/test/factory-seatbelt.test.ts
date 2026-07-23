import { describe, expect, it } from "vitest";
import { createSandbox } from "../src/index.js";
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

describe("createSandbox — seatbelt kind", () => {
  it("returns a SeatbeltSandbox when kind=seatbelt and sandbox-exec is available on darwin", async () => {
    const captured = capture([{ stdout: "sandbox-exec 4\n" }]);
    const sb = await createSandbox({
      kind: "seatbelt",
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: captured.runner,
    } as never);
    expect(sb.kind).toBe("seatbelt");
  });

  it("throws when kind=seatbelt but platform is not darwin", async () => {
    const captured = capture();
    await expect(
      createSandbox({
        kind: "seatbelt",
        workspaceRoot: "/repo",
        platform: "linux",
        processRunner: captured.runner,
      } as never),
    ).rejects.toThrow("unavailable");
  });

  it("throws when kind=seatbelt but sandbox-exec is missing on darwin", async () => {
    const captured = capture([{ exitCode: 127, stderr: "command not found" }]);
    await expect(
      createSandbox({
        kind: "seatbelt",
        workspaceRoot: "/repo",
        platform: "darwin",
        processRunner: captured.runner,
      } as never),
    ).rejects.toThrow("unavailable");
  });
});

describe("createSandbox — auto fallback chain with seatbelt", () => {
  it("falls back to seatbelt on darwin when gVisor and Docker are unavailable", async () => {
    const captured = capture([
      { exitCode: 1, stderr: "no docker" }, // gVisor health
      { exitCode: 1, stderr: "no docker" }, // Docker health
      { stdout: "sandbox-exec 4\n" }, // seatbelt health
    ]);
    const sb = await createSandbox({
      kind: "auto",
      workspaceRoot: "/repo",
      platform: "darwin",
      processRunner: captured.runner,
    } as never);
    expect(sb.kind).toBe("seatbelt");
  });

  it("skips seatbelt on non-darwin and falls back to host when allowed", async () => {
    const captured = capture([
      { exitCode: 1, stderr: "no docker" }, // gVisor health
      { exitCode: 1, stderr: "no docker" }, // Docker health
      // seatbelt health NOT called on linux — only 2 invocations expected
    ]);
    const sb = await createSandbox({
      kind: "auto",
      workspaceRoot: "/repo",
      platform: "linux",
      allowHostFallback: true,
      processRunner: captured.runner,
    } as never);
    expect(sb.kind).toBe("host");
    // Verify seatbelt health was never probed (only 2 docker health calls).
    expect(captured.invocations).toHaveLength(2);
  });

  it("falls back from seatbelt to host on darwin when sandbox-exec is missing and allowHostFallback", async () => {
    const captured = capture([
      { exitCode: 1, stderr: "no docker" }, // gVisor health
      { exitCode: 1, stderr: "no docker" }, // Docker health
      { exitCode: 127, stderr: "command not found" }, // seatbelt health
    ]);
    const sb = await createSandbox({
      kind: "auto",
      workspaceRoot: "/repo",
      platform: "darwin",
      allowHostFallback: true,
      processRunner: captured.runner,
    } as never);
    expect(sb.kind).toBe("host");
  });

  it("fails when all backends are unavailable and host fallback is disabled", async () => {
    const captured = capture([
      { exitCode: 1, stderr: "no docker" }, // gVisor health
      { exitCode: 1, stderr: "no docker" }, // Docker health
      { exitCode: 127, stderr: "command not found" }, // seatbelt health
    ]);
    await expect(
      createSandbox({
        kind: "auto",
        workspaceRoot: "/repo",
        platform: "darwin",
        processRunner: captured.runner,
      } as never),
    ).rejects.toThrow("Host fallback is disabled");
  });
});
