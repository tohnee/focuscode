/**
 * Shared slash-command registry for all CLI surfaces (interactive, TUI, RPC).
 *
 * Each surface historically implemented its own command dispatch (interactive.ts,
 * tui.ts, rpc.ts) with inconsistent naming (e.g. `/new` vs `new_session`).
 * This registry provides a single source of truth: commands are declared once
 * with their name, aliases, applicable modes, and handler; each surface
 * dispatches through the same registry and filters by its own mode.
 *
 * Design goals:
 *   - Eliminate command name drift across surfaces (C4 fix).
 *   - Make commands testable without a running agent/TUI.
 *   - Support aliases (e.g. `quit` → `exit`).
 *   - Let handlers return `string` (display), `undefined` (no output), or `void`
 *     (side-effect only) uniformly.
 */

/** Which CLI surface the command is available on. */
export type SlashCommandMode = "interactive" | "tui" | "rpc";

/**
 * Context passed to a slash-command handler. Surfaces extend this with their
 * own references (agent, sessions, extensions, etc.) via casting.
 */
export interface SlashCommandContext {
  /** Working directory of the agent. */
  cwd: string;
  /** Raw argument string (everything after the command name, trimmed). */
  args: string;
  /** Full input line (e.g. `/model kimi/k2`) for surfaces that need it. */
  rawInput?: string;
}

/**
 * Result of a slash-command handler.
 *   - `string` → display to the user.
 *   - `undefined` / `void` → no output (side-effect only or silent success).
 */
export type SlashCommandResult = string | undefined | void;

/** A single slash-command definition. */
export interface SlashCommand {
  /** Primary name (without leading `/`). Must be unique in the registry. */
  name: string;
  /** Alternative names that dispatch to the same handler. */
  aliases?: string[];
  /** One-line description for help and completion. */
  description: string;
  /** Which surfaces this command is available on. */
  modes: SlashCommandMode[];
  /**
   * Execute the command. The context includes parsed `args` (the remainder
   * of the input after the command name) and the agent's `cwd`.
   */
  execute(context: SlashCommandContext): Promise<SlashCommandResult> | SlashCommandResult;
}

/**
 * Mutable registry of slash commands. Create one per CLI process (or per
 * surface), register commands, then dispatch by parsed input.
 */
export interface SlashCommandRegistry {
  /** Register a command. Throws on duplicate name or alias. */
  register(command: SlashCommand): void;
  /** Look up a command by name or alias. Returns undefined if not found. */
  resolve(name: string): SlashCommand | undefined;
  /** Dispatch a parsed input line (e.g. `model kimi/k2`). */
  dispatch(input: string, context: SlashCommandContext): Promise<SlashCommandResult>;
  /** List all registered commands (for help). */
  list(): readonly SlashCommand[];
  /** List commands available on a given surface (for completion). */
  listForMode(mode: SlashCommandMode): readonly SlashCommand[];
}

export function createSlashCommandRegistry(): SlashCommandRegistry {
  const byName = new Map<string, SlashCommand>();

  function register(command: SlashCommand): void {
    const names = [command.name, ...(command.aliases ?? [])];
    for (const name of names) {
      if (byName.has(name)) {
        throw new Error(`Slash command already registered: ${name}`);
      }
    }
    for (const name of names) {
      byName.set(name, command);
    }
  }

  function resolve(name: string): SlashCommand | undefined {
    return byName.get(name);
  }

  async function dispatch(
    input: string,
    context: SlashCommandContext,
  ): Promise<SlashCommandResult> {
    const trimmed = input.trim();
    const spaceIndex = trimmed.search(/\s/);
    const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)!;
    const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
    const command = byName.get(name);
    if (!command) return undefined;
    return command.execute({ ...context, args, ...(context.rawInput ? {} : { rawInput: input }) });
  }

  function list(): readonly SlashCommand[] {
    const seen = new Set<SlashCommand>();
    for (const command of byName.values()) {
      seen.add(command);
    }
    return [...seen];
  }

  function listForMode(mode: SlashCommandMode): readonly SlashCommand[] {
    return list().filter((command) => command.modes.includes(mode));
  }

  return { register, resolve, dispatch, list, listForMode };
}

/**
 * Parse a raw slash-command input line into name + args.
 * Exported for surfaces that need to inspect the name before dispatching
 * (e.g. to handle `/exit` specially before the registry sees it).
 */
export function parseSlashInput(input: string): { name: string; args: string } {
  const trimmed = input.trim();
  const spaceIndex = trimmed.search(/\s/);
  const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)!;
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
  return { name, args };
}
