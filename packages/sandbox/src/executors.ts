import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { runHostProcess } from "./process-runner.js";
import type {
  DockerSandboxOptions,
  HostSandboxOptions,
  ProcessRunner,
  SandboxCommand,
  SandboxExecutor,
  SandboxHealth,
  SandboxLimits,
  SandboxResult,
  VmSandboxOptions,
} from "./types.js";

const DEFAULT_LIMITS: SandboxLimits = {
  memory: "2g",
  cpus: 2,
  pids: 256,
  maxOutputChars: 80_000,
};

export class HostSandbox implements SandboxExecutor {
  readonly kind = "host" as const;
  private readonly runner: ProcessRunner;
  private readonly limits: SandboxLimits;
  private readonly workspaceRoot: string;

  constructor(options: HostSandboxOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.runner = options.processRunner ?? runHostProcess;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async execute(command: SandboxCommand): Promise<SandboxResult> {
    assertWorkspace(command, this.workspaceRoot);
    const shell = shellInvocation(command.command);
    return {
      ...(await this.runner({
        ...shell,
        cwd: resolve(command.cwd),
        timeoutMs: command.timeoutMs,
        maxOutputChars: this.limits.maxOutputChars,
        ...(command.signal ? { signal: command.signal } : {}),
      })),
      backend: this.kind,
    };
  }

  async health(): Promise<SandboxHealth> {
    return {
      available: true,
      backend: this.kind,
      detail: "Host execution has no OS isolation",
      isolation: "none",
    };
  }
}

export class DockerSandbox implements SandboxExecutor {
  readonly kind: "docker" | "gvisor";
  private readonly workspaceRoot: string;
  private readonly image: string;
  private readonly runtime: string | undefined;
  private readonly network: "none" | "bridge";
  private readonly readOnlyWorkspace: boolean;
  private readonly requireImageDigest: boolean;
  private readonly taskLifetime: boolean;
  private readonly limits: SandboxLimits;
  private readonly docker: string;
  private readonly runner: ProcessRunner;
  private taskContainer: string | undefined;

  constructor(options: DockerSandboxOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.image = options.image ?? "node:22-bookworm";
    this.runtime = options.runtime;
    this.kind = options.runtime === "runsc" ? "gvisor" : "docker";
    this.network = options.network ?? "none";
    this.readOnlyWorkspace = options.readOnlyWorkspace ?? false;
    this.requireImageDigest = options.requireImageDigest ?? false;
    this.taskLifetime = options.taskLifetime ?? false;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.docker = options.dockerBinary ?? "docker";
    this.runner = options.processRunner ?? runHostProcess;
    if (/[,\r\n]/.test(this.workspaceRoot)) {
      throw new Error("Docker workspace path may not contain commas or line breaks");
    }
    if (this.requireImageDigest && !/@sha256:[a-f0-9]{64}$/i.test(this.image)) {
      throw new Error("Docker sandbox image must be pinned by sha256 digest");
    }
  }

  async execute(command: SandboxCommand): Promise<SandboxResult> {
    assertWorkspace(command, this.workspaceRoot);
    const relativeCwd = relative(this.workspaceRoot, resolve(command.cwd));
    const containerCwd = relativeCwd
      ? `/workspace/${relativeCwd.split(sep).join("/")}`
      : "/workspace";
    if (this.taskLifetime) return this.executeInTaskContainer(command, containerCwd);
    const containerName = "focuscode-" + process.pid + "-" + randomUUID().slice(0, 12);
    const argumentsValue = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--init",
      ...(this.requireImageDigest ? ["--pull", "never"] : []),
      "--workdir",
      containerCwd,
      ...this.containerArguments(),
      this.image,
      "/bin/sh",
      "-lc",
      command.command,
    ];
    const result = await this.runner({
      executable: this.docker,
      arguments: argumentsValue,
      cwd: this.workspaceRoot,
      timeoutMs: command.timeoutMs,
      maxOutputChars: this.limits.maxOutputChars,
      ...(command.signal ? { signal: command.signal } : {}),
    });
    if (result.timedOut || command.signal?.aborted) {
      await this.runner({
        executable: this.docker,
        arguments: ["rm", "--force", containerName],
        cwd: this.workspaceRoot,
        timeoutMs: 10_000,
        maxOutputChars: 4_000,
      }).catch(() => undefined);
    }
    return {
      ...result,
      backend: this.kind,
    };
  }

