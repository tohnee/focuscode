/**
 * TUI slash-command definitions extracted from runFullScreenAgent (T2 fix).
 *
 * Each command is a thin adapter that reads from a `TuiCommandState` object
 * (the mutable closure state that previously lived inside onCommand) and
 * delegates to the agent/tui/sessions. Commands are registered into a
 * SlashCommandRegistry so the TUI's onCommand can dispatch through a single
 * `registry.dispatch(input, ctx)` call instead of a 120-line switch.
 *
 * Step 1: status, tools, approval, model, new, resume, fork, sessions.
 * Step 2: export, reload, skills, undo, cost, diagnostics, vim, palette,
 *         search, layout, todopanel, character, skin, init.
 * Remaining (need richer mutable context): image, cheer, todo, mcp, skill,
 * tree. These will be migrated once their context shape is finalised.
 */
import type { ApprovalMode } from "@focuscode/action-domain";
import type { SlashCommandRegistry } from "./slash-command-registry.js";

/** Minimal agent surface needed by the extracted commands. */
export interface TuiCommandAgent {
  status(): Promise<{ model: string; provider: string; approval: string }>;
  toolDefinitions(): Array<{ name: string; effect: string; description: string }>;
  changeApproval(mode: ApprovalMode): void;
  newSession(name?: string): Promise<string>;
  switchSession(idOrPrefix: string): Promise<string>;
  forkSession(name?: string): Promise<string>;
  snapshot(): {
    sessionId: string;
    activeLeafId: string;
    entries: Array<{ entryId: string; message: { role: string; content: string } }>;
  };
  undoCheckpoint(): Promise<string>;
}

/** Minimal sessions surface needed by the extracted commands. */
export interface TuiCommandSessions {
  list(cwd: string): Promise<Array<{ sessionId: string; name?: string; preview: string }>>;
}

/** Minimal TUI surface needed by the extracted commands. */
export interface TuiCommandTui {
  setApproval(mode: ApprovalMode): void;
  setModel(label: string): void;
  setSession(sessionId: string): void;
  showToast(message: string, kind?: "info" | "warning" | "error"): void;
  setVimEnabled(enabled: boolean): void;
  getVimState(): unknown;
  openPalette(): void;
  openSearch(): void;
  updateSearchQuery(query: string): void;
}

/** Minimal extensions surface needed by the extracted commands. */
export interface TuiCommandExtensions {
  reload(): Promise<unknown[]>;
}

/** Minimal resources surface needed by the extracted commands. */
export interface TuiCommandResources {
  skills: Array<{ name: string; description: string; content: string }>;
}

/**
 * The state the extracted commands read from and write to. Fields beyond
 * step 1 (extensions, resources, formatSessionCost, etc.) are required by
 * step 2 commands; commands needing mutable attachment/cheer state still
 * live in tui.ts.
 */
export interface TuiCommandState {
  agent: TuiCommandAgent;
  sessions: TuiCommandSessions;
  tui: TuiCommandTui;
  extensions: TuiCommandExtensions;
  resources: TuiCommandResources;
  activeModel: { provider: string; model: string };
  changeModel: (spec: string) => Promise<{ provider: string; model: string }>;
  cwd: string;
  // step 2 fields
  sessionCost: number;
  sessionBudget: number | undefined;
  companion: unknown;
  diagnosticsEnabled: boolean;
  formatSessionCost: (cost: number, budget: number | undefined, companion: unknown) => string;
  scaffoldFocuscodeProject: (cwd: string) => Promise<string>;
  describeMascots: () => string;
  describeSkins: (args: string) => string;
  runLayoutSubcommand: (tui: TuiCommandTui, args: string) => string;
  runTodoPanelSubcommand: (tui: TuiCommandTui, args: string) => string;
  runTodoSubcommand: (agent: TuiCommandAgent, args: string) => Promise<string>;
  exportSessionHtml: (
    snapshot: ReturnType<TuiCommandAgent["snapshot"]>,
    cwd: string,
    args: string,
  ) => Promise<string>;
}

const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto-edit", "full-auto", "deny"];

function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Register the extracted TUI commands into the given registry. The registry
 * is mutated in place so callers can layer these commands on top of any
 * pre-existing registrations.
 */
