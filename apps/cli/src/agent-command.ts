import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  CodingAgent,
  ExtensionHost,
  FileAuditJournal,
  ProcessExtensionHost,
  SessionStore,
  createCodingToolRegistry,
  createModelClient,
  expandFileMentions,
  listProviderPresets,
  loadImageAttachments,
  loadAgentResources,
  renderResourcePrompt,
  renderSessionHtml,
  resolveAgentConfig,
  type AgentConfigOverrides,
  type ApprovalHandler,
  type ApprovalMode,
  type ExtensionHostLike,
  type KeyDecisionRule,
  type ModelClient,
  type ModelPricing,
  type ModelProfile,
  type ResolvedAgentConfig,
  type SpecEngineDeps,
  type SpecEngineOptions,
  type SpecStageModel,
  type TokenUsage,
} from "@focuscode/agent-runtime";
import { ExtensionPackageManager } from "@focuscode/ecosystem";
import { createSandbox } from "@focuscode/sandbox";
import { createSessionEffectSpine } from "@focuscode/sdk";
import type { CommandPrefixRule } from "@focuscode/action-domain";
import { parseAgentArgs, type AgentCliArgs } from "./agent-args.js";
import { oauthAccessTokenProvider } from "./auth-command.js";
import { HumanEventRenderer, jsonEventWriter, promptApproval, shortId } from "./agent-output.js";
import { runInteractive, TerminalPrompter } from "./interactive.js";
import { wireMcpServers } from "./mcp-wiring.js";
import { buildModelClientChain } from "./model-client-wiring.js";
import { rpcEventSink, runRpc } from "./rpc.js";
import { defaultExtensionDirectory } from "./platform-command.js";
import { runFullScreenAgent } from "./tui.js";
import { runAcpServer } from "./acp-server.js";
import {
  readFile as readGlobalConfigFile,
  writeFile as writeGlobalConfigFile,
  mkdir,
} from "node:fs/promises";
import { dirname } from "node:path";

function globalConfigPath(): string {
  return resolve(join(homedir(), ".focuscode", "config.json"));
}