  async dispose(): Promise<void> {
    if (!this.taskContainer) return;
    const containerName = this.taskContainer;
    this.taskContainer = undefined;
    await this.runner({
      executable: this.docker,
      arguments: ["rm", "--force", containerName],
      cwd: this.workspaceRoot,
      timeoutMs: 10_000,
      maxOutputChars: 4_000,
    }).catch(() => undefined);
  }

  private containerArguments(): string[] {
    const mountMode = this.readOnlyWorkspace ? "readonly" : "rw";
    return [
      "--mount",
      `type=bind,source=${this.workspaceRoot},target=/workspace,${mountMode}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=256m",
      "--network",
      this.network,
      "--ipc",
      "none",
      "--log-driver",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      String(this.limits.pids),
      "--memory",
      this.limits.memory,
      "--cpus",
      String(this.limits.cpus),
      ...(process.platform !== "win32" && typeof process.getuid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`]
        : []),
      ...(this.runtime ? ["--runtime", this.runtime] : []),
      "--env",
      "HOME=/tmp",
      "--env",
      "CI=1",
    ];
  }

  private async ensureContainer(): Promise<string> {
    if (this.taskContainer) return this.taskContainer;
    const containerName = `focuscode-task-${process.pid}-${randomUUID().slice(0, 12)}`;
    const result = await this.runner({
      executable: this.docker,
      arguments: [
        "run",
        "-d",
        "--name",
        containerName,
        "--init",
        ...(this.requireImageDigest ? ["--pull", "never"] : []),
        "--workdir",
        "/workspace",
        ...this.containerArguments(),
        this.image,
        "sleep",
        "infinity",
      ],
      cwd: this.workspaceRoot,
      timeoutMs: 30_000,
      maxOutputChars: 4_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Docker task container failed to start: ${result.stderr || result.stdout || "unknown error"}`,
      );
    }
    this.taskContainer = containerName;
    return containerName;
  }

  private async executeInTaskContainer(
    command: SandboxCommand,
    containerCwd: string,
  ): Promise<SandboxResult> {
    const containerName = await this.ensureContainer();
    const result = await this.runner({
      executable: this.docker,
      arguments: [
        "exec",
        "--workdir",
        containerCwd,
        containerName,
        "/bin/sh",
        "-lc",
        command.command,
      ],
      cwd: this.workspaceRoot,
      timeoutMs: command.timeoutMs,
      maxOutputChars: this.limits.maxOutputChars,
      ...(command.signal ? { signal: command.signal } : {}),
    });
    if (result.timedOut || command.signal?.aborted) {
      const pattern = command.command.slice(0, 40).replaceAll("'", `'\\''`);
      await this.runner({
        executable: this.docker,
        arguments: ["exec", containerName, "sh", "-c", `pkill -f '${pattern}' || true`],
        cwd: this.workspaceRoot,
        timeoutMs: 10_000,
        maxOutputChars: 4_000,
      }).catch(() => undefined);
    }
    return {
      ...result,
      backend: this.kind,
    };
  }

  async health(): Promise<SandboxHealth> {
    try {
      const argumentsValue = ["info", "--format", "{{json .ServerVersion}}"];
      const result = await this.runner({
        executable: this.docker,
        arguments: argumentsValue,
        cwd: this.workspaceRoot,
        timeoutMs: 10_000,
        maxOutputChars: 4_000,
      });
      if (result.exitCode !== 0) {
        return {
          available: false,
          backend: this.kind,
          detail: result.stderr || "Docker unavailable",
        };
      }
      if (this.runtime) {
        const runtime = await this.runner({
          executable: this.docker,
          arguments: ["info", "--format", "{{json .Runtimes}}"],
          cwd: this.workspaceRoot,
          timeoutMs: 10_000,
          maxOutputChars: 8_000,
        });
        if (!runtime.stdout.includes(this.runtime)) {
          return {
            available: false,
            backend: this.kind,
            detail: `Docker runtime ${this.runtime} is not installed`,
          };
        }
      }
      if (this.requireImageDigest) {
        const image = await this.runner({
          executable: this.docker,
          arguments: ["image", "inspect", "--format", "{{.Id}}", this.image],
          cwd: this.workspaceRoot,
          timeoutMs: 10_000,
          maxOutputChars: 4_000,
        });
        if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}\s*$/i.test(image.stdout)) {
          return {
            available: false,
            backend: this.kind,
            detail: image.stderr || "Pinned Docker image is not available locally",
            isolation: this.kind === "gvisor" ? "kernel" : "container",
          };
        }
      }
      return {
        available: true,
        backend: this.kind,
        detail: `Docker image ${this.image}`,
        isolation: this.kind === "gvisor" ? "kernel" : "container",
      };
    } catch (error) {
      return {
        available: false,
        backend: this.kind,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class SshVmSandbox implements SandboxExecutor {
  readonly kind = "vm" as const;
  private readonly workspaceRoot: string;
  private readonly runner: ProcessRunner;
  private readonly limits: SandboxLimits;
  private readonly ssh: string;

  constructor(private readonly options: VmSandboxOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.runner = options.processRunner ?? runHostProcess;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.ssh = options.sshBinary ?? "ssh";
    if (!/^[A-Za-z0-9._@:-]+$/.test(options.host)) throw new Error("Invalid VM SSH host");
    if (!options.remoteWorkspace.startsWith("/"))
      throw new Error("VM remoteWorkspace must be absolute");
  }

  async execute(command: SandboxCommand): Promise<SandboxResult> {
    assertWorkspace(command, this.workspaceRoot);
    const relativeCwd = relative(this.workspaceRoot, resolve(command.cwd));
    const remoteCwd = relativeCwd
      ? `${this.options.remoteWorkspace}/${relativeCwd.split(sep).join("/")}`
      : this.options.remoteWorkspace;
    const timeoutSeconds = Math.max(1, Math.ceil(command.timeoutMs / 1_000));
    const remote = `cd -- ${shellQuote(remoteCwd)} && env -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin CI=1 timeout --signal=TERM --kill-after=5s ${timeoutSeconds}s /bin/sh -lc ${shellQuote(command.command)}`;
    const argumentsValue = [
      "-o",
      "BatchMode=yes",
      "-o",
      `StrictHostKeyChecking=${this.options.strictHostKeyChecking === false ? "accept-new" : "yes"}`,
      ...(this.options.port ? ["-p", String(this.options.port)] : []),
      ...(this.options.identityFile ? ["-i", this.options.identityFile] : []),
      "--",
      this.options.host,
      remote,
    ];
    return {
      ...(await this.runner({
        executable: this.ssh,
        arguments: argumentsValue,
        cwd: this.workspaceRoot,
        timeoutMs: command.timeoutMs,
        maxOutputChars: this.limits.maxOutputChars,
        ...(command.signal ? { signal: command.signal } : {}),
      })),
      backend: this.kind,
    };
  }

  async health(): Promise<SandboxHealth> {
    try {
      const result = await this.runner({
        executable: this.ssh,
        arguments: [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          ...(this.options.port ? ["-p", String(this.options.port)] : []),
          ...(this.options.identityFile ? ["-i", this.options.identityFile] : []),
          "--",
          this.options.host,
          `test -d ${shellQuote(this.options.remoteWorkspace)}`,
        ],
        cwd: this.workspaceRoot,
        timeoutMs: 10_000,
        maxOutputChars: 4_000,
      });
      return {
        available: result.exitCode === 0,
        backend: this.kind,
        detail:
          result.exitCode === 0 ? `VM workspace ${this.options.remoteWorkspace}` : result.stderr,
        isolation: "vm",
      };
    } catch (error) {
      return {
        available: false,
        backend: this.kind,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function assertWorkspace(command: SandboxCommand, expectedRoot: string): void {
  const root = resolve(command.workspaceRoot);
  if (root !== expectedRoot)
    throw new Error("Sandbox workspace does not match configured workspace");
  const cwd = resolve(command.cwd);
  const rel = relative(root, cwd);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== cwd) {
    throw new Error("Sandbox command cwd escapes workspace");
  }
}

function shellInvocation(command: string): { executable: string; arguments: string[] } {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { executable: process.env.SHELL ?? "/bin/sh", arguments: ["-lc", command] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
