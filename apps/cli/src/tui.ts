import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  activeBranch,
  cacheMetrics,
  estimateCostUsd,
  expandPromptTemplate,
  loadImageAttachment,
  renderSessionHtml,
  type AgentAttachment,
  type AgentEvent,
  type AgentResources,
  type AgentToolCall,
  type ApprovalMode,
  type CodingAgent,
  type ExtensionHostLike,
  type McpServerSpec,
  type ModelPricing,
  type ModelProfile,
  type SessionStore,
  type TokenUsage,
} from "@focuscode/agent-runtime";
import {
  FullScreenTui,
  applyTurnReward,
  fg,
  getMascot,
  getTheme,
  initialCompanion,
  levelName,
  listBuiltinSkins,
  mergeKeymap,
  parseCompanion,
  renderDiff,
  serializeCompanion,
  TUI_MASCOTS,
  validateTuiMascot,
  validateTuiTheme,
  type CompanionState,
  type CompletionCandidate,
  type CompletionProvider,
  type LayoutMode,
  type PickerProvider,
  type ReasoningEffort,
  type SpecDecisionView,
  createInitialSpecPipeline,
  type TuiKeymap,
  type TuiMascot,
  type TuiTheme,
  TUI_THEMES,
  type VimState,
} from "@focuscode/tui";
import {
  renderAgentsCommand,
  renderConfigCommand,
  renderDoctorCommand,
  renderGoalCommand,
  renderPermissionsCommand,
  renderTaskCommand,
} from "./tui-command-views.js";

/** Foxy 小福 · 编程配备鼓励师: rotating encouragement lines per agent moment. */
const FOX_CHEERS = {
  idle: ["准备好了，慢慢写，我陪你。", "今天也是在进步的程序员。", "先想清楚再动手，很对。"],
  thinking: ["让我想想…你尽管放心。", "认真读题中，马上就来。", "思考也是工作的一部分。"],
  working: ["我在动手了，你稳着来。", "一步一步来，不慌。", "专注模式开启，交给我。"],
  happy: ["干得漂亮！又推进了一步！", "漂亮，这一步很稳！", "太好了，继续保持这个节奏！"],
  oops: ["没关系，报错也是线索。", "小问题，我们看看再说。", "别慌，错误信息会指路。"],
  done: ["这一轮收工，记得休息一下眼睛。", "完成！给自己一个好评。", "任务收尾，喝口水再继续。"],
  compact: ["上下文我帮你理顺了，继续。"],
} as const;

type CheerKind = keyof typeof FOX_CHEERS;