async function readGlobalConfig(): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(globalConfigPath(), "utf8");
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeGlobalConfig(config: Record<string, unknown>): Promise<void> {
  const path = globalConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export const CLI_VERSION = "0.5.0";

export function isAgentInvocation(argv: string[]): boolean {
  const first = argv[0];
  return (
    !first ||
    ![
      "init",
      "run",
      "inspect",
      "export",
      "auth",
      "extension",
      "share",
      "sandbox",
      "mascots",
      "themes",
      "doctor",
      "skins",
      "character",
      "companion",
    ].includes(first)
  );
}

export async function runAgentCommand(argv: string[]): Promise<void> {
  const args = parseAgentArgs(argv);
  if (args.help) {
    printAgentHelp();
    return;
  }
  if (args.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (args.listProviders) {
    printProviders();
    return;
  }
  if (args.listModels) {
    printModels();
    return;
  }
  const cwd = resolve(args.cwd);
  const sessionDirectory = resolve(args.sessionDirectory ?? defaultSessionDirectory(cwd));
  const sessions = new SessionStore(sessionDirectory, !args.noSession);
  if (args.listSessions) {
    printSessionList(await sessions.list(cwd));
    return;
  }
  if (args.exportSession) {
    if (!args.session) throw new Error("--export-session requires --session <id>");
    const snapshot = await sessions.load(args.session);
    const output = resolve(args.exportSession);
    await writeFile(output, renderSessionHtml(snapshot), "utf8");
    process.stdout.write(`Exported ${output}\n`);
    return;
  }

  const modelSpec = splitModelSpec(args.model, args.provider);
  const config = await resolveAgentConfig(cwd, configOverrides(args, modelSpec));
  let mode = args.mode;
  if (!args.modeExplicit && mode === "tui" && config.tui.enabled === false) {
    mode = "interactive";
  }
  if ((mode === "interactive" || mode === "tui") && !process.stdin.isTTY) mode = "print";
  const effectiveApproval =
    config.approval === "ask" && !process.stdin.isTTY ? "deny" : config.approval;
  if (effectiveApproval !== config.approval) {
    process.stderr.write(
      "Non-interactive input cannot answer approvals; approval mode changed from ask to deny. Use --approval auto-edit or full-auto explicitly.\n",
    );
  }

  const resources = await loadAgentResources({
    cwd,
    projectTrusted: config.projectTrusted,
    configuredInstructions: config.instructions,
  });
  const sandbox = await createSandbox({
    kind: config.sandbox.kind ?? "auto",
    workspaceRoot: cwd,
    ...(config.sandbox.image ? { image: config.sandbox.image } : {}),
    ...(config.sandbox.network ? { network: config.sandbox.network } : {}),
    ...(config.sandbox.requireImageDigest ? { requireImageDigest: true } : {}),
    ...(config.sandbox.allowHostFallback ? { allowHostFallback: true } : {}),
    ...(config.sandbox.vmHost && config.sandbox.vmWorkspace
      ? {
          vm: {
            host: config.sandbox.vmHost,
            remoteWorkspace: config.sandbox.vmWorkspace,
            ...(config.sandbox.vmIdentityFile
              ? { identityFile: config.sandbox.vmIdentityFile }
              : {}),
          },
        }
      : {}),
  });
  if (sandbox.kind === "host") {
    process.stderr.write(
      "Warning: Bash is running as a protected host subprocess, not in OS isolation. Prefer --sandbox auto, gvisor, docker, seatbelt, or vm for untrusted code.\n",
    );
  }
  const registry = await createCodingToolRegistry(cwd, {
    shellExecutor: sandbox,
    ...(config.agent.searchEndpoint ? { searchEndpoint: config.agent.searchEndpoint } : {}),
  });
  const enabled = new Set(
    args.tools ?? config.enabledTools ?? registry.definitions().map((tool) => tool.name),
  );
  const disabled = new Set([...config.disabledTools, ...args.excludeTools]);
  for (const tool of registry.definitions()) {
    if (!enabled.has(tool.name) || disabled.has(tool.name)) registry.unregister(tool.name);
  }
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

  // MCP wiring: register MCP server tools before CodingAgent.create so the
  // agent observes the merged tool set. Pin verification is fail-closed —
  // any mismatch (schema/transport change, missing tool) throws and the CLI
  // exits non-zero. The handle owns the stdio client lifecycle and is closed
  // in the `finally` block below alongside extension disposal.
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

  let sessionId = await selectSession(args, sessions, cwd, config.model);
  const prompter =
    process.stdin.isTTY && mode === "interactive" ? new TerminalPrompter() : undefined;
  const client = buildModelClientChain(config.model, config.fallbackModels, {
    factory: modelClientFactory,
    onFallback: (event) => {
      process.stderr.write(`Fallback: ${event.from} → ${event.to} (${event.reason})\n`);
    },
  });
  const renderer = new HumanEventRenderer({
    quietTools: mode === "print" && !process.stderr.isTTY,
  });
  const baseEventSink =
    mode === "json"
      ? jsonEventWriter()
      : mode === "rpc"
        ? rpcEventSink
        : (event: Parameters<HumanEventRenderer["handle"]>[0]) => renderer.handle(event);
  // Wrap the event sink to intercept spec_confirmation_required events in
  // non-TUI modes. In TUI mode the confirmation UI is handled by the TUI
  // bridge. In interactive mode, prompt the user. In print/json mode,
  // auto-decline to avoid hanging the pipeline indefinitely.
  const eventSink: typeof baseEventSink = (event) => {
    if (event.type === "spec_confirmation_required" && mode !== "tui") {
      const specEngine = agent?.specEngineInstance;
      if (specEngine) {
        if (prompter && mode === "interactive") {
          void (async () => {
            const choices: Record<string, string> = {};
            for (const decision of event.decisions as unknown[]) {
              const d = decision as { id: string; point: string; options: { label: string }[] };
              const labels = d.options.map((o) => o.label).join(", ");
              const answer = await prompter.ask(`${d.point} [${labels}]: `);
              choices[d.id] = answer || d.options[0]!.label;
            }
            specEngine.resolveDecisions(event.specId, choices);
          })();
        } else {
          process.stderr.write(
            `[spec] Auto-declining spec confirmation (non-interactive mode): ${event.specId}\n`,
          );
          specEngine.declineSpec(event.specId);
        }
      }
    }
    return baseEventSink(event);
  };
  let tuiApproval: ((question: string) => Promise<boolean>) | undefined;
  const approve: ApprovalHandler | undefined =
    mode === "tui"
      ? (request) =>
          tuiApproval?.(request.tool.name + " · risk " + request.risk + " · " + request.reason) ??
          Promise.resolve(false)
      : prompter
        ? (request) => promptApproval(request, (question) => prompter.ask(question))
        : undefined;
  const auditJournal = enterpriseAuditJournal(config);
  // The spine needs a stable taskId before agent creation, so pre-create the
  // session (exactly what CodingAgent.create would do) when none was resumed.
  if (config.agent.effectSpine && !sessionId) {
    sessionId = (
      await sessions.create({
        cwd,
        model: config.model,
        ...(args.name ? { name: args.name } : {}),
      })
    ).header.sessionId;
  }
  // The spine is created without any reference to the agent; the approval
  // listener is wired explicitly after CodingAgent.create returns.
  // Load user-configurable command prefix rules from a JSON file. The
  // PrefixRuleEngine constructor runs a self-test that throws on any
  // mismatched match/notMatch example, so bad rules fail at startup.
  const prefixRules = args.commandRulesPath
    ? (JSON.parse(await readFile(resolve(args.commandRulesPath), "utf8")) as CommandPrefixRule[])
    : undefined;
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
        },
        ...(approve ? { approve } : {}),
      })
    : undefined;

  // ─── SpecEngine options & deps ─────────────────────────────────────
  // Build deps first; if deps construction fails, skip SpecEngine entirely
  // rather than crashing on the non-null assertion below.
  const specEngineDeps: SpecEngineDeps | undefined = args.specEngine
    ? buildSpecEngineDeps(config.instructions ?? [])
    : undefined;
  const specEngineOptions: SpecEngineOptions | undefined =
    args.specEngine && specEngineDeps ? await buildSpecEngineOptions(args, config, cwd) : undefined;

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
    // First-wave feature switches: pass config.agent.* through to the agent
    // so checkpoints/diagnostics/delegate can be turned off from config.
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
    // ─── SpecEngine ───────────────────────────────────────────────────
    ...(specEngineOptions && specEngineDeps
      ? { specEngine: specEngineOptions, specEngineDeps }
      : {}),
  });
  // Explicit post-construction wiring: spine approvals emit the same
  // approval_required event (with audit fan-out) as the legacy path.
  spine?.setApprovalListener((request) => agent.notifyApprovalRequired(request));
  sessionId = agent.sessionId;
  if (args.name && (args.session || args.continueSession || args.resume || args.fork)) {
    await agent.nameSession(args.name);
  }

  const stdinText = mode === "rpc" ? "" : await readPipedInput();
  const rawPrompt = [stdinText, args.promptParts.join(" ")].filter(Boolean).join("\n\n");
  const initialPrompt = rawPrompt ? await expandFileMentions(cwd, rawPrompt) : undefined;
  const initialAttachments = await loadImageAttachments(args.imagePaths, {
    cwd,
    allowOutsideWorkspace: true,
    allowRemoteUrls: config.media.allowRemoteImages ?? true,
  });
  const changeModel = async (spec: string): Promise<ModelProfile> => {
    const parsed = splitModelSpec(spec, undefined);
    const next = await resolveAgentConfig(cwd, {
      ...configOverrides(args, parsed),
      projectTrusted: config.projectTrusted,
    });
    await agent.changeModel(
      next.model,
      buildModelClientChain(next.model, next.fallbackModels, { factory: modelClientFactory }),
    );
    return next.model;
  };

  try {
    if (mode === "tui") {
      await runFullScreenAgent({
        agent,
        sessions,
        resources,
        extensions,
        cwd,
        model: config.model,
        approval: effectiveApproval,
        sandbox: sandbox.kind,
        title: config.tui.title ?? "FocusCode",
        theme: args.theme ?? config.tui.theme ?? "foxglow",
        mascot: args.mascot ?? config.tui.mascot ?? "foxy",
        keymap: config.tui.keymap ?? {},
        allowRemoteImages: config.media.allowRemoteImages ?? true,
        ...(args.keymapPath ? { keymapPath: args.keymapPath } : {}),
        ...(initialPrompt ? { initialPrompt } : {}),
        ...(initialAttachments.length ? { initialAttachments } : {}),
        changeModel,
        onReady: (tui) => {
          tuiApproval = (question) => tui.requestApproval(question);
        },
        // Wire vim mode persistence: read the persisted preference from
        // global config and write it back when the user toggles vim mode.
        vimEnabled: (config.tui as Record<string, unknown> | undefined)?.vimEnabled === true,
        onVimToggle: async (enabled: boolean) => {
          try {
            const globalConfig = await readGlobalConfig();
            const tuiConfig = (globalConfig.tui as Record<string, unknown> | undefined) ?? {};
            tuiConfig.vimEnabled = enabled;
            globalConfig.tui = tuiConfig;
            await writeGlobalConfig(globalConfig);
          } catch {
            // Best-effort persistence; ignore write errors.
          }
        },
        // ─── SpecEngine confirmation bridge ───────────────────────────
        // The TUI's spec confirmation UI calls these callbacks when the user
        // confirms or declines key decisions. They forward to the engine's
        // resolver, unblocking the clarify() pipeline.
        ...(agent.specEngineInstance
          ? {
              onSpecConfirm: (specId: string, choices: Record<string, string>) =>
                agent.specEngineInstance?.resolveDecisions(specId, choices),
              onSpecDecline: (specId: string) => agent.specEngineInstance?.declineSpec(specId),
            }
          : {}),
      });
      return;
    }
    if (mode === "interactive") {
      if (!prompter) throw new Error("Interactive mode requires a TTY");
      await runInteractive({
        agent,
        sessions,
        resources,
        extensions,
        prompter,
        ...(initialPrompt ? { initialPrompt } : {}),
        changeModel,
      });
      return;
    }
    if (mode === "rpc") {
      if (initialPrompt) await agent.submit(initialPrompt);
      await runRpc(agent, sessions);
      return;
    }
    if (mode === "acp") {
      await runAcpServer(args, configOverrides(args, modelSpec));
      return;
    }
    if (!initialPrompt) throw new Error(`${mode} mode requires a prompt or piped stdin`);
    const result = await agent.submit({
      text: initialPrompt,
      ...(initialAttachments.length ? { attachments: initialAttachments } : {}),
    });
    renderer.finishLine();
    if (args.cost) printCostPanel(result.usage, config);
    if (["max_rounds", "length", "error"].includes(result.stopped)) process.exitCode = 2;
  } finally {
    prompter?.close();
    await extensions.dispose?.();
    await mcpHandle.close();
  }
}

