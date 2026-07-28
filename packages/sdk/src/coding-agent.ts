import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CodingAgent,
  ExtensionHost,
  FileAuditJournal,
  SessionStore,
  createCodingToolRegistry,
  createModelClient,
  loadAgentResources,
  renderResourcePrompt,
  resolveAgentConfig,
  type AgentConfigOverrides,
  type AgentEvent,
  type AgentResources,
  type ApprovalHandler,
  type ApprovalMode,
  type ResolvedAgentConfig,
  type ShellExecutor,
} from "@focuscode/agent-runtime";
import { ExtensionPackageManager } from "@focuscode/ecosystem";
import { createSandbox } from "@focuscode/sandbox";
import { createSessionEffectSpine } from "./effect-spine.js";
import {
  composeEventSink,
  dispatchAgentEvent,
  type AgentHooks,
  type SessionContext,
} from "./hooks.js";

export interface CreateCodingAgentOptions extends AgentConfigOverrides {
  cwd: string;
  sessionDirectory?: string;
  sessionId?: string;
  sessionName?: string;
  persistentSession?: boolean;
  extensionPaths?: string[];
  approve?: ApprovalHandler;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  accessTokenProvider?: () => Promise<string | undefined>;
  shellExecutor?: ShellExecutor;
  /** Route tool calls through the EffectPort spine; defaults to config agent.effectSpine (true). */
  effectSpine?: boolean;
  /**
   * Lifecycle hooks dispatched from `onEvent`. The SDK routes `tool_end` →
   * `postToolUse`, `agent_end` → `stop`, and calls `sessionStart`/`sessionEnd`
   * directly around the session lifecycle. Hooks are optional and run in
   * addition to (not instead of) `onEvent`.
   */
  hooks?: AgentHooks;
}

export interface CreatedCodingAgent {
  agent: CodingAgent;
  sessions: SessionStore;
  extensions: ExtensionHost;
  resources: AgentResources;
  config: ResolvedAgentConfig;
}

