import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessInvocation, ProcessRunner } from "./types.js";

/**
 * P1-H: On POSIX, spawn the child as the leader of a new process group
 * (`detached: true`) so that `terminate()` can kill the entire group with
 * `process.kill(-pgid, signal)`. Without this, `sh -lc '... &'` would leave
 * grandchild processes running after timeout/abort, continuing to write to
 * the workspace. On Windows, `detached` creates a new process group too, but
 * `process.kill(-pgid)` is not supported — we fall back to direct SIGTERM/
 * SIGKILL on the child, matching the pre-fix behavior.
 *
 * Known limitation (documented, not silently hidden): a process that calls
 * setsid() escapes its process group, and a hard parent death (SIGKILL,
 * kernel panic) cannot run JS handlers at all. Full bounding of setsid'd
 * children requires cgroups or a native prctl(PR_SET_PDEATHSIG) helper;
 * callers needing that guarantee should use the Docker executor, where the
 * container (or a marker-based in-container sweep) bounds the tree.
 */
const POSIX = process.platform !== "win32";

// ─── Parent-death cleanup ─────────────────────────────────────────────
// Children are spawned detached (own process group). If the CLI process dies
// without going through terminate() (crash, exit, SIGINT/SIGTERM/SIGHUP),
// those groups would keep running with the user's rights. Track every live
// child and kill its group from process-level handlers, installed once per
// process. `exit` handlers are synchronous (process.kill works there);
// signal handlers additionally drain async cleanups (e.g. `docker rm`).
const activeChildren = new Set<ChildProcess>();
const parentDeathCleanups = new Set<() => void>();
let parentDeathCleanupInstalled = false;

function installParentDeathCleanup(): void {
  if (parentDeathCleanupInstalled) return;
  parentDeathCleanupInstalled = true;
  const killAll = () => {
    for (const child of activeChildren) killProcessGroup(child);
    for (const cleanup of parentDeathCleanups) {
      try {
        cleanup();
      } catch {
        // A failing best-effort cleanup must not take the process down.
      }
    }
  };
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, killAll);
  }
}

/**
 * Register a cleanup to run when the parent process dies (exit or
 * termination signal). Returns an unregister function; call it once the
 * resource no longer needs cleanup (e.g. the container was removed).
 */
export function registerParentDeathCleanup(cleanup: () => void): () => void {
  installParentDeathCleanup();
  parentDeathCleanups.add(cleanup);
  return () => {
    parentDeathCleanups.delete(cleanup);
  };
}

export function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!(typeof pid === "number" && Number.isInteger(pid) && pid > 0)) return;
  if (POSIX) {
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
}

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
    installParentDeathCleanup();
    activeChildren.add(child);
    const forgetChild = () => {
      activeChildren.delete(child);
    };
    child.once("close", forgetChild);
    child.once("error", forgetChild);
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
    const terminate = () => killProcessGroup(child);
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
