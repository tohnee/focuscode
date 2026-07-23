import { spawn } from "node:child_process";
import { sha256Digest, type VerificationCommandResultV1 } from "@focuscode/contracts";

export interface RegisteredCommand {
  id: string;
  argv: [string, ...string[]];
  timeoutMs?: number;
}

export interface CommandRunnerOptions {
  cwd: string;
  maxOutputBytes?: number;
  baseEnvironment?: Record<string, string>;
}

export class SafeCommandRunner {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly maxOutputBytes: number;

  constructor(
    commands: RegisteredCommand[],
    private readonly options: CommandRunnerOptions,
  ) {
    for (const command of commands) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(command.id)) {
        throw new Error(`Invalid registered command id: ${command.id}`);
      }
      if (command.argv.length === 0 || command.argv.some((argument) => argument.includes("\0"))) {
        throw new Error(`Invalid argv for registered command: ${command.id}`);
      }
      if (this.commands.has(command.id))
        throw new Error(`Duplicate registered command: ${command.id}`);
      this.commands.set(command.id, command);
    }
    this.maxOutputBytes = options.maxOutputBytes ?? 256_000;
  }

  list(): RegisteredCommand[] {
    return [...this.commands.values()].map((command) => ({ ...command, argv: [...command.argv] }));
  }

  async run(commandId: string): Promise<VerificationCommandResultV1> {
    const command = this.commands.get(commandId);
    if (!command) throw new Error(`Command is not registered: ${commandId}`);
    const startedAt = Date.now();
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      CI: "1",
      ...this.options.baseEnvironment,
    };

    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0], command.argv.slice(1), {
        cwd: this.options.cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const appendBounded = (current: string, chunk: Buffer): string =>
        `${current}${chunk.toString("utf8")}`.slice(-this.maxOutputBytes);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const raw = { commandId, exitCode, stdout, stderr, timedOut };
        resolve({
          ...raw,
          durationMs: Date.now() - startedAt,
          digest: sha256Digest(raw),
        });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 500).unref();
      }, command.timeoutMs ?? 120_000);
      timer.unref();
    });
  }
}
