/**
 * Diagnostics façade.
 *
 * Backward-compatible `shouldRunDiagnostics` / `runDiagnostics` keep the
 * original single-result contract used by agent.ts. The new `runDiagnosticsAll`
 * iterates the built-in provider registry and returns one entry per detecting
 * provider, optionally filtered by provider id. Custom providers can be added
 * at runtime via `registerDiagnosticProvider`.
 */
import { BUILTIN_DIAGNOSTIC_PROVIDERS, type DiagnosticProvider } from "./diagnostic-providers.js";
import { maybeRegisterLspProviders } from "./lsp-diagnostic-provider.js";

// Register LSP-backed diagnostic providers when FOCUSCODE_LSP=1 is set.
// This runs once at module load; spawn-based providers stay the default.
maybeRegisterLspProviders(process.env);

export interface DiagnosticsResult {
  ran: boolean;
  output?: string | undefined;
}

export interface MultiDiagnosticsResult {
  providerId: string;
  label: string;
  ran: boolean;
  output?: string | undefined;
}

/**
 * True when any registered diagnostic provider detects the workspace as a
 * project for its language. Kept for backward compatibility with agent.ts.
 */
export async function shouldRunDiagnostics(cwd: string): Promise<boolean> {
  for (const provider of BUILTIN_DIAGNOSTIC_PROVIDERS) {
    if (await provider.detect(cwd)) return true;
  }
  return false;
}

/**
 * Run the first detecting provider (backward-compatible: returns a single
 * result like the old tsc-only path). Prefer `runDiagnosticsAll` for
 * multi-language workspaces.
 */
export async function runDiagnostics(cwd: string, timeoutMs = 30_000): Promise<DiagnosticsResult> {
  for (const provider of BUILTIN_DIAGNOSTIC_PROVIDERS) {
    if (!(await provider.detect(cwd))) continue;
    const result = await provider.run(cwd, timeoutMs);
    if (result.ran) return result;
  }
  return { ran: false };
}

/**
 * Run every provider that detects the workspace, optionally filtered by an
 * explicit provider id list. Returns one entry per detecting provider.
 */
export async function runDiagnosticsAll(
  cwd: string,
  timeoutMs = 30_000,
  providerFilter?: string[],
): Promise<MultiDiagnosticsResult[]> {
  const providers = providerFilter
    ? BUILTIN_DIAGNOSTIC_PROVIDERS.filter((p) => providerFilter.includes(p.id))
    : BUILTIN_DIAGNOSTIC_PROVIDERS;
  const results: MultiDiagnosticsResult[] = [];
  for (const provider of providers) {
    if (!(await provider.detect(cwd))) continue;
    const result = await provider.run(cwd, timeoutMs);
    results.push({
      providerId: provider.id,
      label: provider.label,
      ran: result.ran,
      ...(result.output !== undefined ? { output: result.output } : {}),
    });
  }
  return results;
}

/**
 * Register a custom diagnostic provider at runtime. Composition roots or
 * extensions can use this to add language support without modifying the
 * built-in list. Idempotent: re-registering the same id is a no-op.
 */
export function registerDiagnosticProvider(provider: DiagnosticProvider): void {
  if (!BUILTIN_DIAGNOSTIC_PROVIDERS.some((p) => p.id === provider.id)) {
    BUILTIN_DIAGNOSTIC_PROVIDERS.push(provider);
  }
}
