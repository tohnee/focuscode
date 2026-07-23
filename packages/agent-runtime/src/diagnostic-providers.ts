/**
 * Language-agnostic diagnostic providers.
 *
 * Each provider detects whether the workspace is a project for its language
 * (e.g. tsconfig.json for TypeScript, pyproject.toml for Python) and runs the
 * appropriate linter/type-checker. Providers are fail-quiet: missing toolchain,
 * spawn failures and timeouts all resolve to `{ ran: false }`, never throw.
 *
 * The agent runtime iterates `BUILTIN_DIAGNOSTIC_PROVIDERS` and collects output
 * from every provider that reports a positive detection. This module does not
 * depend on any external language toolchain at import time — tools are probed
 * at runtime via `spawnSync` so a missing `ruff`/`go`/`cargo` is a no-op.
 */
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./tools.js";

export interface DiagnosticProviderResult {
  ran: boolean;
  output?: string | undefined;
}

export interface DiagnosticProvider {
  /** Stable identifier used in config and diagnostics labels, e.g. "typescript". */
  readonly id: string;
  /** Human-readable label for the diagnostics banner, e.g. "tsc --noEmit". */
  readonly label: string;
  /** True when the workspace looks like a project for this provider's language. */
  detect(cwd: string): Promise<boolean>;
  /** Run diagnostics; never throws. */
  run(cwd: string, timeoutMs?: number): Promise<DiagnosticProviderResult>;
}

const MAX_OUTPUT_CHARS = 8_000;

/** TypeScript provider: `tsc --noEmit --pretty false`. */
export function createTypeScriptProvider(): DiagnosticProvider {
  const tscCache = new Map<string, string | undefined>();

  async function resolveTsc(cwd: string): Promise<string | undefined> {
    if (tscCache.has(cwd)) return tscCache.get(cwd);
    const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
    let found: string | undefined;
    const local = join(cwd, "node_modules", ".bin", executable);
    if (await exists(local)) {
      found = local;
    } else {
      try {
        const probe = spawnSync(executable, ["--version"], { stdio: "ignore" });
        if (probe.status === 0) found = executable;
      } catch {
        found = undefined;
      }
    }
    tscCache.set(cwd, found);
    return found;
  }

  return {
    id: "typescript",
    label: "tsc --noEmit",
    async detect(cwd) {
      return exists(join(cwd, "tsconfig.json"));
    },
    async run(cwd, timeoutMs = 30_000) {
      if (!(await exists(join(cwd, "tsconfig.json")))) return { ran: false };
      const tsc = await resolveTsc(cwd);
      if (!tsc) return { ran: false };
      try {
        const result = await runProcess(tsc, ["--noEmit", "--pretty", "false"], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/** Python provider: `ruff check --output-format concise`. */
export function createPythonProvider(): DiagnosticProvider {
  return {
    id: "python",
    label: "ruff check",
    async detect(cwd) {
      return (
        (await exists(join(cwd, "pyproject.toml"))) ||
        (await exists(join(cwd, "setup.py"))) ||
        (await exists(join(cwd, "requirements.txt")))
      );
    },
    async run(cwd, timeoutMs = 30_000) {
      const detected =
        (await exists(join(cwd, "pyproject.toml"))) ||
        (await exists(join(cwd, "setup.py"))) ||
        (await exists(join(cwd, "requirements.txt")));
      if (!detected) return { ran: false };
      const ruff = await resolveBinary("ruff", cwd);
      if (!ruff) return { ran: false };
      try {
        const result = await runProcess(ruff, ["check", "--output-format", "concise", "."], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/** Go provider: `go vet ./...`. */
export function createGoProvider(): DiagnosticProvider {
  return {
    id: "go",
    label: "go vet",
    async detect(cwd) {
      return exists(join(cwd, "go.mod"));
    },
    async run(cwd, timeoutMs = 30_000) {
      if (!(await exists(join(cwd, "go.mod")))) return { ran: false };
      const go = await resolveBinary("go", cwd);
      if (!go) return { ran: false };
      try {
        const result = await runProcess(go, ["vet", "./..."], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/** Rust provider: `cargo check --message-format short`. */
export function createRustProvider(): DiagnosticProvider {
  return {
    id: "rust",
    label: "cargo check",
    async detect(cwd) {
      return exists(join(cwd, "Cargo.toml"));
    },
    async run(cwd, timeoutMs = 60_000) {
      if (!(await exists(join(cwd, "Cargo.toml")))) return { ran: false };
      const cargo = await resolveBinary("cargo", cwd);
      if (!cargo) return { ran: false };
      try {
        const result = await runProcess(cargo, ["check", "--message-format", "short"], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/**
 * All built-in diagnostic providers in priority order. Composition roots and
 * tests may mutate this list via `registerDiagnosticProvider`, but the list is
 * intentionally exported as a mutable array so the agent runtime can iterate
 * the latest set without re-importing.
 */
export const BUILTIN_DIAGNOSTIC_PROVIDERS: DiagnosticProvider[] = [
  createTypeScriptProvider(),
  createPythonProvider(),
  createGoProvider(),
  createRustProvider(),
];

async function resolveBinary(name: string, cwd: string): Promise<string | undefined> {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const local = join(cwd, "node_modules", ".bin", executable);
  if (await exists(local)) return local;
  try {
    const probe = spawnSync(executable, ["--version"], { stdio: "ignore" });
    // Some tools exit 1 from `--version` on certain flags; treat 0 and 1 as
    // "binary present" to avoid false negatives (e.g. ruff with no config).
    if (probe.status === 0 || probe.status === 1) return executable;
  } catch {
    // fall through
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