async function selectSession(
  args: AgentCliArgs,
  sessions: SessionStore,
  cwd: string,
  model: ModelProfile,
): Promise<string | undefined> {
  if (args.fork) {
    const separator = args.fork.indexOf(":");
    const sourceId = separator >= 0 ? args.fork.slice(0, separator) : args.fork;
    const entryId = separator >= 0 ? args.fork.slice(separator + 1) : undefined;
    return (await sessions.fork(sourceId, entryId, model, args.name)).header.sessionId;
  }
  if (args.session) return (await sessions.load(args.session)).header.sessionId;
  if (args.continueSession) return (await sessions.latest(cwd))?.sessionId;
  if (args.resume) {
    const available = await sessions.list(cwd);
    if (available.length === 0) throw new Error("No sessions found for this workspace");
    if (!process.stdin.isTTY) return available[0]!.sessionId;
    process.stdout.write(
      available
        .slice(0, 20)
        .map(
          (session, index) =>
            `${index + 1}. ${session.name ?? shortId(session.sessionId)} — ${session.preview}`,
        )
        .join("\n") + "\n",
    );
    const selector = new TerminalPrompter();
    try {
      const answer = await selector.ask("Resume session number: ");
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || !available[index])
        throw new Error("Invalid session selection");
      return available[index]!.sessionId;
    } finally {
      selector.close();
    }
  }
  return undefined;
}

