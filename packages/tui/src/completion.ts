export interface CompletionCandidate {
  value: string;
  description?: string;
}

export interface CompletionProvider {
  complete(prefix: string, fullText: string): CompletionCandidate[];
}

export interface CompletionState {
  candidates: CompletionCandidate[];
  index: number;
}

/**
 * Built-in slash commands offered by the FocusCode TUI. The CLI registers
 * `slashCommandProvider()` as one of its completion providers so users get
 * inline Tab completion for these commands in the editor.
 */
export const TUI_SLASH_COMMANDS: readonly CompletionCandidate[] = [
  { value: "/help", description: "list available commands" },
  { value: "/history", description: "show recent prompts" },
  { value: "/clear", description: "clear the transcript" },
  { value: "/character", description: "switch mascot character" },
  { value: "/skin", description: "manage mascot skins (builtin | import | export)" },
  { value: "/init", description: "scaffold project instructions / skills" },
  { value: "/undo", description: "undo the last assistant turn" },
  { value: "/cost", description: "show session cost summary" },
  { value: "/todo", description: "manage todos (add | done | clear)" },
  { value: "/mcp", description: "manage MCP servers (list | reload)" },
  { value: "/diagnostics", description: "toggle diagnostics (on | off)" },
];

/**
 * Completion provider that surfaces the built-in slash commands. Only suggests
 * when the prefix starts with `/` and the cursor is on the same line as the
 * prefix (so we don't compete with mid-text completions).
 */
export function slashCommandProvider(): CompletionProvider {
  return {
    complete(prefix, fullText) {
      if (!prefix.startsWith("/")) return [];
      // The completion machinery passes the word before the cursor; ensure the
      // full text actually starts with the prefix on the current line so we
      // don't fire inside e.g. a pasted code block.
      const lastNewline = fullText.lastIndexOf("\n");
      const line = lastNewline >= 0 ? fullText.slice(lastNewline + 1) : fullText;
      if (!line.startsWith(prefix)) return [];
      return TUI_SLASH_COMMANDS.filter((candidate) => candidate.value.startsWith(prefix));
    },
  };
}

/** Ask every provider and merge the answers, deduplicated by value, first answer wins. */
export function collectCompletions(
  providers: readonly CompletionProvider[],
  prefix: string,
  fullText: string,
  limit = 50,
): CompletionCandidate[] {
  const seen = new Set<string>();
  const collected: CompletionCandidate[] = [];
  for (const provider of providers) {
    let candidates: CompletionCandidate[];
    try {
      candidates = provider.complete(prefix, fullText);
    } catch {
      continue;
    }
    for (const candidate of candidates ?? []) {
      if (!candidate?.value || seen.has(candidate.value)) continue;
      seen.add(candidate.value);
      collected.push({
        value: candidate.value,
        ...(candidate.description ? { description: candidate.description } : {}),
      });
      if (collected.length >= limit) return collected;
    }
  }
  return collected;
}
