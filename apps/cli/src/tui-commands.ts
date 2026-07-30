/**
 * TUI slash-command definitions extracted from runFullScreenAgent (T2 fix).
 *
 * Each command is a thin adapter that reads from a `TuiCommandState` object
 * (the mutable closure state that previously lived inside onCommand) and
 * delegates to the agent/tui/sessions. Commands are registered into a
 * SlashCommandRegistry so the TUI's onCommand can dispatch through a single
 * `registry.dispatch(input, ctx)` call instead of a 120-line switch.
 *
 * Migration status: the commands below are the high-value, low-coupling
 * subset (status/tools/approval/model/session management). Commands that
 * touch mutable attachment state, spec engine callbacks, or mascot cheer
 * toggles will be migrated incrementally — they need richer context objects
 * and are left in tui.ts for now to avoid destabilising the TUI loop.
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
}

/**
 * The mutable state the extracted commands read from and write to. This is
 * a subset of the closure state from runFullScreenAgent; commands that need
 * more state (attachments, cheer toggle, etc.) stay in tui.ts until they
 * are migrated.
 */
export interface TuiCommandState {
  agent: TuiCommandAgent;
  sessions: TuiCommandSessions;
  tui: TuiCommandTui;
  activeModel: { provider: string; model: string };
  changeModel: (spec: string) => Promise<{ provider: string; model: string }>;
  cwd: string;
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
}