function configOverrides(
  args: AgentCliArgs,
  modelSpec: { provider?: string; model?: string },
): AgentConfigOverrides {
  return {
    ...(modelSpec.provider ? { provider: modelSpec.provider } : {}),
    ...(modelSpec.model ? { model: modelSpec.model } : {}),
    ...(args.protocol ? { protocol: args.protocol } : {}),
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.apiKeyEnv ? { apiKeyEnv: args.apiKeyEnv } : {}),
    ...(args.authType ? { authType: args.authType } : {}),
    ...(args.oauthAccount ? { oauthAccount: args.oauthAccount } : {}),
    ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.toolMode ? { toolMode: args.toolMode } : {}),
    ...(args.approval ? { approval: args.approval } : {}),
    ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
    ...(args.tools ? { enabledTools: args.tools } : {}),
    ...(args.excludeTools.length ? { disabledTools: args.excludeTools } : {}),
    ...(args.sandbox ||
    args.sandboxImage ||
    args.sandboxNetwork ||
    args.allowHostFallback ||
    args.vmHost ||
    args.vmWorkspace ||
    args.vmIdentity
      ? {
          sandbox: {
            ...(args.sandbox ? { kind: args.sandbox } : {}),
            ...(args.sandboxImage ? { image: args.sandboxImage } : {}),
            ...(args.sandboxNetwork ? { network: args.sandboxNetwork } : {}),
            ...(args.allowHostFallback ? { allowHostFallback: true } : {}),
            ...(args.vmHost ? { vmHost: args.vmHost } : {}),
            ...(args.vmWorkspace ? { vmWorkspace: args.vmWorkspace } : {}),
            ...(args.vmIdentity ? { vmIdentityFile: args.vmIdentity } : {}),
          },
        }
      : {}),
    ...(args.theme || args.mascot
      ? {
          tui: {
            ...(args.theme ? { theme: args.theme } : {}),
            ...(args.mascot ? { mascot: args.mascot } : {}),
          },
        }
      : {}),
    projectTrusted: args.trustProject,
  };
}