export async function createCodingAgent(
  options: CreateCodingAgentOptions,
): Promise<CreatedCodingAgent> {
  const cwd = resolve(options.cwd);
  const config = await resolveAgentConfig(cwd, options);
  const resources = await loadAgentResources({
    cwd,
    projectTrusted: config.projectTrusted,
    configuredInstructions: config.instructions,
  });
  const shellExecutor =
    options.shellExecutor ??
    (await createSandbox({
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
    }));
  if (config.enterprise.enabled && !["docker", "gvisor", "vm"].includes(shellExecutor.kind)) {
    throw new Error(`Enterprise mode rejects non-isolated shell executor: ${shellExecutor.kind}`);
  }
  const registry = await createCodingToolRegistry(cwd, {
    shellExecutor,
  });
  const enabled = new Set(config.enabledTools ?? registry.definitions().map((tool) => tool.name));
  const disabled = new Set(config.disabledTools);
  for (const tool of registry.definitions()) {
    if (!enabled.has(tool.name) || disabled.has(tool.name)) registry.unregister(tool.name);
  }
  const extensions = new ExtensionHost(registry);
  const extensionPackages = new ExtensionPackageManager({
    directory: resolve(config.extensionDirectory ?? join(homedir(), ".focuscode", "extensions")),
  });
  if (config.enterprise.enabled && (options.extensionPaths?.length ?? 0) > 0) {
    throw new Error("Enterprise policy forbids ad-hoc extension paths");
  }
  const installedExtensions = await extensionPackages.list();
  const allowedExtensions = config.enterprise.enabled
    ? installedExtensions.filter((extension) =>
        (config.enterprise.allowedExtensions ?? []).includes(extension.name),
      )
    : installedExtensions;
  if (
    config.requireExtensionSignatures &&
    allowedExtensions.some((extension) => !extension.signed)
  ) {
    throw new Error("Unsigned extensions are disabled");
  }
  if (
    config.enterprise.enabled &&
    allowedExtensions.some((extension) =>
      (extension.manifest.permissions ?? []).some((permission) =>
        ["network", "shell"].includes(permission),
      ),
    )
  ) {
    throw new Error("Enterprise extensions may not request network or shell permissions");
  }
  await extensions.load([
    ...allowedExtensions.map((extension) => extension.entryPath),
    ...(config.enterprise.enabled && !config.enterprise.allowProjectExtensions
      ? []
      : (resources.extensionPaths ?? [])),
    ...(options.extensionPaths ?? []),
  ]);
  const sessions = new SessionStore(
    resolve(options.sessionDirectory ?? defaultSessionDirectory(cwd)),
    options.persistentSession ?? true,
  );
  // The spine needs a stable taskId before agent creation, so pre-create the
  // session (exactly what CodingAgent.create would do) when none was resumed.
  const spineEnabled = options.effectSpine ?? config.agent.effectSpine;
  let sessionId = options.sessionId;
  if (spineEnabled && !sessionId) {
    sessionId = (
      await sessions.create({
        cwd,
        model: config.model,
        ...(options.sessionName ? { name: options.sessionName } : {}),
      })
    ).header.sessionId;
  }
  // The spine is created without any reference to the agent; the approval
  // listener is wired explicitly after CodingAgent.create returns.
  const spine = spineEnabled
    ? createSessionEffectSpine({
        cwd,
        registry,
        taskId: sessionId!,
        model: config.model,
        permission: {
          mode: config.approval,
          projectTrusted: config.projectTrusted,
          protectedPaths: config.protectedPaths,
        },
        ...(options.approve ? { approve: options.approve } : {}),
      })
    : undefined;
  const eventSink = composeEventSink({ cwd, onEvent: options.onEvent, hooks: options.hooks });
  const agent = await CodingAgent.create({
    cwd,
    model: config.model,
    modelClient: createModelClient({
      ...config.model,
      ...(options.accessTokenProvider ? { accessTokenProvider: options.accessTokenProvider } : {}),
    }),
    tools: registry.values(),
    toolRegistry: registry,
    permission: {
      mode: config.approval,
      projectTrusted: config.projectTrusted,
      protectedPaths: config.protectedPaths,
      ...(options.approve ? { approve: options.approve } : {}),
    },
    sessionStore: sessions,
    ...(sessionId ? { sessionId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    instructions: [renderResourcePrompt(resources)],
    maxRounds: config.maxRounds,
    steeringMaximum: config.steeringMaximum,
    steeringDelivery: config.steeringDelivery,
    ...(eventSink ? { eventSink } : {}),
    extensionHost: extensions,
    ...(config.enterprise.enabled ? { auditJournal: createEnterpriseAudit(config) } : {}),
    ...(spine
      ? {
          effectPort: spine.effectPort,
          effectContext: spine.effectContext,
          onApprovalModeChange: (mode: ApprovalMode) => spine.setApprovalMode(mode),
        }
      : {}),
  });
  // Explicit post-construction wiring: spine approvals emit the same
  // approval_required event (with audit fan-out) as the legacy path.
  spine?.setApprovalListener((request) => agent.notifyApprovalRequired(request));
  return { agent, sessions, extensions, resources, config };
}

function createEnterpriseAudit(config: ResolvedAgentConfig): FileAuditJournal {
  const environment = config.enterprise.auditHmacKeyEnv ?? "FOCUSCODE_AUDIT_HMAC_KEY";
  const key = process.env[environment];
  if (!key) throw new Error(`Enterprise mode requires a 32+ byte audit key in ${environment}`);
  return new FileAuditJournal({
    directory: config.enterprise.auditDirectory ?? join(homedir(), ".focuscode", "audit"),
    hmacKey: key,
  });
}

function defaultSessionDirectory(cwd: string): string {
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(homedir(), ".focuscode", "sessions", digest);
}
