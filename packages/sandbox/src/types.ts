export type SandboxKind = "host" | "docker" | "gvisor" | "vm" | "seatbelt" | "auto";

export interface SandboxLimits {
  memory: string;
  cpus: number;
  pids: number;
  maxOutputChars: number;
}

export interface SandboxCommand {
  command: string;
  cwd: string;
  workspaceRoot: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  backend: Exclude<SandboxKind, "auto">;
  invocation?: { executable: string; arguments: string[] };
}

export interface SandboxHealth {
  available: boolean;
  backend: Exclude<SandboxKind, "auto">;
  detail: string;
  isolation?: "none" | "container" | "kernel" | "vm";
}

export interface SandboxExecutor {
  readonly kind: Exclude<SandboxKind, "auto">;
  execute(command: SandboxCommand): Promise<SandboxResult>;
  health(): Promise<SandboxHealth>;
  dispose?(): Promise<void>;
}

export interface DockerSandboxOptions {
  workspaceRoot: string;
  image?: string;
  runtime?: string;
  network?: "none" | "bridge";
  readOnlyWorkspace?: boolean;
  requireImageDigest?: boolean;
  taskLifetime?: boolean;
  limits?: Partial<SandboxLimits>;
  dockerBinary?: string;
  processRunner?: ProcessRunner;
}

export interface VmSandboxOptions {
  workspaceRoot: string;
  host: string;
  remoteWorkspace: string;
  sshBinary?: string;
  identityFile?: string;
  port?: number;
  strictHostKeyChecking?: boolean;
  processRunner?: ProcessRunner;
  limits?: Partial<SandboxLimits>;
}

export interface HostSandboxOptions {
  workspaceRoot: string;
  limits?: Partial<SandboxLimits>;
  processRunner?: ProcessRunner;
}

export interface ProcessInvocation {
  executable: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
  input?: string;
}

export type ProcessRunner = (
  invocation: ProcessInvocation,
) => Promise<Omit<SandboxResult, "backend">>;

export interface SandboxConfig {
  kind: SandboxKind;
  workspaceRoot: string;
  image?: string;
  network?: "none" | "bridge";
  readOnlyWorkspace?: boolean;
  requireImageDigest?: boolean;
  allowHostFallback?: boolean;
  vm?: Omit<VmSandboxOptions, "workspaceRoot">;
  limits?: Partial<SandboxLimits>;
}
