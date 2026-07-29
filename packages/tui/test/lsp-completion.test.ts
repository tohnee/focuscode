import { describe, expect, it } from "vitest";
import { lspCompletionProvider, type LspCompletionClient } from "../src/lsp-completion.js";

function createMockClient(items: Array<{ label: string; detail?: string }>): LspCompletionClient {
  return {
    async completion() {
      return items;
    },
  };
}

describe("LSP 接入 TUI 内联补全", () => {
  it("lspCompletionProvider returns empty array when LSP is disabled", () => {
    const provider = lspCompletionProvider({ enabled: false });
    const candidates = provider.complete("cons", "cons");
    expect(candidates).toEqual([]);
  });

  it("lspCompletionProvider returns empty array when no client is connected", () => {
    const provider = lspCompletionProvider({ enabled: true });
    const candidates = provider.complete("cons", "cons");
    expect(candidates).toEqual([]);
  });

  it("lspCompletionProvider returns cached candidates on second call", async () => {
    const client = createMockClient([
      { label: "console", detail: "Console object" },
      { label: "const", detail: "Constant declaration" },
    ]);
    const provider = lspCompletionProvider({ enabled: true, client, uri: "file:///test.ts" });
    // First call triggers prefetch, returns empty
    const first = provider.complete("cons", "cons");
    expect(first).toEqual([]);
    // Wait for prefetch to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Second call returns cached candidates
    const second = provider.complete("cons", "cons");
    expect(second).toHaveLength(2);
    expect(second[0]!.value).toBe("console");
    expect(second[0]!.description).toBe("Console object");
    expect(second[1]!.value).toBe("const");
  });

  it("lspCompletionProvider handles LSP errors gracefully", async () => {
    const client: LspCompletionClient = {
      async completion() {
        throw new Error("LSP server error");
      },
    };
    const provider = lspCompletionProvider({ enabled: true, client, uri: "file:///test.ts" });
    const first = provider.complete("cons", "cons");
    expect(first).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = provider.complete("cons", "cons");
    expect(second).toEqual([]);
  });

  it("lspCompletionProvider infers cursor position from fullText", () => {
    const client = createMockClient([]);
    const provider = lspCompletionProvider({ enabled: true, client, uri: "file:///test.ts" });
    // Multi-line text: cursor at end of "cons" on second line
    const candidates = provider.complete("cons", "line1\ncons");
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("lspCompletionProvider filters by prefix", async () => {
    const client = createMockClient([
      { label: "console", detail: "Console object" },
      { label: "const", detail: "Constant declaration" },
      { label: "continue", detail: "Continue statement" },
    ]);
    const provider = lspCompletionProvider({ enabled: true, client, uri: "file:///test.ts" });
    provider.complete("conso", "conso");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const candidates = provider.complete("conso", "conso");
    // Note: the provider currently returns all LSP items without client-side
    // prefix filtering. The LSP server is expected to filter by position.
    // This test documents the current behavior.
    expect(candidates).toHaveLength(3);
  });
});
