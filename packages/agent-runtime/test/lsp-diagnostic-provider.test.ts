import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLspTypeScriptProvider } from "../src/lsp-diagnostic-provider.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp-server.mjs");

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "focuscode-lsp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
});

describe("createLspTypeScriptProvider — DiagnosticProvider over LSP", () => {
  it("detect returns true when tsconfig.json exists", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const provider = createLspTypeScriptProvider({ command: process.execPath, args: [fixture] });
    expect(await provider.detect(dir)).toBe(true);
  });

  it("detect returns false when tsconfig.json is absent", async () => {
    const dir = await makeTempDir();
    const provider = createLspTypeScriptProvider({ command: process.execPath, args: [fixture] });
    expect(await provider.detect(dir)).toBe(false);
  });

  it("run returns { ran: true, output } when the LSP server reports diagnostics", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    // The fake LSP server publishes a diagnostic when the text contains "error".
    await writeFile(join(dir, "broken.ts"), "const x = 'error';\n");
    const provider = createLspTypeScriptProvider({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 10_000,
    });
    const result = await provider.run(dir, 15_000);
    expect(result.ran).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output).toContain("broken.ts");
    expect(result.output).toContain("error");
  });

  it("run returns { ran: true } with no output when the project is clean", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    await writeFile(join(dir, "clean.ts"), "const x = 1;\n");
    const provider = createLspTypeScriptProvider({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 10_000,
    });
    const result = await provider.run(dir, 15_000);
    expect(result.ran).toBe(true);
    // No diagnostics -> output is undefined (consistent with spawn-based providers).
    expect(result.output).toBeUndefined();
  });

  it("run returns { ran: false } when the LSP server command is unavailable", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const provider = createLspTypeScriptProvider({
      command: "definitely-not-a-real-lsp-server-xyz",
      args: [],
    });
    const result = await provider.run(dir, 5_000);
    expect(result.ran).toBe(false);
  });

  it("run returns { ran: false } when tsconfig.json is absent", async () => {
    const dir = await makeTempDir();
    const provider = createLspTypeScriptProvider({ command: process.execPath, args: [fixture] });
    const result = await provider.run(dir, 5_000);
    expect(result.ran).toBe(false);
  });

  it("run returns { ran: false } when the LSP server exits immediately", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const provider = createLspTypeScriptProvider({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    });
    const result = await provider.run(dir, 10_000);
    expect(result.ran).toBe(false);
  });

  it("opens files in nested directories, not just the top level", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "nested.ts"), "const y = 'error';\n");
    const provider = createLspTypeScriptProvider({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 10_000,
    });
    const result = await provider.run(dir, 15_000);
    expect(result.ran).toBe(true);
    expect(result.output).toContain("nested.ts");
  });

  it("id and label are stable identifiers", () => {
    const provider = createLspTypeScriptProvider({ command: process.execPath, args: [fixture] });
    expect(provider.id).toBe("typescript-lsp");
    expect(provider.label).toContain("LSP");
  });

  it("respects maxFiles to avoid opening huge projects", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "tsconfig.json"), "{}");
    // Create more files than maxFiles; the provider should only open the first N.
    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, `file${i}.ts`), `const x${i} = 'error';\n`);
    }
    const provider = createLspTypeScriptProvider({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 10_000,
      maxFiles: 2,
    });
    const result = await provider.run(dir, 15_000);
    expect(result.ran).toBe(true);
    // Output should contain at most 2 file references (the first 2 opened).
    const mentions = (result.output ?? "").match(/file\d+\.ts/g) ?? [];
    expect(mentions.length).toBeLessThanOrEqual(2);
  });
});