export function buildTuiCommandRegistry(
  registry: SlashCommandRegistry,
  state: TuiCommandState,
): void {
  // ─── Step 1 commands ────────────────────────────────────────────────

  registry.register({
    name: "status",
    description: "Show agent status as JSON",
    modes: ["tui", "interactive"],
    execute: async () => JSON.stringify(await state.agent.status(), null, 2),
  });

  registry.register({
    name: "tools",
    description: "List enabled tools",
    modes: ["tui", "interactive"],
    execute: async () =>
      state.agent
        .toolDefinitions()
        .map((tool) => tool.name.padEnd(16) + tool.effect.padEnd(8) + tool.description)
        .join("\n"),
  });

  registry.register({
    name: "approval",
    description: "Show or set approval mode (ask|auto-edit|full-auto|deny)",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      const mode = ctx.args.trim();
      if (!mode) return "Usage: /approval ask|auto-edit|full-auto|deny";
      if (!isApprovalMode(mode)) return "Usage: /approval ask|auto-edit|full-auto|deny";
      state.agent.changeApproval(mode);
      state.tui.setApproval(mode);
      state.tui.showToast("Approval: " + mode, mode === "deny" ? "warning" : "info");
      return "Approval mode: " + mode;
    },
  });

  registry.register({
    name: "model",
    description: "Show or change the active model",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      if (!ctx.args) return state.activeModel.provider + "/" + state.activeModel.model;
      const next = await state.changeModel(ctx.args);
      state.activeModel = next;
      state.tui.setModel(next.provider + "/" + next.model);
      state.tui.showToast("Model: " + next.provider + "/" + next.model, "info");
      return "Model changed to " + next.provider + "/" + next.model;
    },
  });

  registry.register({
    name: "new",
    description: "Start a new session",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      const session = await state.agent.newSession(ctx.args || undefined);
      state.tui.setSession(session);
      return "Started session " + session;
    },
  });

  registry.register({
    name: "resume",
    description: "Switch to an existing session",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      if (!ctx.args) return "Usage: /resume <session-id>";
      const session = await state.agent.switchSession(ctx.args);
      state.tui.setSession(session);
      return "Switched to " + session;
    },
  });

  registry.register({
    name: "fork",
    description: "Fork the current session into a new branch",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      const session = await state.agent.forkSession(ctx.args || undefined);
      state.tui.setSession(session);
      return "Forked into " + session;
    },
  });

  registry.register({
    name: "sessions",
    description: "List all sessions for this workspace",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      const list = await state.sessions.list(ctx.cwd);
      return list
        .map(
          (session) =>
            session.sessionId + " · " + (session.name ?? "unnamed") + " · " + session.preview,
        )
        .join("\n");
    },
  });

  // ─── Step 2 commands ────────────────────────────────────────────────

  registry.register({
    name: "export",
    description: "Export the current session as HTML",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      const path = await state.exportSessionHtml(state.agent.snapshot(), ctx.cwd, ctx.args);
      return "Exported " + path;
    },
  });

  registry.register({
    name: "reload",
    description: "Reload extensions",
    modes: ["tui", "interactive"],
    execute: async () => {
      const reloaded = await state.extensions.reload();
      return "Reloaded " + reloaded.length + " extension(s).";
    },
  });

  registry.register({
    name: "skills",
    description: "List discovered skills",
    modes: ["tui", "interactive"],
    execute: async () =>
      state.resources.skills.length
        ? state.resources.skills
            .map((skill) => "/" + skill.name + " — " + skill.description)
            .join("\n")
        : "No skills discovered.",
  });

  registry.register({
    name: "undo",
    description: "Restore the last checkpoint",
    modes: ["tui", "interactive"],
    execute: async () => state.agent.undoCheckpoint(),
  });

  registry.register({
    name: "cost",
    description: "Show session cost",
    modes: ["tui", "interactive"],
    execute: async () =>
      state.formatSessionCost(state.sessionCost, state.sessionBudget, state.companion),
  });

  registry.register({
    name: "diagnostics",
    description: "Toggle diagnostics on/off",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      const arg = ctx.args.trim();
      if (arg === "on") state.diagnosticsEnabled = true;
      else if (arg === "off") state.diagnosticsEnabled = false;
      else state.diagnosticsEnabled = !state.diagnosticsEnabled;
      return "Diagnostics " + (state.diagnosticsEnabled ? "on" : "off") + ".";
    },
  });

  registry.register({
    name: "vim",
    description: "Toggle vim mode",
    modes: ["tui", "interactive"],
    execute: async () => {
      const enabled = state.tui.getVimState() !== undefined;
      state.tui.setVimEnabled(!enabled);
      return enabled ? "Vim mode off." : "Vim mode on (NORMAL).";
    },
  });

  registry.register({
    name: "palette",
    description: "Open the command palette",
    modes: ["tui", "interactive"],
    execute: async () => {
      state.tui.openPalette();
      return undefined;
    },
  });

  registry.register({
    name: "search",
    description: "Open search (optionally with a query)",
    modes: ["tui", "interactive"],
    execute: async (ctx) => {
      state.tui.openSearch();
      if (ctx.args) state.tui.updateSearchQuery(ctx.args);
      return undefined;
    },
  });

  registry.register({
    name: "layout",
    description: "Change the TUI layout",
    modes: ["tui", "interactive"],
    execute: async (ctx) => state.runLayoutSubcommand(state.tui, ctx.args),
  });

  registry.register({
    name: "todopanel",
    description: "Toggle or control the todo panel",
    modes: ["tui", "interactive"],
    execute: async (ctx) => state.runTodoPanelSubcommand(state.tui, ctx.args),
  });

  registry.register({
    name: "character",
    description: "Describe available mascots",
    modes: ["tui", "interactive"],
    execute: async () => state.describeMascots(),
  });

  registry.register({
    name: "skin",
    description: "Describe or select a skin",
    modes: ["tui", "interactive"],
    execute: async (ctx) => state.describeSkins(ctx.args),
  });

  registry.register({
    name: "init",
    description: "Scaffold a focuscode project in the cwd",
    modes: ["tui", "interactive"],
    execute: async (ctx) => state.scaffoldFocuscodeProject(ctx.cwd),
  });
}