/**
 * Build the raw protocol client for a `ModelProfile`. The
 * `CircuitBreakingModelClient` wrapping is handled by
 * `buildModelClientChain` so circuit state is managed uniformly across the
 * primary and every fallback link.
 */
function modelClientFactory(model: ModelProfile) {
  const accessTokenProvider = oauthAccessTokenProvider(model);
  return createModelClient({
    ...model,
    ...(accessTokenProvider ? { accessTokenProvider } : {}),
  });
}

// ─── SpecEngine builders ────────────────────────────────────────────────

const DEFAULT_KEY_DECISION_RULES: KeyDecisionRule[] = [
  {
    name: "destructive-change",
    description: "Any task that deletes files, drops tables, or removes existing functionality",
  },
  {
    name: "arch-decision",
    description:
      "Choice between fundamentally different approaches (new module vs extend existing, REST vs GraphQL)",
  },
  { name: "new-dependency", description: "Introduction of a new npm/package dependency" },
  {
    name: "breaking-change",
    description:
      "Changes to public API, exported interfaces, or config schema that consumers depend on",
  },
  { name: "security-sensitive", description: "Changes to auth, permissions, crypto, or sandbox" },
  { name: "irreversible", description: "Operations that cannot be undone (migrations, publishes)" },
];

function buildSpecEngineDeps(instructions: string[]): SpecEngineDeps {
  return {
    detectProjectType: (dir) => detectProjectType(dir),
    instructions,
    writeFile: (path, content) => writeFile(path, content, "utf8"),
    readFile: (path) => readFile(path, "utf8"),
    listDir: (dir) => readdir(dir),
  };
}

function detectProjectType(dir: string): string {
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) return "typescript-monorepo";
  if (existsSync(join(dir, "package.json"))) return "node-package";
  if (existsSync(join(dir, "go.mod"))) return "go-module";
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "setup.py"))) {
    return "python-package";
  }
  if (existsSync(join(dir, "Cargo.toml"))) return "rust-project";
  return "unknown";
}

async function buildSpecEngineOptions(
  args: AgentCliArgs,
  config: ResolvedAgentConfig,
  cwd: string,
): Promise<SpecEngineOptions> {
  const pipeline: SpecEngineOptions["pipeline"] = {};

  // Build SpecStageModel for a --spec-*-model argument. Resolves the model
  // profile via the same config resolution pipeline as the main model, so
  // provider presets (base-url, api-key-env, etc.) are applied.
  async function buildStageModel(
    modelSpec: string | undefined,
    fallback: SpecStageModel["fallback"],
  ): Promise<SpecStageModel | undefined> {
    if (!modelSpec) return undefined;
    const spec = splitModelSpec(modelSpec, undefined);
    const resolved = await resolveAgentConfig(cwd, {
      ...configOverrides(args, spec),
      projectTrusted: config.projectTrusted,
    });
    return {
      profile: resolved.model,
      client: modelClientFactory(resolved.model),
      fallback,
    };
  }

  const classifierStage = await buildStageModel(args.specClassifierModel, "primary");
  if (classifierStage) pipeline.classifier = classifierStage;

  const drafterStage = await buildStageModel(args.specDrafterModel, "primary");
  if (drafterStage) {
    pipeline.drafter = drafterStage;
    // Enhancer uses the same tier as drafter (3B-7B) unless separately overridden
    pipeline.enhancer = drafterStage;
  }

  // decisionDetector uses the same tier as classifier (1B-2B)
  if (classifierStage) pipeline.decisionDetector = classifierStage;

  return {
    enabled: true,
    autoTrigger: args.specAutoTrigger,
    specDirectory: args.specDirectory ?? "docs/specs",
    maxExplorationRounds: args.specMaxExplorationRounds ?? 6,
    keyDecisionRules: DEFAULT_KEY_DECISION_RULES,
    pipeline,
  };
}

