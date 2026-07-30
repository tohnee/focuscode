import { spawn } from "node:child_process";
import type { ProcessInvocation, ProcessRunner } from "./types.js";

/**
 * P1-H: On POSIX, spawn the child as the leader of a new process group
 * (`detached: true`) so that `terminate()` can kill the entire group with
 * `process.kill(-pgid, signal)`. Without this, `sh -lc '... &'` would leave
 * grandchild processes running after timeout/abort, continuing to write to
 * the workspace. On Windows, `detached` creates a new process group too, but
 * `process.kill(-pgid)` is not supported — we fall back to direct SIGTERM/
 * SIGKILL on the child, matching the pre-fix behavior.
 */
const POSIX = process.platform !== "win32";

export const runHostProcess: ProcessRunner = async (invocation) => {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.arguments, {
      cwd: invocation.cwd,
      env: safeEnvironment(),
      shell: false,
      stdio: [invocation.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      // P1-H: new process group so we can kill the whole tree.
      detached: POSIX,
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
      // P1-H: kill the entire process group on POSIX so grandchildren
      // (e.g. `sh -lc 'sleep 60 &'`) are reaped. On Windows we can only
      // kill the direct child; callers needing full-tree cleanup on
      // Windows should use the Docker executor.
      const pid = child.pid;
      if (POSIX && typeof pid === "number") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // Process group may already be gone; fall back to direct kill.
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 1_000).unref();
      } else {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }
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
