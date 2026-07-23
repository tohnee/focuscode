/**
 * macOS seatbelt sandbox executor.
 *
 * Uses `sandbox-exec` (the macOS seatbelt profile language) to run untrusted
 * Bash under OS-level containment without requiring Docker/gVisor. The profile
 * allows reading system binaries and libraries, executing the configured shell
 * and the current node binary, and read/write access only inside the workspace
 * root. All other file writes are denied by default.
 *
 * On non-darwin platforms `health()` resolves to `{ available: false }`
 * (fail-quiet), allowing the factory to fall back to another executor.
 */
import { relative, resolve, sep } from "node:path";
import { runHostProcess } from "./process-runner.js";
import type {
  ProcessRunner,
  SandboxCommand,
  SandboxExecutor,
  SandboxHealth,
  SandboxLimits,
  SandboxResult,
} from "./types.js";

const DEFAULT_LIMITS: SandboxLimits = {
  memory: "2g",
  cpus: 2,
  pids: 256,
  maxOutputChars: 80_000,
};

export interface SeatbeltSandboxOptions {
  workspaceRoot: string;
  /** Override platform for testing; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  processRunner?: ProcessRunner;
  sandboxExecBinary?: string;
  limits?: Partial<SandboxLimits>;
}

export class SeatbeltSandbox implements SandboxExecutor {
  readonly kind = "seatbelt" as const;
  private readonly workspaceRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly runner: ProcessRunner;
  private readonly sandboxExec: string;
  private readonly limits: SandboxLimits;

  constructor(options: SeatbeltSandboxOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.platform = options.platform ?? process.platform;
    this.runner = options.processRunner ?? runHostProcess;
    this.sandboxExec = options.sandboxExecBinary ?? "sandbox-exec";
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async execute(command: SandboxCommand): Promise<SandboxResult> {
    assertWorkspace(command, this.workspaceRoot);
    const profile = this.buildProfile();
    const shell = process.env.SHELL ?? "/bin/sh";
    const argumentsValue = ["-p", profile, "--", shell, "-lc", command.command];
    return {
      ...(await this.runner({
        executable: this.sandboxExec,
        arguments: argumentsValue,
        cwd: resolve(command.cwd),
        timeoutMs: command.timeoutMs,
        maxOutputChars: this.limits.maxOutputChars,
        ...(command.signal ? { signal: command.signal } : {}),
      })),
      backend: this.kind,
    };
  }

  async health(): Promise<SandboxHealth> {
    if (this.platform !== "darwin") {
      return {
        available: false,
        backend: this.kind,
        detail: "seatbelt is macOS-only",
      };
    }
    try {
      const result = await this.runner({
        executable: this.sandboxExec,
        arguments: ["--version"],
        cwd: this.workspaceRoot,
        timeoutMs: 5_000,
        maxOutputChars: 1_000,
      });
      if (result.exitCode !== 0) {
        return {
          available: false,
          backend: this.kind,
          detail: result.stderr || "sandbox-exec unavailable",
        };
      }
      return {
        available: true,
        backend: this.kind,
        detail: result.stdout.trim() || "sandbox-exec available",
        isolation: "kernel",
      };
    } catch (error) {
      return {
        available: false,
        backend: this.kind,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Builds a seatbelt profile string that:
   *  - denies everything by default
   *  - explicitly denies all file writes (overridden by more specific allows)
   *  - allows executing and reading system binaries (/usr/bin, /bin)
   *  - allows reading system libraries (/usr/lib)
   *  - allows read/write only inside the workspace root
   *  - allows executing the node binary and the configured shell
   */
  private buildProfile(): string {
    const root = this.workspaceRoot;
    const shell = process.env.SHELL ?? "/bin/sh";
    const nodeBin = process.execPath;
    return [
      "(version 1)",
      "(deny default)",
      "(deny file-write*)",
      '(allow process-exec (subpath "/usr/bin"))',
      '(allow process-exec (subpath "/bin"))',
      '(allow file-read* (subpath "/usr/bin"))',
      '(allow file-read* (subpath "/bin"))',
      '(allow file-read* (subpath "/usr/lib"))',
      `(allow file-write* (subpath "${root}"))`,
      `(allow file-read* (subpath "${root}"))`,
      `(allow process-exec "${nodeBin}")`,
      `(allow process-exec "${shell}")`,
    ].join("\n");
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
