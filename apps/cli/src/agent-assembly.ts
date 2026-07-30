/**
 * P1-E: Shared agent assembly — converges CLI and ACP onto the same setup
 * pipeline so the ACP server gets the same spine, extension host, MCP wiring,
 * enterprise audit journal, prefix rules, and tool filtering as the CLI.
 *
 * Both composition roots call `assembleCodingAgent` after `createAgentContext`
 * returns the sandbox/registry/resources/client/config. Mode-specific concerns
 * (TUI, interactive prompter, SpecEngine) stay in the caller; this function
 * handles only the pieces that must be identical across modes.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  CodingAgent,
  ExtensionHost,
  FileAuditJournal,
  ProcessExtensionHost,
  SessionStore,
  renderResourcePrompt,
  type AgentEvent,
  type AgentToolRegistry,
  type ApprovalHandler,
  type ApprovalMode,
  type ExtensionHostLike,
  type ResolvedAgentConfig,
} from "@focuscode/agent-runtime";
import { ExtensionPackageManager } from "@focuscode/ecosystem";
import { FileReceiptJournal, createSessionEffectSpine } from "@focuscode/sdk";
import type { CommandPrefixRule } from "@focuscode/action-domain";
import type { AgentCliArgs } from "./agent-args.js";
import type { AgentContext } from "./agent-context.js";
import { defaultExtensionDirectory } from "./platform-command.js";
import { wireMcpServers } from "./mcp-wiring.js";

export interface AssembleAgentOptions {
  cwd: string;
  args: AgentCliArgs;
  ctx: AgentContext;
  sessions: SessionStore;
  /** Pre-selected session ID to resume; undefined creates a new session. */
  sessionId?: string;
  /** Mode-specific approval handler (TUI prompter, interactive, or undefined). */
  approve?: ApprovalHandler;
  /** Event sink that receives agent events. */
  eventSink: (event: AgentEvent) => void;
}

export interface AssembledAgent {
  agent: CodingAgent;
  extensions: ExtensionHostLike;
  mcpHandle: Awaited<ReturnType<typeof wireMcpServers>>;
  spine: ReturnType<typeof createSessionEffectSpine> | undefined;
}

/**
 * Assemble a fully-configured CodingAgent with spine, extensions, MCP,
 * audit journal, and prefix rules — the same pipeline the CLI uses.
 *
 * Returns the agent plus disposal handles that the caller MUST close in a
 * `finally` block.
 */
