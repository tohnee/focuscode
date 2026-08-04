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
import { realpathSync } from "node:fs";
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
    // P1-G: default to the absolute path so a PATH-injected `sandbox-exec`
    // cannot silently neutralize all containment. Callers can still override
    // for non-standard layouts.
    this.sandboxExec = options.sandboxExecBinary ?? "/usr/bin/sandbox-exec";
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async execute(command: SandboxCommand): Promise<SandboxResult> {
    assertWorkspace(command, this.workspaceRoot);
    const profile = this.buildProfile();
    // POSIX sh mode, not the user's interactive shell: under a hardened
    // seatbelt profile, zsh and bash abort (SIGABRT, exit 134) during their
    // interactive initialization while /bin/sh (sh mode) runs cleanly.
    const shell = "/bin/sh";
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
      // Probe by actually executing a trivial allow-all profile against
      // /usr/bin/true. `-h` cannot be used as the probe: modern macOS
      // (25.x) treats it as an illegal option and exits 64 (EX_USAGE) on a
      // perfectly working install, which made the auto-chain skip seatbelt
      // and fail on machines without Docker/gVisor. Running a minimal
      // profile verifies both the binary and the sandbox execution path.
      const result = await this.runner({
        executable: this.sandboxExec,
        arguments: ["-p", "(version 1)(allow default)", "/usr/bin/true"],
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
        detail: "sandbox-exec available",
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
   * Builds a seatbelt profile string:
   *  - denies everything by default (including all network access)
   *  - allows executing system binaries, the shell and the node binary
   *  - allows reads everywhere and writes ONLY inside the workspace root
   *
   * Read allowlist note: modern macOS (15+/25+) serves system libraries from
   * the dyld shared cache and synthesizes /bin, /usr, /System as firmlinks;
   * file operations are matched against their resolved vnode paths, so a
   * subpath allowlist of system directories neither compiles the right rules
   * nor stays maintainable. The containment value of this executor is write
   * isolation (untrusted commands cannot modify anything outside the
   * workspace) plus default-deny network — reads are therefore allowed
   * globally. A read-restricted executor should be Docker/gVisor.
   *
   * P1-G: all interpolated paths are escaped via `escapeSbplString` so a
   * workspace/shell/node path containing `"` or `\` cannot inject SBPL
   * rules and escape containment.
   */
  private buildProfile(): string {
    // subpath rules match the resolved vnode path, not symlinked spellings:
    // /var → /private/var and /tmp → /private/tmp, so a workspace under
    // /var/folders must be written as its realpath or every write is denied.
    const root = escapeSbplString(realpathSyncSafe(this.workspaceRoot));
    // process-exec rules must use the explicit (literal "...") form: modern
    // macOS (25.x) rejects a bare string with "illegal argument" (exit 65)
    // at profile compile time. Binaries are also resolved to their real
    // paths so an exec through a symlinked binary matches the rule.
    const shell = escapeSbplString(realpathSyncSafe("/bin/sh"));
    const nodeBin = escapeSbplString(realpathSyncSafe(process.execPath));
    return [
      "(version 1)",
      "(deny default)",
      '(allow process-exec (subpath "/bin"))',
      '(allow process-exec (subpath "/usr/bin"))',
      "(allow process-fork)",
      "(allow file-read*)",
      `(allow file-write* (subpath "${root}"))`,
      `(allow file-read* (subpath "${root}"))`,
      `(allow process-exec (literal "${nodeBin}"))`,
      `(allow process-exec (literal "${shell}"))`,
    ].join("\n");
  }
}

function assertWorkspace(command: SandboxCommand, expectedRoot: string): void {
  const root = resolve(command.workspaceRoot);
  if (root !== expectedRoot)
    throw new Error("Sandbox workspace does not match configured workspace");
  // Resolve through realpath so a symlinked cwd pointing outside the
  // workspace cannot pass the lexical check.
  const cwd = resolve(realpathSyncSafe(resolve(command.cwd)));
  const realRoot = realpathSyncSafe(root);
  const rel = relative(realRoot, cwd);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== cwd) {
    throw new Error("Sandbox command cwd escapes workspace");
  }
}

function realpathSyncSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * P1-G: Escape a path for use inside an SBPL double-quoted string. SBPL
 * strings use C-style escaping: `\` escapes the next character, and `"`
 * closes the string. A path containing `"`, `\`, or control characters
 * could otherwise inject `(allow ...)` rules and escape containment.
 * We backslash-escape `\` and `"` and drop other control characters.
 */
function escapeSbplString(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch.charCodeAt(0) < 0x20)
      continue; // strip control chars
    else out += ch;
  }
  return out;
}
