import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIAGNOSTIC_PROVIDERS,
  createTypeScriptProvider,
} from "../src/diagnostic-providers.js";

// The agent-runtime package root contains tsconfig.json; the repo root does not.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("diagnostic providers", () => {
  it("creates a TypeScript provider with correct id and label", () => {
    const provider = createTypeScriptProvider();
    expect(provider.id).toBe("typescript");
    expect(provider.label).toBe("tsc --noEmit");
  });

  it("detects TypeScript project by tsconfig.json", async () => {
    const provider = createTypeScriptProvider();
    expect(await provider.detect(packageRoot)).toBe(true);
  });

  it("does not detect non-TypeScript project", async () => {
    const provider = createTypeScriptProvider();
    expect(await provider.detect(tmpdir())).toBe(false);
  });

  it("registers all built-in providers with stable ids", () => {
    const ids = BUILTIN_DIAGNOSTIC_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("typescript");
    expect(ids).toContain("python");
    expect(ids).toContain("go");
    expect(ids).toContain("rust");
  });

  it("runs TypeScript diagnostics and returns ran:true on the package", async () => {
    const provider = createTypeScriptProvider();
    const result = await provider.run(packageRoot, 60_000);
    expect(result.ran).toBe(true);
    // output is a string when tsc reports errors, undefined when the project is clean.
    if (result.output !== undefined) {
      expect(typeof result.output).toBe("string");
    }
  });

  it("python provider detects pyproject.toml", async () => {
    const python = BUILTIN_DIAGNOSTIC_PROVIDERS.find((p) => p.id === "python")!;
    const root = await mkdirFixture("diag-python");
    try {
      await writeFile(join(root, "pyproject.toml"), "[project]\nname = 'x'\n");
      expect(await python.detect(root)).toBe(true);
      // No ruff installed in the fixture → run() is fail-quiet.
      const result = await python.run(root, 5_000);
      expect(result.ran).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("go provider detects go.mod", async () => {
    const go = BUILTIN_DIAGNOSTIC_PROVIDERS.find((p) => p.id === "go")!;
    const root = await mkdirFixture("diag-go");
    try {
      await writeFile(join(root, "go.mod"), "module example.com/x\n\ngo 1.22\n");
      expect(await go.detect(root)).toBe(true);
      const result = await go.run(root, 5_000);
      // go may or may not be installed in the sandbox; both outcomes are valid.
      expect(typeof result.ran).toBe("boolean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rust provider detects Cargo.toml", async () => {
    const rust = BUILTIN_DIAGNOSTIC_PROVIDERS.find((p) => p.id === "rust")!;
    const root = await mkdirFixture("diag-rust");
    try {
      await writeFile(join(root, "Cargo.toml"), "[package]\nname = 'x'\nversion = '0.1.0'\n");
      expect(await rust.detect(root)).toBe(true);
      const result = await rust.run(root, 5_000);
      expect(typeof result.ran).toBe("boolean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("providers are fail-quiet on missing toolchain", async () => {
    const root = await mkdirFixture("diag-missing-tool");
    try {
      // tsconfig.json present but no tsc reachable from this empty dir.
      await writeFile(join(root, "tsconfig.json"), "{}");
      const provider = createTypeScriptProvider();
      const result = await provider.run(root, 5_000);
      // tsc may resolve via global PATH in CI; just assert the contract shape.
      expect(typeof result.ran).toBe("boolean");
      if (!result.ran) {
        expect(result.output).toBeUndefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkdirFixture(name: string): Promise<string> {
  const dir = join(tmpdir(), `focuscode-${name}-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("diagnostics integration with providers", () => {
  it("shouldRunDiagnostics returns true when any provider detects", async () => {
    const { shouldRunDiagnostics } = await import("../src/diagnostics.js");
    // The agent-runtime package root has tsconfig.json.
    expect(await shouldRunDiagnostics(packageRoot)).toBe(true);
  });

  it("runDiagnostics returns ran:true for a TypeScript project", async () => {
    const { runDiagnostics } = await import("../src/diagnostics.js");
    const result = await runDiagnostics(packageRoot, 60_000);
    expect(result.ran).toBe(true);
  });

  it("runDiagnosticsAll returns results keyed by provider id", async () => {
    const { runDiagnosticsAll } = await import("../src/diagnostics.js");
    const results = await runDiagnosticsAll(packageRoot, 60_000);
    expect(results.length).toBeGreaterThan(0);
    const tsResult = results.find((r) => r.providerId === "typescript");
    expect(tsResult).toBeDefined();
    expect(tsResult!.ran).toBe(true);
    expect(typeof tsResult!.label).toBe("string");
  });

  it("runDiagnosticsAll filters by provider ids when given", async () => {
    const { runDiagnosticsAll } = await import("../src/diagnostics.js");
    const results = await runDiagnosticsAll(packageRoot, 60_000, ["typescript"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.providerId).toBe("typescript");
  });

  it("runDiagnosticsAll returns empty for unknown provider filter", async () => {
    const { runDiagnosticsAll } = await import("../src/diagnostics.js");
    const results = await runDiagnosticsAll(packageRoot, 60_000, ["nonexistent"]);
    expect(results).toEqual([]);
  });

  it("runDiagnosticsAll returns empty when no provider detects", async () => {
    const { runDiagnosticsAll } = await import("../src/diagnostics.js");
    const results = await runDiagnosticsAll(tmpdir(), 5_000);
    expect(results).toEqual([]);
  });

  it("registerDiagnosticProvider adds a custom provider", async () => {
    const { registerDiagnosticProvider, runDiagnosticsAll } = await import("../src/diagnostics.js");
    const custom: {
      id: string;
      label: string;
      detect: () => Promise<boolean>;
      run: () => Promise<{ ran: boolean; output?: string }>;
    } = {
      id: "custom-test-lang",
      label: "custom-checker",
      detect: async () => true,
      run: async () => ({ ran: true, output: "custom warning" }),
    };
    registerDiagnosticProvider(custom);
    try {
      const results = await runDiagnosticsAll(packageRoot, 5_000, ["custom-test-lang"]);
      expect(results).toHaveLength(1);
      expect(results[0]!.providerId).toBe("custom-test-lang");
      expect(results[0]!.output).toBe("custom warning");
    } finally {
      // Best-effort cleanup: the registry is a mutable array; remove our entry.
      const { BUILTIN_DIAGNOSTIC_PROVIDERS } = await import("../src/diagnostic-providers.js");
      const idx = BUILTIN_DIAGNOSTIC_PROVIDERS.findIndex((p) => p.id === "custom-test-lang");
      if (idx >= 0) BUILTIN_DIAGNOSTIC_PROVIDERS.splice(idx, 1);
    }
  });
});