function splitModelSpec(
  model: string | undefined,
  provider: string | undefined,
): { provider?: string; model?: string } {
  if (!model) return provider ? { provider } : {};
  const separator = model.indexOf("/");
  if (!provider && separator > 0) {
    return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
  }
  return { ...(provider ? { provider } : {}), model };
}

async function readPipedInput(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 5_000_000) throw new Error("Piped stdin exceeds 5 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function defaultSessionDirectory(cwd: string): string {
  const digest = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(homedir(), ".focuscode", "sessions", digest);
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

function printProviders(): void {
  process.stdout.write("Provider\tProtocol\tAPI key environment\tDefault base URL\n");
  for (const provider of listProviderPresets()) {
    process.stdout.write(
      `${provider.id}\t${provider.protocol}\t${provider.apiKeyEnv ?? "-"}\t${provider.baseUrl}\n`,
    );
  }
  process.stdout.write("custom\topenai-chat or anthropic-messages\tuser-defined\t--base-url\n");
}

export function printModels(): void {
  // First-wave --list-models: enumerate built-in provider presets and the
  // default model each one resolves to. ProviderPreset only carries the
  // defaults (context/maxOutput/reasoning/toolMode is resolved downstream
  // from PRESETS + AgentConfigFile.models overrides), so we surface the
  // preset defaults here and annotate toolMode as "auto" (the harness
  // default before ModelProfile resolution) when a preset does not pin it.
  const presets = listProviderPresets();
  // Group by provider id (each preset is one provider; this keeps the loop
  // shape stable if PRESETS ever grows sub-entries).
  const byProvider = new Map<string, typeof presets>();
  for (const preset of presets) {
    const list = byProvider.get(preset.id) ?? [];
    list.push(preset);
    byProvider.set(preset.id, list);
  }
  for (const [providerId, list] of byProvider) {
    process.stdout.write(`# ${providerId}\n`);
    for (const preset of list) {
      const model = preset.defaultModel ?? "(user-supplied model id)";
      const context = preset.defaultContextWindow;
      const maxOutput = preset.defaultMaxOutputTokens;
      const reasoning = preset.defaultReasoningEffort ?? "off";
      // Presets do not pin toolMode; the harness defaults to "auto" until
      // ModelProfile resolution applies AgentConfigFile.models overrides.
      const toolMode = "auto";
      process.stdout.write(
        `${providerId}/${model}\tcontext=${context}\tmaxOutput=${maxOutput}\ttoolMode=${toolMode}\treasoning=${reasoning}\n`,
      );
    }
  }
}

export function printCostPanel(usage: TokenUsage, config: ResolvedAgentConfig): void {
  // First-wave --cost panel: resolve pricing by "provider/model" then bare
  // model id (matching AgentConfigFile.pricing keys), compute USD per 1M
  // tokens, and emit to stderr so stdout JSON/print output stays parseable.
  const modelKey = `${config.model.provider}/${config.model.model}`;
  const pricing = config.pricing[modelKey] ?? config.pricing[config.model.model];
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cached = usage.cachedInputTokens ?? 0;
  if (!pricing) {
    process.stderr.write(
      `Cost: ${input} input / ${output} output / ${cached} cached tokens — no pricing configured for ${modelKey} (set config.pricing in agent.json)\n`,
    );
    return;
  }
  const inputCost = (input / 1_000_000) * pricing.input;
  const outputCost = (output / 1_000_000) * pricing.output;
  const cachedCost =
    pricing.cachedInput !== undefined ? (cached / 1_000_000) * pricing.cachedInput : 0;
  const total = inputCost + outputCost + cachedCost;
  process.stderr.write(
    `Cost: $${total.toFixed(6)} (input $${inputCost.toFixed(6)} @ $${pricing.input.toFixed(2)}/M` +
      ` · output $${outputCost.toFixed(6)} @ $${pricing.output.toFixed(2)}/M` +
      (pricing.cachedInput !== undefined
        ? ` · cached $${cachedCost.toFixed(6)} @ $${pricing.cachedInput.toFixed(2)}/M`
        : "") +
      `) — ${input} in / ${output} out / ${cached} cached tokens\n`,
  );
}

function printSessionList(sessions: Awaited<ReturnType<SessionStore["list"]>>): void {
  for (const session of sessions) {
    process.stdout.write(
      `${session.sessionId}\t${session.updatedAt}\t${session.model}\t${session.name ?? ""}\t${session.preview}\n`,
    );
  }
}

export function printAgentHelp(): void {
  process.stdout.write(`FocusCode CLI Coding Agent ${CLI_VERSION}

Usage:
  focuscode [options] [@files...] [prompt...]
  focuscode -p [options] "fix the failing tests"
  focuscode --mode json [options] "review this repository"
  focuscode --mode rpc [options]

Model:
  --provider ID               Built-in or configured provider
  --model [PROVIDER/]ID       Model ID; provider prefix is optional
  --base-url URL              Override provider API base URL
  --protocol PROTOCOL         openai-responses | openai-chat | anthropic-messages | google-gemini
  --api-key KEY               In-memory override; prefer environment variables
  --oauth-account NAME        Use an encrypted OAuth account from focuscode auth login
  --auth-type TYPE            api-key | bearer | none
  --context-window N          Context window used for compaction
  --max-output-tokens N       Per-response output budget
  --tool-mode MODE            native | prompt-json | auto
  --list-providers            List built-in provider presets
  --list-models               List provider/default-model presets with context/maxOutput/toolMode/reasoning
  --cost                      Print a USD cost panel after the run (needs config.pricing)

Execution:
  -p, --print                 Run once and exit
  --mode MODE                 tui | interactive | print | json | rpc | acp
  -i, --image PATH_OR_URL     Attach an image; repeat for multiple images
  --theme ID                  foxglow | aurora | candy | forest | midnight | mono
  --mascot ID                 foxy | mochi | byte | nori | pico | bubu | kumo
  --keymap FILE               JSON key binding overrides
  --approval MODE             ask | auto-edit | full-auto | deny
  --trust-project             Load .focuscode instructions, skills and extensions
  -t, --tools LIST            Tool allowlist
  --exclude-tools LIST        Tool denylist
  --max-rounds N              Maximum model/tool rounds per user turn
  -e, --extension PATH        Load an explicit JavaScript extension
  --command-rules PATH        JSON file with command prefix rules (allow/deny)

Isolation:
  --sandbox KIND              host | docker | gvisor | vm | seatbelt | auto
  --sandbox-image IMAGE       Container image with repository toolchains
  --sandbox-network MODE      none | bridge
  --vm-host HOST              SSH target for a pre-provisioned VM/microVM
  --vm-workspace PATH         Shared workspace path inside the VM
  --vm-identity PATH          SSH identity file
  --allow-host-fallback       Allow auto mode to fall back without OS isolation

Sessions:
  -c, --continue              Continue the most recent workspace session
  -r, --resume                Select a saved session
  --session ID                Resume a session by ID or unique prefix
  --fork ID[:ENTRY]           Fork a session or an earlier entry
  --session-dir PATH          Override session storage
  --no-session                Keep this invocation in memory only
  -n, --name NAME             Name the session
  --list-sessions             List sessions for the current workspace
  --session ID --export-session FILE

Compatibility commands from Harness Alpha remain available:
  focuscode init | run | inspect | export

Spec Engine:
  --spec-engine               Enable the requirement clarification pipeline
  --spec-auto-trigger         Auto-trigger on vague inputs (default: /spec only)
  --spec-dir PATH             Directory for persisted specs (default: docs/specs)
  --spec-max-exploration-rounds N  Max read-only exploration rounds (default: 6)
  --spec-classifier-model [PROVIDER/]ID  Model for classify/detect stages (1B-2B)
  --spec-drafter-model [PROVIDER/]ID     Model for draft/enhance stages (3B-7B)

  When --spec-classifier-model / --spec-drafter-model are omitted, all stages
  use the main model. Example:
  focuscode --spec-engine --spec-classifier-model ollama/qwen2.5:1.5b \\
    --spec-drafter-model ollama/qwen2.5:7b "/spec add user auth"
`);
}