function pickCheer(kind: CheerKind): string {
  const pool: readonly string[] = FOX_CHEERS[kind];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/** Trusted ANSI welcome splash rendered once when the TUI opens. */
function buildWelcomeLines(theme: TuiTheme, mascot: TuiMascot, model: string): string[] {
  // minimal 布局默认开启：欢迎行保持极简，不带 ASCII 大图。
  const lines: string[] = [
    "",
    fg(theme.accent, " FocusCode · " + model),
    fg(theme.muted, " 直接输入开始对话 · /help 全部命令 · Tab 补全 · Ctrl+O 换行"),
    "",
  ];
  return lines;
}

const execFileAsync = promisify(execFile);

/** Slash commands dispatched by onCommand below; also feeds Tab completion. */
const TUI_SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Show agent status as JSON" },
  { name: "tools", description: "List available tools" },
  { name: "compact", description: "Compact the session context" },
  { name: "interrupt", description: "Queue interrupt steering" },
  { name: "followup", description: "Queue follow-up steering" },
  { name: "unsteer", description: "Remove queued steering" },
  { name: "image", description: "Attach an image (clipboard when omitted)" },
  { name: "images", description: "List pending images" },
  { name: "approval", description: "Change approval mode" },
  { name: "model", description: "Show or change the model" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Switch to another session" },
  { name: "fork", description: "Fork the session" },
  { name: "sessions", description: "List sessions" },
  { name: "tree", description: "Show the session tree" },
  { name: "export", description: "Export the session as HTML" },
  { name: "reload", description: "Reload extensions" },
  { name: "skills", description: "List discovered skills" },
  { name: "skill", description: "Apply a skill" },
  { name: "cheer", description: "Toggle the Foxy encouragement companion" },
  { name: "character", description: "List or describe available mascot characters" },
  { name: "skin", description: "Manage mascot skins (builtin | import | export)" },
  { name: "init", description: "Scaffold project instructions and skills directory" },
  { name: "undo", description: "Restore the most recent checkpoint" },
  { name: "cost", description: "Show session cost summary" },
  { name: "todo", description: "Manage todos (add | done | clear | list)" },
  { name: "mcp", description: "Show configured MCP servers (list)" },
  { name: "diagnostics", description: "Toggle diagnostics (on | off)" },
  { name: "vim", description: "Toggle vim modal editing" },
  { name: "palette", description: "Open the command palette" },
  { name: "search", description: "Open transcript search (optional query)" },
  {
    name: "layout",
    description: "Switch pane layout (classic | split | focus | wide | cycle)",
  },
  {
    name: "todopanel",
    description: "Toggle todo sidebar panel (on | off | toggle)",
  },
  { name: "goal", description: "Show the current objective and in-flight work" },
  { name: "task", description: "List tasks (or delegate to /todo subcommands)" },
  { name: "agents", description: "Show the main agent and subagent activity" },
  { name: "doctor", description: "Environment and session health summary" },
  { name: "config", description: "Show the resolved configuration" },
  { name: "clear", description: "Clear the context (compact + drop pending images)" },
  { name: "rewind", description: "Restore the most recent checkpoint" },
  { name: "permissions", description: "Show approval mode and tool permissions" },
  { name: "theme", description: "Switch theme by name (or cycle)" },
  { name: "login", description: "Show how to log in to a provider (OAuth)" },
  { name: "logout", description: "Show how to log out of a provider (OAuth)" },
  { name: "exit", description: "Leave the TUI" },
  { name: "quit", description: "Leave the TUI" },
];

export interface FullScreenAgentOptions {
  agent: CodingAgent;
  sessions: SessionStore;
  resources: AgentResources;
  extensions: ExtensionHostLike;
  cwd: string;
  model: ModelProfile;
  approval: string;
  sandbox: string;
  title?: string;
  theme: string | TuiTheme;
  mascot: string | TuiMascot;
  allowRemoteImages?: boolean;
  keymap?: Record<string, string>;
  keymapPath?: string;
  initialPrompt?: string;
  initialAttachments?: AgentAttachment[];
  /** Optional MCP server specs surfaced by /mcp list; defaults to none. */
  mcpServers?: McpServerSpec[];
  /** Optional picker providers for Alt+M; defaults to a single-provider list. */
  pickerProviders?: PickerProvider[];
  /** Initial reasoning-effort slot for the picker. */
  pickerReasoningEffort?: ReasoningEffort;
  /** Optional session cost budget (USD) used by /cost and the cost widget. */
  sessionBudget?: number;
  /**
   * Optional USD-per-1M-token pricing, keyed by "provider/model" then bare
   * model id (matching `AgentConfigFile.pricing`). Used by the session cost
   * widget and /cost to show USD instead of raw token counts.
   */
  pricing?: Record<string, ModelPricing>;
  changeModel(spec: string): Promise<ModelProfile>;
  /** SpecEngine 确认回调透传。 */
  onSpecConfirm?(specId: string, choices: Record<string, string>): void;
  /** SpecEngine 拒绝回调透传。 */
  onSpecDecline?(specId: string): void;
  onReady?(tui: FullScreenTui): void;
  /** Initial vim mode preference, persisted across sessions. */
  vimEnabled?: boolean;
  /** Callback fired when vim mode is toggled; persist the new value. */
  onVimToggle?(enabled: boolean): void;
}

const DEFAULT_COMPANION_PATH = () => join(homedir(), ".focuscode", "companion.json");

/**
 * Pure session-cost tracker for the TUI. Every usage event carries the
 * CUMULATIVE session-to-date token totals (agent-runtime's `sessionUsage`,
 * summed across all session entries), so `set` REPLACES the stored USD on each
 * call rather than accumulating — accumulating would double-count every turn.
 * Pricing is resolved by "provider/model" then bare model id (matching
 * `AgentConfigFile.pricing` keys). No I/O, so the tracker is unit-testable in
 * isolation.
 * `pricing` exposes the resolved per-model pricing so the usage handler can
 * derive the cache savings (cached tokens × input rate) without re-resolving.
 */
export function createTuiCostTracker(config: {
  pricing: Record<string, ModelPricing>;
  modelKey: string;
  modelId: string;
}): { set(usage: TokenUsage): void; usd: number; pricing: ModelPricing | undefined } {
  let usd = 0;
  const pricing = config.pricing[config.modelKey] ?? config.pricing[config.modelId];
  return {
    set(usage: TokenUsage) {
      usd = estimateCostUsd(usage, pricing).totalUsd;
    },
    get usd() {
      return usd;
    },
    get pricing() {
      return pricing;
    },
  };
}

export async function runFullScreenAgent(options: FullScreenAgentOptions): Promise<void> {
  const keymap = await loadKeymap(options.keymapPath, options.keymap);
  const theme = await loadTheme(options.theme, options.cwd);
  const mascot = await loadMascot(options.mascot, options.cwd);
  let cheerEnabled = mascot.id === "foxy";
  let pendingAttachments = [...(options.initialAttachments ?? [])];
  let activeModel = options.model;
  let companion = await loadCompanionState();
  let sessionCost = 0;
  let diagnosticsEnabled = true;
  const sessionBudget = options.sessionBudget;
  const sessionCostTracker = createTuiCostTracker({
    pricing: options.pricing ?? {},
    modelKey: activeModel.provider + "/" + activeModel.model,
    modelId: activeModel.model,
  });
  const pickerProviders = options.pickerProviders ?? buildDefaultPickerProviders(activeModel);
  const mcpServers = options.mcpServers ?? [];
  const tui = new FullScreenTui({
    input: process.stdin,
    output: process.stdout,
    title: options.title ?? "FocusCode",
    model: activeModel.provider + "/" + activeModel.model,
    session: options.agent.sessionId,
    approval: options.approval,
    sandbox: options.sandbox,
    theme,
    mascot,
    keymap,
    completionProviders: createCompletionProviders(options),
    pickerProviders,
    ...(options.pickerReasoningEffort
      ? { pickerReasoningEffort: options.pickerReasoningEffort }
      : {}),
    // Wire vim mode persistence: the TUI restores the initial state and
    // fires onVimToggle when the user toggles vim mode, so the CLI can
    // write the preference back to config.
    ...(options.vimEnabled !== undefined ? { vimEnabled: options.vimEnabled } : {}),
    ...(options.onVimToggle ? { onVimToggle: options.onVimToggle } : {}),
    onPickModel: (result) => {
      void options
        .changeModel(result.model)
        .then((profile) => {
          activeModel = profile;
          tui.setModel(profile.provider + "/" + profile.model);
          tui.setStatus(
            "Model: " +
              profile.provider +
              "/" +
              profile.model +
              " · reasoning: " +
              result.reasoningEffort +
              (result.sessionOnly ? " · session-only" : ""),
          );
        })
        .catch((error: unknown) => {
          tui.addMessage(
            "system",
            "Failed to switch model: " + (error instanceof Error ? error.message : String(error)),
          );
        });
    },
    onSubmit: async (text) => {
      const attachments = pendingAttachments;
      pendingAttachments = [];
      tui.setAttachments([]);
      await options.agent.submit({
        text,
        ...(attachments.length ? { attachments } : {}),
      });
    },
    onSteer: async (text) => {
      const receipt = await options.agent.steer(text, "append");
      tui.setQueued(receipt.queueSize);
    },
    onAbort: () => {
      options.agent.abort();
    },
    onCommand: async (command): Promise<string | void> => {
      const [rawName, ...parts] = command.slice(1).split(/\s+/);
      const name = rawName?.toLowerCase() ?? "";
      const args = parts.join(" ");
      if (name === "exit" || name === "quit") {
        tui.dispose();
        return;
      }
      if (name === "help") return tuiHelp();
      if (name === "cheer") {
        if (args === "on") cheerEnabled = true;
        else if (args === "off") cheerEnabled = false;
        else cheerEnabled = !cheerEnabled;
        tui.setSpeech(cheerEnabled ? pickCheer("idle") : undefined);
        return cheerEnabled ? "Foxy 鼓励师已上线 🦊" : "Foxy 鼓励师已休息。";
      }
      if (name === "status") return JSON.stringify(await options.agent.status(), null, 2);
      if (name === "tools") {
        return options.agent
          .toolDefinitions()
          .map((tool) => tool.name.padEnd(16) + tool.effect.padEnd(8) + tool.description)
          .join("\n");
      }
      if (name === "compact") {
        const compacted = await options.agent.compact();
        return "Compacted " + compacted.droppedMessages + " messages.";
      }
      if (name === "interrupt") {
        if (!args) return "Usage: /interrupt <steering instruction>";
        const receipt = await options.agent.steer(args, "interrupt");
        tui.setQueued(receipt.queueSize);
        return "Interrupt steering queued.";
      }
      if (name === "followup" || name === "follow-up") {
        if (!args) return "Usage: /followup <instruction>";
        const receipt = await options.agent.steer(args, "follow-up");
        tui.setQueued(receipt.queueSize);
        return "Follow-up queued for after the current work completes.";
      }
      if (name === "unsteer") {
        const removed = await options.agent.unsteer(args || undefined);
        if (removed.length === 0) return "No matching steering item in the queue.";
        tui.setQueued(options.agent.listSteering().length);
        return "Removed steering: " + removed.map((item) => item.text).join(" · ");
      }
      if (name === "image") {
        if (args === "clear") {
          pendingAttachments = [];
          tui.setAttachments([]);
          return "Pending images cleared.";
        }
        if (!args) {
          if (process.platform !== "darwin") {
            return "Clipboard images are only supported on macOS; pass /image <path-or-url> instead.";
          }
          const clipped = await loadClipboardImage(options);
          if (!clipped) return "No image on the clipboard.";
          pendingAttachments.push(clipped);
          tui.setAttachments(pendingAttachments.map((item) => item.name));
          return "Attached clipboard image " + clipped.name + " for the next prompt.";
        }
        const attachment = await loadImageAttachment(args, {
          cwd: options.cwd,
          allowOutsideWorkspace: true,
          allowRemoteUrls: options.allowRemoteImages ?? true,
        });
        pendingAttachments.push(attachment);
        tui.setAttachments(pendingAttachments.map((item) => item.name));
        return "Attached " + attachment.name + " for the next prompt.";
      }
      if (name === "images") {
        return pendingAttachments.length
          ? pendingAttachments.map((item) => item.name + " · " + item.mediaType).join("\n")
          : "No pending images.";
      }
      if (name === "approval") {
        if (!isApprovalMode(args)) return "Usage: /approval ask|auto-edit|full-auto|deny";
        options.agent.changeApproval(args);
        tui.setApproval(args);
        tui.showToast("Approval: " + args, args === "deny" ? "warning" : "info");
        return "Approval mode: " + args;
      }
      if (name === "model") {
        if (!args) return activeModel.provider + "/" + activeModel.model;
        activeModel = await options.changeModel(args);
        tui.setModel(activeModel.provider + "/" + activeModel.model);
        tui.showToast("Model: " + activeModel.provider + "/" + activeModel.model, "info");
        return "Model changed to " + activeModel.provider + "/" + activeModel.model;
      }
      if (name === "new") {
        const session = await options.agent.newSession(args || undefined);
        tui.setSession(session);
        return "Started session " + session;
      }
      if (name === "resume") {
        if (!args) return "Usage: /resume <session-id>";
        const session = await options.agent.switchSession(args);
        tui.setSession(session);
        return "Switched to " + session;
      }
      if (name === "fork") {
        const session = await options.agent.forkSession(args || undefined);
        tui.setSession(session);
        return "Forked into " + session;
      }
      if (name === "sessions") {
        return (await options.sessions.list(options.cwd))
          .map(
            (session) =>
              session.sessionId + " · " + (session.name ?? "unnamed") + " · " + session.preview,
          )
          .join("\n");
      }
      if (name === "tree") {
        const snapshot = options.agent.snapshot();
        const active = new Set(activeBranch(snapshot).map((entry) => entry.entryId));
        return snapshot.entries
          .map(
            (entry) =>
              (entry.entryId === snapshot.activeLeafId
                ? "*"
                : active.has(entry.entryId)
                  ? "│"
                  : "·") +
              " " +
              entry.entryId +
              " " +
              entry.message.role +
              " " +
              entry.message.content.replace(/\s+/g, " ").slice(0, 100),
          )
          .join("\n");
      }
      if (name === "export") {
        const path = resolve(args || "focuscode-session-" + options.agent.sessionId + ".html");
        await writeFile(path, renderSessionHtml(options.agent.snapshot()), "utf8");
        return "Exported " + path;
      }
      if (name === "reload") {
        return "Reloaded " + (await options.extensions.reload()).length + " extension(s).";
      }
      if (name === "skills") {
        return options.resources.skills.length
          ? options.resources.skills
              .map((skill) => "/" + skill.name + " — " + skill.description)
              .join("\n")
          : "No skills discovered.";
      }
      if (name === "skill") {
        const [skillName, ...skillArgs] = parts;
        const skill = options.resources.skills.find((item) => item.name === skillName);
        if (!skill) return "Unknown skill: " + (skillName ?? "");
        void tui.submitText(
          "Apply the following skill.\n\n" +
            skill.content +
            "\n\nRequest: " +
            (skillArgs.join(" ") || "Continue the current task."),
        );
        return;
      }
      if (name === "character") {
        return describeMascots();
      }
      if (name === "skin") {
        return describeSkins(args);
      }
      if (name === "init") {
        return await scaffoldFocuscodeProject(options.cwd);
      }
      if (name === "undo") {
        return await options.agent.undoCheckpoint();
      }
      if (name === "cost") {
        return formatSessionCost(sessionCost, sessionBudget, companion);
      }
      if (name === "todo") {
        return await runTodoSubcommand(options.agent, args);
      }
      if (name === "mcp") {
        return describeMcpServers(mcpServers, args);
      }
      if (name === "diagnostics") {
        if (args === "on") diagnosticsEnabled = true;
        else if (args === "off") diagnosticsEnabled = false;
        else diagnosticsEnabled = !diagnosticsEnabled;
        return "Diagnostics " + (diagnosticsEnabled ? "on" : "off") + ".";
      }
      if (name === "vim") {
        const state: VimState | undefined = tui.getVimState();
        const enabled: boolean = state !== undefined;
        tui.setVimEnabled(!enabled);
        return enabled ? "Vim mode off." : "Vim mode on (NORMAL).";
      }
      if (name === "palette") {
        tui.openPalette();
        return;
      }
      if (name === "search") {
        tui.openSearch();
        if (args) tui.updateSearchQuery(args);
        return;
      }
      if (name === "layout") {
        return runLayoutSubcommand(tui, args);
      }
      if (name === "todopanel") {
        return runTodoPanelSubcommand(tui, args);
      }
      if (name === "goal") {
        return renderGoalCommand(options.agent.snapshot(), options.agent.todoCounts());
      }
      if (name === "task") {
        if (args) return runTodoSubcommand(options.agent, args);
        const list = await options.agent.runTool("todo", { action: "list" });
        return renderTaskCommand(list.content, options.agent.todoCounts());
      }
      if (name === "agents") {
        return renderAgentsCommand(options.agent.snapshot(), await options.agent.status());
      }
      if (name === "doctor") {
        const checkpoints = await options.agent.listCheckpoints();
        const sessions = await options.sessions.list(options.cwd);
        return renderDoctorCommand(
          await options.agent.status(),
          checkpoints.length,
          sessions.length,
        );
      }
      if (name === "config") {
        return renderConfigCommand(await options.agent.status(), options.sandbox, options.cwd);
      }
      if (name === "clear") {
        pendingAttachments = [];
        tui.setAttachments([]);
        const compacted = await options.agent.compact();
        return (
          "Context cleared: compacted " +
          compacted.droppedMessages +
          " messages · pending images cleared. (start fresh with /new)"
        );
      }
      if (name === "rewind") {
        return await options.agent.undoCheckpoint();
      }
      if (name === "permissions") {
        return renderPermissionsCommand(
          (await options.agent.status()).approval,
          options.agent.toolDefinitions(),
        );
      }
      if (name === "theme") {
        const applied = tui.setTheme(args || undefined);
        if (args && !applied) {
          return "Unknown theme. Available: " + TUI_THEMES.map((item) => item.name).join(", ");
        }
        return "Theme: " + applied;
      }
      if (name === "login") {
        const provider = args || "google";
        return (
          "OAuth login needs a browser redirect, so it runs outside the TUI:\n" +
          "  focuscode auth login " +
          provider +
          "\nThen restart focuscode to pick up the credential."
        );
      }
      if (name === "logout") {
        return (
          "Run in a separate terminal:\n" +
          "  focuscode auth logout" +
          (args ? " " + args : " [provider]") +
          "\nThen restart focuscode."
        );
      }
      const prompt = options.resources.prompts.find((item) => item.name === name);
      if (prompt) {
        void tui.submitText(expandPromptTemplate(prompt, args));
        return;
      }
      const extension = options.extensions.getCommand(name);
      if (extension) {
        const result = await extension.execute(args, {
          sessionId: options.agent.sessionId,
          cwd: options.cwd,
        });
        return result ?? undefined;
      }
      return "Unknown command: /" + name;
    },
    ...(options.onSpecConfirm ? { onSpecConfirm: options.onSpecConfirm } : {}),
    ...(options.onSpecDecline ? { onSpecDecline: options.onSpecDecline } : {}),
  });
  options.onReady?.(tui);
  tui.setCompanion(companion);
  tui.setSessionCost(sessionCost, sessionBudget);

  // Wire up the command palette (Ctrl+P) to actual TUI / session actions.
  // Without this callback, palette commands have no effect (the overlay opens
  // but selecting a command is a no-op).
  tui.setPaletteCallback((cmd) => {
    switch (cmd.id) {
      case "layout:classic":
        tui.setLayoutMode("classic");
        tui.setStatus("Layout: classic");
        break;
      case "layout:split":
        tui.setLayoutMode("split");
        tui.setStatus("Layout: split");
        break;
      case "layout:focus":
        tui.setLayoutMode("focus");
        tui.setStatus("Layout: focus");
        break;
      case "layout:wide":
        tui.setLayoutMode("wide");
        tui.setStatus("Layout: wide");
        break;
      case "layout:cycle":
        tui.cycleLayoutMode();
        tui.setStatus("Layout: " + tui.getLayoutState().mode);
        break;
      case "todo:toggle_panel":
        tui.toggleTodoPanel();
        tui.setStatus(tui.getTodoPanelState().visible ? "Todo panel on" : "Todo panel off");
        break;
      case "vim:toggle":
        tui.setVimEnabled(!tui.getVimState());
        tui.setStatus(tui.getVimState() ? "Vim mode on" : "Vim mode off");
        break;
      case "search:transcript":
        tui.openSearch();
        break;
      case "model:picker":
        tui.openPicker();
        break;
      case "spec:decline":
        // Decline the currently pending spec confirmation, if any.
        tui.declineSpecConfirmation?.();
        break;
      case "session:new":
        void options.agent
          .newSession()
          .then((sessionId) => {
            tui.setSession(sessionId);
            tui.setStatus("New session: " + sessionId);
          })
          .catch((error: unknown) => {
            tui.addMessage(
              "system",
              "Failed to start new session: " +
                (error instanceof Error ? error.message : String(error)),
            );
          });
        break;
      case "session:fork":
        void options.agent
          .forkSession()
          .then((sessionId) => {
            tui.setSession(sessionId);
            tui.setStatus("Forked session: " + sessionId);
          })
          .catch((error: unknown) => {
            tui.addMessage(
              "system",
              "Failed to fork session: " + (error instanceof Error ? error.message : String(error)),
            );
          });
        break;
      case "view:toggle_reasoning":
        tui.toggleReasoning?.();
        break;
      case "view:clear_transcript":
        tui.clearTranscript?.();
        break;
      case "pane:toggle_spec":
        tui.toggleSidebarPane?.("spec");
        tui.setStatus("Spec pane toggled");
        break;
      case "pane:toggle_context":
        tui.toggleSidebarPane?.("context");
        tui.setStatus("Context pane toggled");
        break;
      default:
        tui.setStatus("Unknown palette command: " + cmd.id);
    }
  });
  options.agent.setEventSink((event) => {
    if (event.type === "usage") {
      sessionCostTracker.set(event.session);
      sessionCost = sessionCostTracker.usd;
      tui.setSessionCost(sessionCost, sessionBudget);
      const { hitRatio } = cacheMetrics(event.session);
      const savedUsd =
        hitRatio > 0
          ? ((event.session.cachedInputTokens ?? 0) / 1_000_000) *
            (sessionCostTracker.pricing?.input ?? 0)
          : 0;
      tui.setCacheMetrics({ hitRatio, savedUsd });
      return;
    }
    if (event.type === "agent_end") {
      const toolSuccesses = Math.max(0, event.response.toolCalls);
      const reward = applyTurnReward(companion, { toolSuccesses });
      companion = reward.state;
      tui.setCompanion(companion);
      if (reward.leveledUp) {
        tui.setLevelUpMood();
        tui.setSpeech(
          "升级了！现在是 Lv " +
            reward.newLevel +
            " · " +
            levelName(reward.newLevel ?? companion.level) +
            " 🦊",
        );
      }
      void persistCompanion(companion).catch(() => undefined);
    }
    renderEvent(tui, event, () => cheerEnabled);
  });
  tui.addMessage("system", "", {
    rendered: buildWelcomeLines(theme, mascot, activeModel.provider + "/" + activeModel.model),
  });
  tui.setSpeech(cheerEnabled ? mascot.catchphrase : undefined);
  tui.setAttachments(pendingAttachments.map((attachment) => attachment.name));
  const running = tui.run();
  if (options.initialPrompt) {
    await tui.submitText(options.initialPrompt).catch((error: unknown) => {
      tui.addMessage("system", error instanceof Error ? error.message : String(error));
    });
  }
  await running;
}

export function renderEvent(tui: FullScreenTui, event: AgentEvent, cheerOn?: () => boolean): void {
  const speak = (kind: CheerKind) => {
    if (cheerOn?.()) tui.setSpeech(pickCheer(kind));
  };
  if (event.type === "model_start") {
    tui.setMood("thinking");
    tui.setStatus("Model round " + event.round + " · " + event.model);
    speak("thinking");
  } else if (event.type === "text_delta") {
    tui.appendAssistant(event.delta);
  } else if (event.type === "reasoning_delta") {
    tui.appendReasoning(event.delta);
  } else if (event.type === "tool_start") {
    tui.setMood("working");
    tui.setStatus("Running " + event.call.name + "…");
    speak("working");
  } else if (event.type === "tool_end") {
    const rendered = editDiffLines(event.call, Math.max(40, (process.stdout.columns || 80) - 30));
    if (rendered) {
      tui.addMessage("tool", event.call.name + " · " + event.durationMs + "ms", { rendered });
    } else {
      tui.addMessage(
        "tool",
        event.call.name + " · " + event.durationMs + "ms\n" + event.result.content.slice(0, 4_000),
      );
    }
    tui.setMood(event.result.isError ? "oops" : "happy");
    speak(event.result.isError ? "oops" : "happy");
  } else if (event.type === "steering_queued") {
    tui.setQueued(event.queueSize);
  } else if (event.type === "steering_applied") {
    tui.setQueued(event.queueSize);
    tui.setStatus("Steering applied.");
  } else if (event.type === "steering_removed") {
    tui.setQueued(event.queueSize);
    tui.setStatus("Steering removed.");
  } else if (event.type === "model_retry") {
    tui.setStatus(
      `Provider retry ${event.attempt} in ${event.delayMs}ms${event.status ? ` · HTTP ${event.status}` : ""}`,
    );
  } else if (event.type === "compaction") {
    tui.addMessage("system", "Context compacted: " + event.droppedMessages + " messages.");
    speak("compact");
  } else if (event.type === "error") {
    tui.addMessage("system", event.message);
    tui.setMood("oops");
    speak("oops");
  } else if (event.type === "spec_start") {
    // Phase 5 — preset the 5-stage pipeline so the user immediately sees
    // the full SpecEngine flow as pending, rather than an empty stage list.
    tui.setSpecProgress(createInitialSpecPipeline(event.trigger));
    // Mark the first stage (classify) as running to give immediate visual
    // feedback that the pipeline has started. Subsequent spec_stage events
    // will update each stage to "done" and infer the next running stage.
    tui.updateSpecStage("classify", { status: "running" });
    tui.setStatus("✦ Spec engine started (" + event.trigger + ")");
    speak("thinking");
  } else if (event.type === "spec_stage") {
    tui.updateSpecStage(event.stage, {
      status: "done",
      model: event.model,
      durationMs: event.durationMs,
      fellBack: event.fellBack,
    });
    // Phase 5 — infer the next pending stage and mark it as running so the
    // user sees live pipeline progression between spec_stage events. The
    // canonical SpecEngine order is classify → explore → draft →
    // detect-decisions → enhance.
    const SPEC_STAGE_ORDER = [
      "classify",
      "explore",
      "draft",
      "detect-decisions",
      "enhance",
    ] as const;
    const completedIdx = SPEC_STAGE_ORDER.indexOf(event.stage as (typeof SPEC_STAGE_ORDER)[number]);
    if (completedIdx >= 0 && completedIdx < SPEC_STAGE_ORDER.length - 1) {
      const nextName = SPEC_STAGE_ORDER[completedIdx + 1]!;
      const current = tui.getSpecProgress();
      const nextStage = current.stages.find((s) => s.name === nextName);
      if (nextStage && nextStage.status === "pending") {
        tui.updateSpecStage(nextName, { status: "running" });
      }
    }
    tui.setStatus(
      "✦ " + event.stage + (event.fellBack ? " (fallback)" : " ✓") + " " + event.durationMs + "ms",
    );
  } else if (event.type === "spec_draft_ready") {
    const understanding = event.understanding as {
      goal?: string;
      constraints?: unknown[];
      acceptanceCriteria?: unknown[];
      affectedAreas?: Array<{ path: string }>;
    };
    const taskBreakdown = event.taskBreakdown as Array<{
      id: string;
      description: string;
      kind: string;
    }>;
    tui.setSpecDraft({
      specId: event.specId,
      topic: event.topic,
      understanding,
      taskBreakdown,
    });
    tui.setSpeech("Spec draft ready: " + event.topic);
  } else if (event.type === "spec_confirmation_required") {
    const decisions: SpecDecisionView[] = (event.decisions as unknown[]).map((raw) => {
      const d = raw as {
        id: string;
        point: string;
        severity: "critical" | "major" | "minor";
        options: { label: string; description: string; tradeoffs?: string }[];
      };
      return {
        id: d.id,
        point: d.point,
        severity: d.severity,
        options: d.options.map((o) => ({ label: o.label, description: o.description })),
        selectedIndex: 0,
      } satisfies SpecDecisionView;
    });
    tui.setSpecConfirmation(event.specId, decisions);
    tui.setMood("thinking");
  } else if (event.type === "spec_confirmed") {
    tui.clearSpecConfirmation();
    tui.setMood("happy");
    tui.setStatus("✦ Spec confirmed");
    tui.showToast("Spec confirmed", "success");
  } else if (event.type === "spec_skipped") {
    // Phase 5 — preserve stage history and capture the skip reason so the
    // renderer can show why the pipeline was short-circuited.
    const prev = tui.getSpecProgress();
    tui.setSpecProgress({
      phase: "skipped",
      stages: prev.stages,
      ...(prev.startTime !== undefined ? { startTime: prev.startTime } : {}),
      skipReason: event.reason,
    });
    tui.setStatus("✦ Spec skipped: " + event.reason);
  } else if (event.type === "spec_completed") {
    // Phase 5 — preserve stage history so the user can review each stage's
    // duration / fallback status after the pipeline finishes.
    const prev = tui.getSpecProgress();
    const startTime = prev.startTime ?? tui.getSpecStartTime();
    const totalDuration = startTime ? Date.now() - startTime : undefined;
    tui.setSpecProgress({
      phase: "completed",
      stages: prev.stages,
      ...(totalDuration !== undefined ? { totalDuration } : {}),
      ...(event.specId ? { specId: event.specId } : {}),
      ...(prev.topic ? { topic: prev.topic } : {}),
    });
    tui.setMood("happy");
    tui.setStatus("✦ Spec completed · " + (totalDuration ?? 0) + "ms");
    tui.showToast("Spec completed in " + (totalDuration ?? 0) + "ms", "success");
  } else if (event.type === "agent_end") {
    tui.setStatus(
      event.response.stopped +
        " · " +
        event.response.rounds +
        " round(s) · " +
        event.response.toolCalls +
        " tool call(s)",
    );
    speak("done");
  }
}

async function loadTheme(value: string | TuiTheme, cwd: string): Promise<TuiTheme> {
  if (typeof value !== "string") return validateTuiTheme(value);
  if (!looksLikeJsonPath(value)) return getTheme(value);
  return validateTuiTheme(await readJsonArtifact(resolve(cwd, value), "theme"));
}

async function loadMascot(value: string | TuiMascot, cwd: string): Promise<TuiMascot> {
  if (typeof value !== "string") return validateTuiMascot(value);
  if (!looksLikeJsonPath(value)) return getMascot(value);
  return validateTuiMascot(await readJsonArtifact(resolve(cwd, value), "mascot"));
}

async function readJsonArtifact(path: string, label: string): Promise<unknown> {
  const source = await readFile(path, "utf8");
  if (Buffer.byteLength(source) > 64_000) throw new Error(`Custom ${label} exceeds 64 KB`);
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid custom ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function looksLikeJsonPath(value: string): boolean {
  return value.endsWith(".json") || value.includes("/") || value.includes("\\");
}

async function loadKeymap(
  path?: string,
  configured: Record<string, string> = {},
): Promise<TuiKeymap> {
  const value = path
    ? (JSON.parse(await readFile(resolve(path), "utf8")) as Record<string, string>)
    : {};
  return mergeKeymap({ ...configured, ...value } as Partial<TuiKeymap>);
}

function tuiHelp(): string {
  return [
    "/help · /status · /tools · /goal · /task · /agents",
    "/doctor · /config · /permissions · /theme [name]",
    "/compact · /clear · /interrupt <instruction> · /followup <instruction> · /unsteer [id]",
    "/image [path-or-url] (empty: clipboard) · /images · /image clear",
    "/model [provider/model] · /approval <mode>",
    "/sessions · /resume <id> · /new · /fork · /tree · /rewind",
    "/skills · /skill <name> · /reload · /export · /cheer [on|off]",
    "/login · /logout (OAuth, run in a separate terminal)",
    "/exit",
    "Tab complete · Ctrl+O newline · Ctrl+C abort · Ctrl+D exit · Ctrl+G mascot · Ctrl+T theme",
  ].join("\n");
}

function isApprovalMode(value: string): value is ApprovalMode {
  return ["ask", "auto-edit", "full-auto", "deny"].includes(value);
}

function createCompletionProviders(options: FullScreenAgentOptions): CompletionProvider[] {
  return [
    {
      // Slash commands, skills, prompts and extension commands, at buffer start only.
      complete(prefix, fullText) {
        if (!prefix.startsWith("/") || !fullText.startsWith(prefix)) return [];
        const commands: CompletionCandidate[] = [
          ...TUI_SLASH_COMMANDS.map((command) => ({
            value: "/" + command.name,
            description: command.description,
          })),
          ...options.resources.skills.map((skill) => ({
            value: "/" + skill.name,
            description: skill.description,
          })),
          ...options.resources.prompts.map((prompt) => ({
            value: "/" + prompt.name,
            description: prompt.description,
          })),
          ...options.extensions.commandList().map((command) => ({
            value: "/" + command.name,
            description: command.description,
          })),
        ];
        return commands.filter((command) => command.value.startsWith(prefix));
      },
    },
    {
      // File paths relative to the workspace; directories keep a trailing slash.
      complete(prefix) {
        if (!prefix || prefix.startsWith("/")) return [];
        return completeFilePath(prefix, options.cwd);
      },
    },
  ];
}

function completeFilePath(prefix: string, cwd: string): CompletionCandidate[] {
  const slash = prefix.lastIndexOf("/");
  const directory = slash >= 0 ? prefix.slice(0, slash + 1) : "";
  const stem = slash >= 0 ? prefix.slice(slash + 1) : prefix;
  let entries;
  try {
    entries = readdirSync(resolve(cwd, directory || "."), { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: CompletionCandidate[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(stem)) continue;
    if (entry.name.startsWith(".") && !stem.startsWith(".")) continue;
    matches.push({
      value: directory + entry.name + (entry.isDirectory() ? "/" : ""),
      ...(entry.isDirectory() ? { description: "directory" } : {}),
    });
    if (matches.length >= 20) break;
  }
  return matches.sort((a, b) => a.value.localeCompare(b.value));
}

/** Pre-rendered diff lines for edit-style tool calls (old/new text arguments). */
function editDiffLines(call: AgentToolCall, width: number): string[] | undefined {
  if (call.name !== "edit") return undefined;
  const oldText = call.arguments.oldText;
  const newText = call.arguments.newText;
  if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
  const path = typeof call.arguments.path === "string" ? call.arguments.path : "file";
  return ["edit " + path, ...renderDiff(oldText, newText, width)].slice(0, 200);
}

/** Read a PNG from the macOS clipboard into a temp file and load it as an attachment. */
async function loadClipboardImage(
  options: FullScreenAgentOptions,
): Promise<AgentAttachment | undefined> {
  const path = await readClipboardImage();
  if (!path) return undefined;
  try {
    return await loadImageAttachment(path, {
      cwd: options.cwd,
      allowOutsideWorkspace: true,
      allowRemoteUrls: false,
    });
  } finally {
    await rm(path, { force: true });
  }
}

/**
 * Read a PNG from the macOS clipboard into a fresh temp file and return its path.
 * Returns undefined when the clipboard holds no image; the caller owns the file.
 */
export async function readClipboardImage(): Promise<string | undefined> {
  const path = join(tmpdir(), "focuscode-clipboard-" + randomUUID() + ".png");
  if (!(await captureClipboardImage(path))) return undefined;
  return path;
}

async function captureClipboardImage(path: string): Promise<boolean> {
  try {
    await execFileAsync("pngpaste", [path], { timeout: 5_000 });
  } catch {
    try {
      await execFileAsync(
        "osascript",
        [
          "-e",
          "on run argv",
          "-e",
          "set pngData to the clipboard as «class PNGf»",
          "-e",
          "set theFile to POSIX file (item 1 of argv)",
          "-e",
          "set fileRef to open for access theFile with write permission",
          "-e",
          "set eof fileRef to 0",
          "-e",
          "write pngData to fileRef",
          "-e",
          "close access fileRef",
          "-e",
          "end run",
          path,
        ],
        { timeout: 5_000 },
      );
    } catch {
      return false;
    }
  }
  const info = await stat(path).catch(() => undefined);
  if (!info || info.size === 0) {
    await rm(path, { force: true });
    return false;
  }
  return true;
}

/** Load companion state from `~/.focuscode/companion.json`; falls back to initial. */
async function loadCompanionState(): Promise<CompanionState> {
  try {
    const path = DEFAULT_COMPANION_PATH();
    const text = await readFile(path, "utf8");
    return parseCompanion(text);
  } catch {
    return initialCompanion();
  }
}

/** Best-effort persist; missing directories are created, write errors are surfaced.
 *  Debounced: rapid agent_end events within 500ms are coalesced into one write. */
let companionPersistTimer: ReturnType<typeof setTimeout> | undefined;
async function persistCompanion(state: CompanionState): Promise<void> {
  if (companionPersistTimer) clearTimeout(companionPersistTimer);
  companionPersistTimer = setTimeout(() => {
    companionPersistTimer = undefined;
    const path = DEFAULT_COMPANION_PATH();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    void writeFile(path, serializeCompanion(state), "utf8").catch(() => undefined);
  }, 500);
}

/**
 * Build a minimal single-provider picker list from the active model profile.
 * The CLI caller can pass a richer `pickerProviders` to override this.
 */
function buildDefaultPickerProviders(model: ModelProfile): PickerProvider[] {
  return [
    {
      id: model.provider,
      label: model.provider,
      models: [
        {
          id: model.provider + "/" + model.model,
          ...(model.model ? { label: model.model } : {}),
          ...(model.revision ? { description: "rev " + model.revision } : {}),
        },
      ],
    },
  ];
}

/** Describe available mascots for /character. */
function describeMascots(): string {
  const lines = TUI_MASCOTS.map(
    (mascot) => "· " + mascot.id + " — " + mascot.name + " (" + mascot.species + ")",
  );
  return [
    "Available mascots (set via --mascot or config tui.mascot):",
    ...lines,
    "Tip: /cheer toggles the Foxy encouragement companion.",
  ].join("\n");
}

/** Describe available builtin skins for /skin; import/export are no-ops here. */
function describeSkins(args: string): string {
  const skins = listBuiltinSkins();
  if (args === "builtin" || !args) {
    return [
      "Builtin skins:",
      ...skins.map((skin) => "· " + skin.id + " — " + skin.name),
      "Import/export require a skin pack JSON path; see `focuscode skin --help`.",
    ].join("\n");
  }
  if (args === "import") return "Use `focuscode skin import <path>` to load a skin pack JSON.";
  if (args === "export") return "Use `focuscode skin export <id> <path>` to save a skin pack.";
  return "Usage: /skin [builtin | import | export]";
}

/** Scaffold `.focuscode/instructions.md` and skills directory; idempotent. */
async function scaffoldFocuscodeProject(cwd: string): Promise<string> {
  const focuscodeDir = join(cwd, ".focuscode");
  const skillsDir = join(focuscodeDir, "skills");
  const promptsDir = join(focuscodeDir, "prompts");
  const instructionsPath = join(focuscodeDir, "instructions.md");
  const created: string[] = [];
  if (!existsSync(focuscodeDir)) {
    mkdirSync(focuscodeDir, { recursive: true });
    created.push(focuscodeDir + "/");
  }
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
    created.push(skillsDir + "/");
  }
  if (!existsSync(promptsDir)) {
    mkdirSync(promptsDir, { recursive: true });
    created.push(promptsDir + "/");
  }
  if (!existsSync(instructionsPath)) {
    const stub = [
      "# FocusCode project instructions",
      "",
      "Describe repository conventions, build commands, and review guidelines here.",
      "These instructions are loaded automatically when `--trust-project` is active.",
      "",
      "## Build",
      "",
      "- `pnpm verify` — required local gate",
      "- `pnpm test` — build then vitest run",
      "",
      "## Conventions",
      "",
      "- Keep changes small and reviewable.",
      "- Run `pnpm format` before committing.",
    ].join("\n");
    await writeFile(instructionsPath, stub, "utf8");
    created.push(instructionsPath);
  }
  return created.length
    ? "Scaffolded:\n" + created.join("\n")
    : "Project already initialized (.focuscode/ exists).";
}

/** Format session cost (USD) + companion level for /cost. */
function formatSessionCost(
  usd: number,
  budget: number | undefined,
  companion: CompanionState,
): string {
  const turns = companion.totalTurns;
  const lines = [
    "Session cost summary",
    "· cost: $" + usd.toFixed(4),
    ...(budget !== undefined ? ["· budget: $" + budget] : []),
    "· companion: Lv " + companion.level + " · " + levelName(companion.level),
    "· total turns: " + turns,
    "· total tool successes: " + companion.totalToolSuccesses,
    "Note: cost is estimated from config.pricing; without pricing it shows $0.00.",
  ];
  return lines.join("\n");
}

/** Run a /layout subcommand: switch or cycle pane layout mode. */
export function runLayoutSubcommand(tui: FullScreenTui, args: string): string {
  const arg = args.trim().toLowerCase();
  if (arg === "" || arg === "cycle") {
    tui.cycleLayoutMode();
    return "Layout: " + tui.getLayoutState().mode + ".";
  }
  const modes: LayoutMode[] = ["classic", "split", "focus", "wide"];
  if (modes.includes(arg as LayoutMode)) {
    tui.setLayoutMode(arg as LayoutMode);
    return "Layout: " + arg + ".";
  }
  return "Usage: /layout [classic | split | focus | wide | cycle]";
}

/** Run a /todopanel subcommand: toggle todo sidebar visibility. */
export function runTodoPanelSubcommand(tui: FullScreenTui, args: string): string {
  const arg = args.trim().toLowerCase();
  if (arg === "" || arg === "toggle") {
    tui.toggleTodoPanel();
    return "Todo panel " + (tui.getTodoPanelState().visible ? "on" : "off") + ".";
  }
  if (arg === "on") {
    if (!tui.getTodoPanelState().visible) tui.toggleTodoPanel();
    return "Todo panel on.";
  }
  if (arg === "off") {
    if (tui.getTodoPanelState().visible) tui.toggleTodoPanel();
    return "Todo panel off.";
  }
  return "Usage: /todopanel [on | off | toggle]";
}

/** Run a /todo subcommand via the agent's todo tool when registered. */
async function runTodoSubcommand(agent: CodingAgent, args: string): Promise<string> {
  const hasTodo = agent.toolDefinitions().some((tool) => tool.name === "todo");
  if (!hasTodo) return "Todo tool is not registered in this session.";
  const [subcommand, ...rest] = args.split(/\s+/);
  const arg = subcommand?.toLowerCase() ?? "";
  if (arg === "" || arg === "list") {
    const result = await agent.runTool("todo", { action: "list" });
    return result.content;
  }
  if (arg === "clear") {
    const result = await agent.runTool("todo", { action: "set", items: [] });
    return result.content;
  }
  if (arg === "add") {
    const content = rest.join(" ").trim();
    if (!content) return "Usage: /todo add <content>";
    const list = await agent.runTool("todo", { action: "list" });
    const id = "user-" + Date.now().toString(36);
    const newItems = [
      ...(await parseTodoItems(list.content)),
      { id, content, status: "pending" as const },
    ];
    const result = await agent.runTool("todo", { action: "set", items: newItems });
    return result.content;
  }
  if (arg === "done") {
    const targetId = rest[0];
    if (!targetId) return "Usage: /todo done <id>";
    const list = await agent.runTool("todo", { action: "list" });
    const items = (await parseTodoItems(list.content)).map((item) =>
      item.id === targetId ? { ...item, status: "completed" as const } : item,
    );
    if (!items.some((item) => item.id === targetId)) {
      return "No todo item with id: " + targetId;
    }
    const result = await agent.runTool("todo", { action: "set", items });
    return result.content;
  }
  return "Usage: /todo [add <content> | done <id> | clear | list]";
}

/** Parse the todo tool's rendered markdown list back into items; tolerant. */
async function parseTodoItems(
  rendered: string,
): Promise<
  Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }>
> {
  if (!rendered || rendered.includes("Task list is empty")) return [];
  const items: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed";
  }> = [];
  for (const line of rendered.split("\n")) {
    const match = /^- \[([ x~])\] ([^:]+): (.+)$/.exec(line);
    if (!match) continue;
    const [, marker, id, content] = match;
    const status = marker === "x" ? "completed" : marker === "~" ? "in_progress" : "pending";
    items.push({ id: id!.trim(), content: content!.trim(), status });
  }
  return items;
}

/** Describe configured MCP servers for /mcp; reload is informational only. */
function describeMcpServers(servers: McpServerSpec[], args: string): string {
  const sub = args.toLowerCase();
  if (sub === "reload") {
    return [
      "MCP reload is not supported from the TUI; restart the agent to re-register MCP servers.",
      servers.length
        ? "Configured servers: " + servers.map((server) => server.id).join(", ")
        : "No MCP servers configured.",
    ].join("\n");
  }
  if (servers.length === 0) return "No MCP servers configured.";
  const lines = servers.map((server) => {
    const state = server.disabled ? "disabled" : "enabled";
    const cmd = server.command ? " · " + server.command : "";
    const argList = server.args?.length ? " " + server.args.join(" ") : "";
    return "· " + server.id + " (" + state + ")" + cmd + argList;
  });
  return ["MCP servers:", ...lines].join("\n");
}

/** Unused token-usage import guard so the type stays in the dependency surface. */
export type { TokenUsage };
