/**
 * LSP-backed diagnostic provider for TypeScript.
 *
 * Adapts `LspClient` into the existing `DiagnosticProvider` interface so
 * the agent runtime keeps the same `diagnostics.ts` orchestration. This
 * provider is registered behind the `FOCUSCODE_LSP=1` feature flag so the
 * spawn-based providers remain the default until LSP is battle-tested.
 *
 * Fail-quiet: any LSP handshake failure, missing server, or timeout
 * resolves to `{ ran: false }`, allowing the caller to fall back to the
 * spawn-based TypeScript provider.
 */
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BUILTIN_DIAGNOSTIC_PROVIDERS,
  type DiagnosticProvider,
  type DiagnosticProviderResult,
} from "./diagnostic-providers.js";
import { LspClient, type LspDiagnostic } from "./lsp-client.js";

export interface LspTypeScriptProviderOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 50;
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".turbo",
  "coverage",
]);

const SEVERITY_LABELS: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function createLspTypeScriptProvider(
  options: LspTypeScriptProviderOptions,
): DiagnosticProvider {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    id: "typescript-lsp",
    label: "TypeScript LSP",
    async detect(cwd) {
      return exists(join(cwd, "tsconfig.json"));
    },
    async run(cwd, runTimeoutMs = timeoutMs): Promise<DiagnosticProviderResult> {
      if (!(await exists(join(cwd, "tsconfig.json")))) return { ran: false };
      const client = new LspClient({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.env ? { env: options.env } : {}),
        timeoutMs: runTimeoutMs,
      });
      const connected = await client.connect();
      if (!connected) return { ran: false };
      try {
        const files = await collectTypeScriptFiles(cwd, maxFiles);
        if (files.length === 0) return { ran: true };
        const allDiagnostics: Array<{ file: string; diag: LspDiagnostic }> = [];
        for (const filePath of files) {
          const text = await readFile(filePath, "utf8").catch(() => "");
          if (text.length === 0) continue;
          const uri = pathToFileURL(filePath).toString();
          await client.didOpen({ uri, languageId: "typescript", text });
          const diags = await client.diagnostics(uri);
          for (const diag of diags) {
            if (diag.severity === undefined || diag.severity <= 2) {
              allDiagnostics.push({ file: relative(cwd, filePath), diag });
            }
          }
        }
        if (allDiagnostics.length === 0) return { ran: true };
        const output = allDiagnostics
          .map(({ file, diag }) => {
            const severity = SEVERITY_LABELS[diag.severity ?? 1] ?? "error";
            const line = diag.range.start.line + 1;
            const col = diag.range.start.character + 1;
            return `${file}(${line},${col}): ${severity}: ${diag.message}`;
          })
          .join("\n");
        return { ran: true, output };
      } catch {
        return { ran: false };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

async function collectTypeScriptFiles(root: string, maxFiles: number): Promise<string[]> {
  const results: string[] = [];
  await walk(root, root, results, maxFiles);
  return results;
}

async function walk(root: string, dir: string, results: string[], maxFiles: number): Promise<void> {
  if (results.length >= maxFiles) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= maxFiles) return;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(root, fullPath, results, maxFiles);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      // Skip declaration files — they are ambient and rarely the source of
      // actionable diagnostics.
      if (entry.name.endsWith(".d.ts")) continue;
      results.push(fullPath);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Registers LSP-backed diagnostic providers into the built-in list when
 * `FOCUSCODE_LSP=1` is set and the TypeScript LSP server command is
 * configured via `FOCUSCODE_LSP_TYPESCRIPT_COMMAND`.
 *
 * This is called once at module load from `diagnostics.ts`. The
 * spawn-based providers remain the default; LSP providers are only added
 * when explicitly opted in. Idempotent: re-calls do not duplicate entries.
 */
export function maybeRegisterLspProviders(env: NodeJS.ProcessEnv): void {
  if (env.FOCUSCODE_LSP !== "1") return;
  const command = env.FOCUSCODE_LSP_TYPESCRIPT_COMMAND;
  if (!command) return;
  const args = env.FOCUSCODE_LSP_TYPESCRIPT_ARGS
    ? env.FOCUSCODE_LSP_TYPESCRIPT_ARGS.split(/\s+/).filter(Boolean)
    : undefined;
  const id = "typescript-lsp";
  if (BUILTIN_DIAGNOSTIC_PROVIDERS.some((p) => p.id === id)) return;
  BUILTIN_DIAGNOSTIC_PROVIDERS.push(
    createLspTypeScriptProvider({
      command,
      ...(args ? { args } : {}),
    }),
  );
}
