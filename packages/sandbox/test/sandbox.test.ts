import { describe, expect, it } from "vitest";
import {
  DockerSandbox,
  HostSandbox,
  SshVmSandbox,
  createSandbox,
  runHostProcess,
  type ProcessInvocation,
  type ProcessRunner,
} from "../src/index.js";

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

describe("sandbox executors", () => {
  it("constructs hardened Docker and gVisor invocations", async () => {
    const dockerCapture = capture();
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      image: "focus/image:test",
      processRunner: dockerCapture.runner,
    });
    const result = await docker.execute({
      command: "npm test",
      cwd: "/repo/sub",
      workspaceRoot: "/repo",
      timeoutMs: 1000,
    });
    expect(result.backend).toBe("docker");
    expect(dockerCapture.invocations[0]?.arguments).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--cap-drop",
        "ALL",
        "--network",
        "none",
        "--ipc",
        "none",
        "--log-driver",
        "none",
        "no-new-privileges=true",
      ]),
    );
    expect(dockerCapture.invocations[0]?.arguments).toContain("/workspace/sub");

    const gvisorCapture = capture([{ stdout: '"27"' }, { stdout: '{"runsc":{"path":"runsc"}}' }]);
    const gvisor = new DockerSandbox({
      workspaceRoot: "/repo",
      runtime: "runsc",
      processRunner: gvisorCapture.runner,
    });
    expect(await gvisor.health()).toMatchObject({ available: true, backend: "gvisor" });

    expect(
      () =>
        new DockerSandbox({
          workspaceRoot: "/repo",
          image: "focus/image:latest",
          requireImageDigest: true,
          processRunner: dockerCapture.runner,
        }),
    ).toThrow("pinned");
  });

  it("constructs strict SSH VM commands and rejects workspace escapes", async () => {
    const vmCapture = capture();
    const vm = new SshVmSandbox({
      workspaceRoot: "/repo",
      host: "agent@vm",
      remoteWorkspace: "/mnt/workspace",
      processRunner: vmCapture.runner,
    });
    await vm.execute({
      command: "pnpm test",
      cwd: "/repo/pkg",
      workspaceRoot: "/repo",
      timeoutMs: 1000,
    });
    expect(vmCapture.invocations[0]?.arguments.join(" ")).toContain("/mnt/workspace/pkg");
    expect(vmCapture.invocations[0]?.arguments.join(" ")).toContain("timeout --signal=TERM");
    await expect(
      vm.execute({ command: "pwd", cwd: "/outside", workspaceRoot: "/repo", timeoutMs: 1000 }),
    ).rejects.toThrow("escapes workspace");
  });

  it("force-removes a container when its attached execution times out", async () => {
    const dockerCapture = capture([{ timedOut: true, exitCode: null }, { stdout: "removed" }]);
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      processRunner: dockerCapture.runner,
    });
    const result = await docker.execute({
      command: "sleep 30",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 10,
    });
    expect(result.timedOut).toBe(true);
    expect(dockerCapture.invocations[1]?.arguments.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("selects gVisor, Docker or an explicitly allowed host fallback in auto mode", async () => {
    const gvisorCapture = capture([{ stdout: '"27"' }, { stdout: '{"runsc":{"path":"runsc"}}' }]);
    expect(
      (
        await createSandbox({
          kind: "auto",
          workspaceRoot: "/repo",
          processRunner: gvisorCapture.runner,
        } as never)
      ).kind,
    ).toBe("gvisor");

    const dockerCapture = capture([{ stdout: '"27"' }, { stdout: "{}" }, { stdout: '"27"' }]);
    expect(
      (
        await createSandbox({
          kind: "auto",
          workspaceRoot: "/repo",
          processRunner: dockerCapture.runner,
        } as never)
      ).kind,
    ).toBe("docker");

    const unavailable = capture([
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 127, stderr: "not found" },
    ]);
    expect(
      (
        await createSandbox({
          kind: "auto",
          workspaceRoot: "/repo",
          processRunner: unavailable.runner,
          allowHostFallback: true,
        } as never)
      ).kind,
    ).toBe("host");
    const denied = capture([
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 127, stderr: "not found" },
    ]);
    await expect(
      createSandbox({
        kind: "auto",
        workspaceRoot: "/repo",
        processRunner: denied.runner,
      } as never),
    ).rejects.toThrow("Host fallback is disabled");
  });

  it("runs host mode explicitly and enforces auto fallback policy", async () => {
    const hostCapture = capture();
    const host = new HostSandbox({ workspaceRoot: "/repo", processRunner: hostCapture.runner });
    expect((await host.health()).detail).toContain("no OS isolation");
    expect(
      (
        await host.execute({
          command: "pwd",
          cwd: "/repo",
          workspaceRoot: "/repo",
          timeoutMs: 1000,
        })
      ).backend,
    ).toBe("host");

    const unavailable: ProcessRunner = async (invocation) => ({
      exitCode: 1,
      stdout: "",
      stderr: "not installed",
      timedOut: false,
      durationMs: 1,
      invocation: { executable: invocation.executable, arguments: invocation.arguments },
    });
    await expect(
      createSandbox({
        kind: "docker",
        workspaceRoot: "/repo",
        processRunner: unavailable,
      } as never),
    ).rejects.toThrow("unavailable");
  });

  it("runs bounded host processes with stdin, stderr and exit status", async () => {
    const result = await runHostProcess({
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdin.on('data', value => { process.stdout.write(value); process.stderr.write('problem'); process.exitCode = 7; })",
      ],
      cwd: process.cwd(),
      input: "a".repeat(100),
      timeoutMs: 2_000,
      maxOutputChars: 32,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("[output truncated]");
    expect(result.stderr).toBe("problem");
    expect(result.timedOut).toBe(false);
  });

  it("terminates timed-out and aborted host processes and reports spawn failures", async () => {
    const timedOut = await runHostProcess({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 25,
      maxOutputChars: 100,
    });
    expect(timedOut.timedOut).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const aborted = await runHostProcess({
      executable: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxOutputChars: 100,
      signal: controller.signal,
    });
    expect(aborted.exitCode).not.toBe(0);

    await expect(
      runHostProcess({
        executable: `focuscode-command-that-does-not-exist-${process.pid}`,
        arguments: [],
        cwd: process.cwd(),
        timeoutMs: 100,
        maxOutputChars: 100,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("DockerSandbox taskLifetime mode", () => {
  it("creates the task container once and reuses it via docker exec", async () => {
    const dockerCapture = capture();
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      taskLifetime: true,
      processRunner: dockerCapture.runner,
    });
    await docker.execute({
      command: "npm install",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    await docker.execute({
      command: "npm test",
      cwd: "/repo/sub",
      workspaceRoot: "/repo",
      timeoutMs: 1000,
      signal: controller.signal,
    });
    expect(dockerCapture.invocations).toHaveLength(3);
    const create = dockerCapture.invocations[0];
    expect(create?.arguments.slice(0, 2)).toEqual(["run", "-d"]);
    expect(create?.arguments.slice(-2)).toEqual(["sleep", "infinity"]);
    const name = create?.arguments[create.arguments.indexOf("--name") + 1];
    expect(name).toMatch(/^focuscode-task-/);
    expect(dockerCapture.invocations[1]?.arguments).toEqual([
      "exec",
      "--workdir",
      "/workspace",
      name,
      "/bin/sh",
      "-lc",
      "npm install",
    ]);
    const exec = dockerCapture.invocations[2];
    expect(exec?.arguments).toEqual([
      "exec",
      "--workdir",
      "/workspace/sub",
      name,
      "/bin/sh",
      "-lc",
      "npm test",
    ]);
    expect(exec?.signal).toBe(controller.signal);
  });

  it("keeps per-command docker run --rm by default and makes dispose a no-op", async () => {
    const dockerCapture = capture();
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      processRunner: dockerCapture.runner,
    });
    await docker.execute({ command: "pwd", cwd: "/repo", workspaceRoot: "/repo", timeoutMs: 1000 });
    expect(dockerCapture.invocations[0]?.arguments.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(dockerCapture.invocations[0]?.arguments).not.toContain("-d");
    await docker.dispose();
    expect(dockerCapture.invocations).toHaveLength(1);
  });

  it("removes the task container on dispose and recreates it on the next execute", async () => {
    const dockerCapture = capture();
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      taskLifetime: true,
      processRunner: dockerCapture.runner,
    });
    await docker.execute({ command: "pwd", cwd: "/repo", workspaceRoot: "/repo", timeoutMs: 1000 });
    const first = dockerCapture.invocations[0];
    const firstName = first?.arguments[first.arguments.indexOf("--name") + 1];
    await docker.dispose();
    expect(dockerCapture.invocations[2]?.arguments).toEqual(["rm", "--force", firstName]);
    await docker.execute({ command: "pwd", cwd: "/repo", workspaceRoot: "/repo", timeoutMs: 1000 });
    const recreated = dockerCapture.invocations[3];
    expect(recreated?.arguments.slice(0, 2)).toEqual(["run", "-d"]);
    const secondName = recreated?.arguments[recreated.arguments.indexOf("--name") + 1];
    expect(secondName).toMatch(/^focuscode-task-/);
    expect(secondName).not.toBe(firstName);
    await docker.dispose();
    expect(dockerCapture.invocations[5]?.arguments).toEqual(["rm", "--force", secondName]);
  });

  it("preserves hardening flags when creating the detached container", async () => {
    const dockerCapture = capture();
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      image: `focus/image@sha256:${"a".repeat(64)}`,
      requireImageDigest: true,
      taskLifetime: true,
      processRunner: dockerCapture.runner,
    });
    await docker.execute({ command: "pwd", cwd: "/repo", workspaceRoot: "/repo", timeoutMs: 1000 });
    const args = dockerCapture.invocations[0]?.arguments ?? [];
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--cap-drop",
        "ALL",
        "--network",
        "none",
        "--pull",
        "never",
        "--user",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=256m",
        "--ipc",
        "none",
        "--log-driver",
        "none",
        "no-new-privileges=true",
      ]),
    );
  });

  it("kills a timed-out exec without destroying the task container", async () => {
    const dockerCapture = capture([{}, { timedOut: true, exitCode: null }, {}]);
    const docker = new DockerSandbox({
      workspaceRoot: "/repo",
      taskLifetime: true,
      processRunner: dockerCapture.runner,
    });
    const result = await docker.execute({
      command: "sleep 30",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 10,
    });
    expect(result.timedOut).toBe(true);
    const pkill = dockerCapture.invocations[2];
    expect(pkill?.arguments[0]).toBe("exec");
    expect(pkill?.arguments.join(" ")).toContain("pkill -f 'sleep 30'");
    expect(dockerCapture.invocations.some((i) => i.arguments[0] === "rm")).toBe(false);
    await docker.execute({
      command: "echo ok",
      cwd: "/repo",
      workspaceRoot: "/repo",
      timeoutMs: 10,
    });
    expect(dockerCapture.invocations.filter((i) => i.arguments[0] === "run")).toHaveLength(1);
  });
});
