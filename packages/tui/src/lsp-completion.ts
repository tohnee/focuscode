import type { CompletionCandidate, CompletionProvider } from "./completion.js";

/**
 * LSP completion item shape, matching `LspClient.completion()` return type.
 */
export interface LspCompletionItem {
  label: string;
  detail?: string;
}

/**
 * Minimal LSP client interface for completion. Matches the subset of
 * `LspClient` needed by the TUI completion provider.
 */
export interface LspCompletionClient {
  completion(params: {
    textDocument: { uri: string };
    position: { line: number; character: number };
  }): Promise<LspCompletionItem[]>;
}

/**
 * Options for the LSP-backed completion provider. The provider is fail-quiet:
 * when LSP is disabled or no server is connected, it returns an empty array
 * so other providers (slash commands, file paths) still fire.
 */
export interface LspCompletionProviderOptions {
  /** Whether LSP completion is enabled. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Connected LSP client instance. When undefined, the provider returns
   * empty results. The client must implement `textDocument/completion`.
   */
  client?: LspCompletionClient;
  /**
   * Document URI for completion requests. Defaults to the current file.
   */
  uri?: string;
  /**
   * Current cursor position (0-based line and character). When omitted,
   * the provider infers position from the end of the prefix.
   */
  position?: { line: number; character: number };
}

/**
 * Completion provider that surfaces LSP `textDocument/completion` candidates.
 *
 * This bridges the gap between FocusCode's LSP diagnostic capability (already
 * implemented in `packages/agent-runtime/src/lsp-client.ts`) and the TUI's
 * inline completion system (`packages/tui/src/completion.ts`). The provider
 * is fail-quiet: when LSP is unavailable, it returns an empty array so the
 * built-in slash-command and file-path providers still fire.
 *
 * Architecture boundary: this module lives in the TUI package and only
 * depends on the `CompletionProvider` interface from `completion.js`. The
 * actual LSP client is injected, keeping the TUI decoupled from
 * `agent-runtime`'s LSP implementation.
 *
 * The provider uses a fire-and-forget prefetch pattern: on the first
 * `complete()` call for a given prefix, it triggers an async LSP request
 * and returns an empty array. On subsequent calls for the same prefix,
 * it returns the cached results. This works around the synchronous
 * `CompletionProvider` interface while still delivering LSP candidates
 * with minimal latency.
 *
 * @example
 * ```ts
 * const lspProvider = lspCompletionProvider({
 *   enabled: true,
 *   client: lspClient,
 *   uri: "file:///src/index.ts",
 * });
 * const providers = [slashCommandProvider(), lspProvider, filePathProvider()];
 * ```
 */
export function lspCompletionProvider(
  options: LspCompletionProviderOptions = {},
): CompletionProvider {
  const enabled = options.enabled ?? true;
  const cache = new Map<string, CompletionCandidate[]>();
  const pending = new Map<string, Promise<void>>();

  return {
    complete(prefix, fullText) {
      if (!enabled || !options.client) return [];
      const uri = options.uri ?? "file:///untitled";
      const key = `${uri}:${prefix}`;

      // Return cached results when available.
      const cached = cache.get(key);
      if (cached) return cached;

      // Fire-and-forget prefetch: trigger async LSP request and cache the
      // result for the next completion call with the same prefix.
      if (!pending.has(key)) {
        const position = options.position ?? inferPosition(fullText, prefix);
        const promise = options
          .client!.completion({
            textDocument: { uri },
            position,
          })
          .then((items) => {
            const candidates: CompletionCandidate[] = items.map((item) => ({
              value: item.label,
              ...(item.detail ? { description: item.detail } : {}),
            }));
            cache.set(key, candidates);
            pending.delete(key);
          })
          .catch(() => {
            cache.set(key, []);
            pending.delete(key);
          });
        pending.set(key, promise);
      }

      // First call for this prefix returns empty; cached results appear on
      // subsequent calls (typically within the same completion session).
      return [];
    },
  };
}

/** Infer cursor position from fullText and prefix (0-based). */
function inferPosition(fullText: string, prefix: string): { line: number; character: number } {
  const lastNewline = fullText.lastIndexOf("\n");
  const line = fullText.split("\n").length - 1;
  const lineStart = lastNewline >= 0 ? lastNewline + 1 : 0;
  const character = fullText.length - lineStart - prefix.length;
  return { line, character: Math.max(0, character) };
}