export async function assembleCodingAgent(options: AssembleAgentOptions): Promise<AssembledAgent> {
  const { cwd, args, ctx, sessions, approve, eventSink } = options;
  const { registry, resources, client, config } = ctx;

  // ─── Tool enable/disable filtering ──────────────────────────────────
  const enabled = new Set(
    args.tools ?? config.enabledTools ?? registry.definitions().map((tool) => tool.name),
  );
  const disabled = new Set([...config.disabledTools, ...args.excludeTools]);
  for (const tool of registry.definitions()) {
    if (!enabled.has(tool.name) || disabled.has(tool.name)) registry.unregister(tool.name);
  }

  // ─── Extension host ─────────────────────────────────────────────────
  const extensions: ExtensionHostLike =
    config.extensions.host === "process"
      ? new ProcessExtensionHost(registry)
      : new ExtensionHost(registry);
  const extensionPackages = new ExtensionPackageManager({
    directory: resolve(config.extensionDirectory ?? defaultExtensionDirectory()),
  });
  const extensionPaths = await allowedExtensionPaths(extensionPackages, config);
  if (config.enterprise.enabled && args.extensionPaths.length > 0) {
    throw new Error("Enterprise policy forbids ad-hoc --extension paths");
  }
  await extensions.load([
    ...extensionPaths,
    ...(config.enterprise.enabled && !config.enterprise.allowProjectExtensions
      ? []
      : resources.extensionPaths),
    ...args.extensionPaths.map((path) => resolve(path)),
  ]);

  // ─── MCP wiring ─────────────────────────────────────────────────────
  const mcpHandle = await wireMcpServers({
    registry,
    servers: config.mcp.servers,
    pins: config.mcp.pins,
    onWarning: (message) => process.stderr.write(`MCP: ${message}\n`),
  });

  const tools = registry.values();
  if (tools.length === 0 && !args.tools?.includes("none")) {
    process.stderr.write("Warning: no tools are enabled; the agent can only respond with text.\n");
  }

  // ─── Prefix rules ───────────────────────────────────────────────────
  const prefixRules = args.commandRulesPath
    ? (JSON.parse(await readFile(resolve(args.commandRulesPath), "utf8")) as CommandPrefixRule[])
    : undefined;

  // ─── Enterprise audit journal ───────────────────────────────────────
  const auditJournal = enterpriseAuditJournal(config);

  // ─── Spine ──────────────────────────────────────────────────────────
  // The spine needs a stable taskId before agent creation, so pre-create the
  // session when none was resumed.
  let sessionId = options.sessionId;
  if (config.agent.effectSpine && !sessionId) {
    sessionId = (
      await sessions.create({
        cwd,
        model: config.model,
        ...(args.name ? { name: args.name } : {}),
      })
    ).header.sessionId;
  }
  const effectiveApproval: ApprovalMode = config.approval;
  const spine = config.agent.effectSpine
    ? createSessionEffectSpine({
        cwd,
        registry,
        taskId: sessionId!,
        model: config.model,
        permission: {
          mode: effectiveApproval,
          projectTrusted: config.projectTrusted,
          protectedPaths: config.protectedPaths,
          ...(prefixRules ? { prefixRules } : {}),
        },
        ...(approve ? { approve } : {}),
        receiptJournal: new FileReceiptJournal(
          join(homedir(), ".focuscode", "receipts", `${sessionId}.jsonl`),
        ),
      })
    : undefined;

  // ─── CodingAgent.create ─────────────────────────────────────────────
  const agent = await CodingAgent.create({
    cwd,
    model: config.model,
    modelClient: client,
    tools,
    toolRegistry: registry,
    permission: {
      mode: effectiveApproval,
      projectTrusted: config.projectTrusted,
      protectedPaths: config.protectedPaths,
      ...(approve ? { approve } : {}),
      ...(prefixRules ? { prefixRules } : {}),
    },
    sessionStore: sessions,
    ...(sessionId ? { sessionId } : {}),
    ...(args.name && !sessionId ? { sessionName: args.name } : {}),
    instructions: [renderResourcePrompt(resources)],
    maxRounds: args.maxRounds ?? config.maxRounds,
    steeringMaximum: config.steeringMaximum,
    steeringDelivery: config.steeringDelivery,
    eventSink,
    extensionHost: extensions,
    ...(auditJournal ? { auditJournal } : {}),
    checkpoints: config.agent.checkpoints,
    ...(config.agent.diagnostics ? { diagnostics: config.agent.diagnostics } : {}),
    enableDelegate: config.agent.enableDelegate,
    graph: config.graph,
    team: config.team,
    ...(spine
      ? {
          effectPort: spine.effectPort,
          effectContext: spine.effectContext,
          onApprovalModeChange: (mode: ApprovalMode) => spine.setApprovalMode(mode),
        }
      : {}),
  });
  spine?.setApprovalListener((request) => agent.notifyApprovalRequired(request));

  return { agent, extensions, mcpHandle, spine };
}

async function allowedExtensionPaths(
  manager: ExtensionPackageManager,
  config: ResolvedAgentConfig,
): Promise<string[]> {
  const installed = await manager.list();
  if (!config.enterprise.enabled) {
    if (config.requireExtensionSignatures) {
      const unsigned = installed.filter((extension) => !extension.signed);
      if (unsigned.length > 0) {
        throw new Error(
          "Unsigned extensions are disabled: " + unsigned.map((item) => item.name).join(", "),
        );
      }
    }
    return installed.map((extension) => extension.entryPath);
  }
  const allowed = new Set(config.enterprise.allowedExtensions ?? []);
  return installed
    .filter((extension) => allowed.has(extension.name))
    .map((extension) => {
      if (!extension.signed) throw new Error(`Enterprise extension is unsigned: ${extension.name}`);
      const privileged = (extension.manifest.permissions ?? []).filter((permission) =>
        ["network", "shell"].includes(permission),
      );
      if (privileged.length > 0) {
        throw new Error(
          `Enterprise extension ${extension.name} requests privileged permission(s): ${privileged.join(", ")}`,
        );
      }
      return extension.entryPath;
    });
}

function enterpriseAuditJournal(config: ResolvedAgentConfig): FileAuditJournal | undefined {
  if (!config.enterprise.enabled) return undefined;
  const keyEnvironment = config.enterprise.auditHmacKeyEnv ?? "FOCUSCODE_AUDIT_HMAC_KEY";
  const key = process.env[keyEnvironment];
  if (!key) {
    throw new Error(`Enterprise mode requires a 32+ byte audit key in ${keyEnvironment}`);
  }
  return new FileAuditJournal({
    directory: config.enterprise.auditDirectory ?? join(homedir(), ".focuscode", "audit"),
    hmacKey: key,
  });
}
