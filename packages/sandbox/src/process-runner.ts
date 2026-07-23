import { spawn } from "node:child_process";
import type { ProcessInvocation, ProcessRunner } from "./types.js";

export const runHostProcess: ProcessRunner = async (invocation) => {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.arguments, {
      cwd: invocation.cwd,
      env: safeEnvironment(),
      shell: false,
      stdio: [invocation.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"), invocation.maxOutputChars);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"), invocation.maxOutputChars);
    });
    if (invocation.input !== undefined) child.stdin?.end(invocation.input);
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    const onAbort = () => terminate();
    if (invocation.signal?.aborted) onAbort();
    else invocation.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, invocation.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      invocation.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      invocation.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        invocation: { executable: invocation.executable, arguments: invocation.arguments },
      });
    });
  });
};

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    NO_COLOR: process.env.NO_COLOR,
    CI: process.env.CI ?? "1",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  };
}

function appendBounded(current: string, addition: string, maximum: number): string {
  const combined = current + addition;
  if (combined.length <= maximum) return combined;
  const marker = "\n[output truncated]\n";
  return combined.slice(0, Math.max(0, maximum - marker.length)) + marker;
}
