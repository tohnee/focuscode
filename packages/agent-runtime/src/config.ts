import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ApprovalMode,
  ModelCapabilities,
  ModelProfile,
  ModelReliabilityPolicy,
  ProviderCompatibility,
  ReasoningEffort,
} from "./types.js";
import type { McpServerSpec, McpToolPinV1 } from "./mcp.js";
import type { SkillManifest } from "./skills.js";

export interface ProviderPreset {
  id: string;
  protocol: ModelProfile["protocol"];
  baseUrl: string;
  apiKeyEnv?: string;
  defaultAuthType?: ModelProfile["authType"];
  defaultModel?: string;
  /** Version-pinned revision the defaultModel alias is expected to resolve to. */
  defaultRevision?: string;
  defaultContextWindow: number;
  defaultMaxOutputTokens: number;
  defaultReasoningEffort?: ReasoningEffort;
  capabilities?: ModelCapabilities;
  compatibility?: ProviderCompatibility;
  reliability?: Partial<ModelReliabilityPolicy>;
  extraHeaders?: Record<string, string>;
}

export interface ModelProfilePreset {
  protocol?: ModelProfile["protocol"];
  baseUrl?: string;
  apiKeyEnv?: string;
  authType?: ModelProfile["authType"];
  revision?: string;
  expectedSystemFingerprint?: string;
  systemFingerprintPolicy?: ModelProfile["systemFingerprintPolicy"];
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  toolMode?: ModelProfile["toolMode"];
  capabilities?: ModelCapabilities;
  compatibility?: ProviderCompatibility;
  reliability?: Partial<ModelReliabilityPolicy>;
  extraHeaders?: Record<string, string>;
}

/**
 * A fallback model entry in `AgentConfigFile.fallbackModels`. Mirrors
 * `ModelProfilePreset` but pins the `provider` and `model` lookup keys so the
 * resolver can locate the matching `ProviderPreset` and produce a fully
 * resolved `ModelProfile` for each chain entry. The remaining fields override
 * the provider preset defaults exactly like `ModelProfilePreset` does for the
 * primary model.
 */
export interface FallbackModelPreset extends ModelProfilePreset {
  provider: string;
  model: string;
}

/**
 * Configuration source layers, in priority order (low → high).
 *
 * - `user` — `~/.focuscode/config.json`, the global user-level config.
 * - `project` — `<cwd>/.focuscode/agent.json`, the shared project config.
 *   Requires `projectTrusted: true` to load.
 * - `local` — `<cwd>/.focuscode.local/agent.json`, the personal local
 *   override layer. Not subject to `projectTrusted` because it is a
 *   personal file (typically git-ignored) owned by the current user.
 *
 * The `settingSources` field in the **user** config declares which layers
 * are allowed to load. Declarations in project/local configs are ignored
 * to prevent a malicious project from widening its own trust scope.
 */
export type SettingSource = "project" | "local" | "user";

export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = ["user", "project", "local"];

export interface AgentConfigFile {
  schemaVersion?: "focuscode-agent.v1";
  /**
   * Declares which configuration layers may be loaded. Only honored when
   * declared in the **user** (global) config; project/local declarations
   * are ignored to prevent trust-scope escalation. Defaults to all three
   * layers when absent.
   */
  settingSources?: SettingSource[];
  provider?: string;
  model?: string;
  revision?: string;
  expectedSystemFingerprint?: string;
  systemFingerprintPolicy?: "fail" | "warn" | "off";
  protocol?: ModelProfile["protocol"];
  baseUrl?: string;
  apiKeyEnv?: string;
  authType?: ModelProfile["authType"];
  oauthAccount?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  toolMode?: ModelProfile["toolMode"];
  /**
   * Ordered fallback model chain. When the primary model returns a retryable
   * error (HTTP 429/5xx, circuit open, timeout) or `stopReason === "error"`,
   * the agent runtime retries the in-flight request on each fallback in
   * declared order until one succeeds. Each entry resolves into a full
   * `ModelProfile` using the same provider-preset lookup path as the primary.
   */
  fallbackModels?: FallbackModelPreset[];
  approval?: ApprovalMode;
  maxRounds?: number;
  steeringMaximum?: number;
  steeringDelivery?: "all" | "one-at-a-time";
  protectedPaths?: string[];
  instructions?: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  providers?: Record<string, Partial<ProviderPreset>>;
  models?: Record<string, ModelProfilePreset>;
  agent?: {
    /**
     * Route session tool calls through the EffectPort spine (Policy → Grant →
     * Receipt). Default true; explicit false keeps the legacy direct-execution
     * path as an escape hatch.
     */
    effectSpine?: boolean;
    /** Snapshot write/edit/apply_patch targets for file-level undo. Default true. */
    checkpoints?: boolean;
    /**
     * Append language diagnostics after successful edits. Default true.
     * boolean: true = auto-detect all providers, false = disabled.
     * object: explicitly specify provider ids to run.
     */
    diagnostics?: boolean | { providers?: string[] };
    /** Register the delegate sub-agent tool. Default true. */
    enableDelegate?: boolean;
    /** Custom web_search endpoint: GET ?q= returning JSON [{title,url,snippet}]. */
    searchEndpoint?: string;
  };
  mcp?: {
    servers?: McpServerSpec[];
    /**
     * Pins enforcing fail-closed verification of MCP tool schemas and
     * transports. When declared, every pin must match an observed tool on
     * the connected server; any mismatch (schema/transport change, missing
     * tool) prevents the agent from starting.
     */
    pins?: McpToolPinV1[];
  };
  /**
   * Declarative skills manifest: a path (absolute or relative to the project
   * config file) to a JSON file matching the `focuscode-skills.v1` schema, or
   * an inline manifest object. Skills are loaded by the agent runtime, not by
   * the config resolver; this field only records the source.
   */
  skills?: {
    manifest?: string | SkillManifest;
  };
  /**
   * Goal-driven self-iteration loop defaults. The agent runtime enforces
   * these as hard upper bounds; per-call options may be lower but not higher.
   */
  loop?: {
    maxIterations?: number;
    tokenBudget?: number;
  };
  /**
   * Task graph execution defaults. The agent runtime enforces these as hard
   * upper bounds when the model invokes the `graph` tool.
   */
  graph?: {
    maxConcurrency?: number;
    continueOnError?: boolean;
  };
  /**
   * Agent team execution defaults. The agent runtime enforces these as hard
   * upper bounds when the model invokes the `team` tool.
   */
  team?: {
    maxConcurrency?: number;
    continueOnError?: boolean;
    maxTasks?: number;
  };
  /** USD per 1M tokens, keyed by "provider/model" or bare model id. */
  pricing?: Record<string, ModelPricing>;
  sandbox?: {
    kind?: "host" | "docker" | "gvisor" | "vm" | "seatbelt" | "auto";
    image?: string;
    network?: "none" | "bridge";
    allowHostFallback?: boolean;
    requireImageDigest?: boolean;
    vmHost?: string;
    vmWorkspace?: string;
    vmIdentityFile?: string;
  };
  tui?: {
    enabled?: boolean;
    title?: string;
    theme?: string;
    mascot?: string;
    keymap?: Record<string, string>;
  };
  media?: {
    allowRemoteImages?: boolean;
  };
  extensions?: {
    /** Extension host: in-process trusted code, or one child process per extension. */
    host?: "in-process" | "process";
  };
  enterprise?: {
    enabled?: boolean;
    allowedProviders?: string[];
    allowedModels?: string[];
    requireIsolatedSandbox?: boolean;
    auditDirectory?: string;
    auditHmacKeyEnv?: string;
    allowProjectExtensions?: boolean;
    allowedExtensions?: string[];
  };
  extensionDirectory?: string;
  requireExtensionSignatures?: boolean;
  shareEndpoint?: string;
}

export interface AgentConfigOverrides extends AgentConfigFile {
  apiKey?: string;
  projectTrusted?: boolean;
  globalConfigPath?: string;
  projectConfigPath?: string;
  /**
   * Path to the local (personal) config layer. Defaults to
   * `<cwd>/.focuscode.local/agent.json`. The local layer is loaded
   * regardless of `projectTrusted` because it is a personal override
   * file owned by the current user, not the project.
   */
  localConfigPath?: string;
}

/** USD per 1M tokens for one model. */
export interface ModelPricing {
  input: number;
  output: number;
  cachedInput?: number;
}

export interface ResolvedAgentConfig {
  model: ModelProfile;
  /**
   * Resolved fallback model chain. Empty when no `fallbackModels` declared.
   * Each entry is a fully resolved `ModelProfile` (provider preset merged with
   * per-entry overrides) suitable for constructing a `ModelClient` via
   * `createModelClient`. Enterprise policy is enforced on each entry.
   */
  fallbackModels: ModelProfile[];
  approval: ApprovalMode;
  maxRounds: number;
  projectTrusted: boolean;
  protectedPaths: string[];
  instructions: string[];
  enabledTools?: string[];
  disabledTools: string[];
  agent: {
    effectSpine: boolean;
    checkpoints: boolean;
    diagnostics: { enabled: boolean; providers: string[] | undefined };
    enableDelegate: boolean;
    searchEndpoint?: string;
  };
  mcp: { servers: McpServerSpec[]; pins: McpToolPinV1[] };
  skills: { manifest: string | SkillManifest | undefined };
  loop: { maxIterations: number; tokenBudget: number };
  graph: { maxConcurrency: number; continueOnError: boolean };
  team: { maxConcurrency: number; continueOnError: boolean; maxTasks: number };
  pricing: Record<string, ModelPricing>;
  sandbox: NonNullable<AgentConfigFile["sandbox"]>;
  tui: NonNullable<AgentConfigFile["tui"]>;
  media: NonNullable<AgentConfigFile["media"]>;
  extensions: { host: "in-process" | "process" };
  enterprise: NonNullable<AgentConfigFile["enterprise"]>;
  steeringMaximum: number;
  steeringDelivery: "all" | "one-at-a-time";
  extensionDirectory?: string;
  requireExtensionSignatures: boolean;
  shareEndpoint?: string;
  sources: string[];
  /**
   * Effective configuration source layers (resolved from the user-layer
   * `settingSources` declaration, or the default `["user", "project",
   * "local"]` when absent). Reflects which layers are *permitted* to
   * load, not which files actually existed on disk.
   */
  settingSources: SettingSource[];
}

// defaultRevision pins the version-pinned ID each built-in (unpinned) model
// alias is expected to resolve to. These are placeholders: production
// deployments must replace them with the measured revision of their endpoint.
const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    id: "openai",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  anthropic: {
    id: "anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    defaultContextWindow: 200_000,
    defaultMaxOutputTokens: 16_384,
    compatibility: { cacheControl: { mode: "anthropic-ephemeral" } },
  },
  gemini: {
    id: "gemini",
    protocol: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 65_536,
  },
  deepseek: {
    id: "deepseek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-pro",
    defaultRevision: "deepseek-v4-pro-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 384_000,
    defaultReasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      requiresAssistantContentForToolCalls: true,
      supportsReasoningEffort: true,
      supportsToolChoice: false,
      supportsTemperature: false,
      reasoningEffortMap: {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "high",
        max: "max",
      },
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  openrouter: {
    id: "openrouter",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  qwen: {
    id: "qwen",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3-coder-plus",
    defaultRevision: "qwen3-coder-plus-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 65_536,
    defaultReasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "qwen",
      supportsReasoningEffort: true,
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  "qwen-intl": {
    id: "qwen-intl",
    protocol: "openai-chat",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3-coder-plus",
    defaultRevision: "qwen3-coder-plus-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 65_536,
    defaultReasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "qwen",
      supportsReasoningEffort: true,
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  kimi: {
    id: "kimi",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k3",
    defaultRevision: "kimi-k3-2026-06-15",
    defaultContextWindow: 1_048_576,
    defaultMaxOutputTokens: 131_072,
    defaultReasoningEffort: "max",
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      requiresAssistantContentForToolCalls: true,
      supportsReasoningEffort: true,
      reasoningEffortMap: {
        minimal: "max",
        low: "max",
        medium: "max",
        high: "max",
        max: "max",
      },
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  "kimi-cn": {
    id: "kimi-cn",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k3",
    defaultRevision: "kimi-k3-2026-06-15",
    defaultContextWindow: 1_048_576,
    defaultMaxOutputTokens: 131_072,
    defaultReasoningEffort: "max",
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      requiresAssistantContentForToolCalls: true,
      supportsReasoningEffort: true,
      reasoningEffortMap: {
        minimal: "max",
        low: "max",
        medium: "max",
        high: "max",
        max: "max",
      },
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  moonshot: {
    id: "moonshot",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k3",
    defaultRevision: "kimi-k3-2026-06-15",
    defaultContextWindow: 1_048_576,
    defaultMaxOutputTokens: 131_072,
    defaultReasoningEffort: "max",
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      requiresAssistantContentForToolCalls: true,
      supportsReasoningEffort: true,
      reasoningEffortMap: {
        minimal: "max",
        low: "max",
        medium: "max",
        high: "max",
        max: "max",
      },
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  "kimi-coding": {
    id: "kimi-coding",
    protocol: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding",
    apiKeyEnv: "KIMI_API_KEY",
    defaultModel: "k3",
    defaultRevision: "k3-2026-06-15",
    defaultContextWindow: 262_144,
    defaultMaxOutputTokens: 32_768,
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    extraHeaders: { "user-agent": "KimiCLI/1.5" },
  },
  glm: {
    id: "glm",
    protocol: "openai-chat",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    defaultModel: "glm-5.2",
    defaultRevision: "glm-5.2-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 131_072,
    defaultReasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "zai",
      supportsReasoningEffort: true,
      zaiToolStream: true,
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  ark: {
    id: "ark",
    protocol: "openai-chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    apiKeyEnv: "ARK_API_KEY",
    defaultModel: "glm-5.2",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 8_192,
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      // ARK exposes a plain OpenAI-compatible surface (no zai thinking format).
      thinkingFormat: "openai",
      supportsReasoningEffort: false,
    },
  },
  "glm-cn": {
    id: "glm-cn",
    protocol: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    defaultModel: "glm-5.2",
    defaultRevision: "glm-5.2-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 131_072,
    defaultReasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    compatibility: {
      thinkingFormat: "zai",
      supportsReasoningEffort: true,
      zaiToolStream: true,
      cacheControl: { mode: "openai-prefix", minPrefixTokens: 1024 },
    },
  },
  minimax: {
    id: "minimax",
    protocol: "anthropic-messages",
    baseUrl: "https://api.minimax.io/anthropic",
    apiKeyEnv: "MINIMAX_API_KEY",
    defaultModel: "MiniMax-M3",
    defaultRevision: "MiniMax-M3-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 131_072,
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    compatibility: {
      anthropicThinking: "adaptive",
      cacheControl: { mode: "anthropic-ephemeral" },
    },
  },
  "minimax-cn": {
    id: "minimax-cn",
    protocol: "anthropic-messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiKeyEnv: "MINIMAX_API_KEY",
    defaultModel: "MiniMax-M3",
    defaultRevision: "MiniMax-M3-2026-06-15",
    defaultContextWindow: 1_000_000,
    defaultMaxOutputTokens: 131_072,
    capabilities: { input: ["text", "image"], reasoning: true, toolCalling: true },
    compatibility: {
      anthropicThinking: "adaptive",
      cacheControl: { mode: "anthropic-ephemeral" },
    },
  },
  ollama: {
    id: "ollama",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultContextWindow: 32_768,
    defaultMaxOutputTokens: 8_192,
  },
  llamacpp: {
    id: "llamacpp",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:8080/v1",
    defaultContextWindow: 32_768,
    defaultMaxOutputTokens: 8_192,
  },
  vllm: {
    id: "vllm",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  lmstudio: {
    id: "lmstudio",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  sglang: {
    id: "sglang",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:30000/v1",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  groq: {
    id: "groq",
    protocol: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  mistral: {
    id: "mistral",
    protocol: "openai-chat",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
  xai: {
    id: "xai",
    protocol: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    defaultContextWindow: 256_000,
    defaultMaxOutputTokens: 32_768,
  },
  together: {
    id: "together",
    protocol: "openai-chat",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    defaultContextWindow: 128_000,
    defaultMaxOutputTokens: 16_384,
  },
};

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  input: ["text"],
  reasoning: false,
  toolCalling: true,
};

const DEFAULT_COMPATIBILITY: ProviderCompatibility = {
  supportsParallelToolCalls: true,
  supportsStreamUsage: true,
  supportsToolChoice: true,
  supportsTemperature: true,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
  requiresReasoningContentOnAssistantMessages: false,
  requiresToolResultName: false,
  requiresAssistantContentForToolCalls: false,
  zaiToolStream: false,
  reasoningEffortMap: {},
  anthropicThinking: "omit",
  anthropicThinkingBudgetTokens: 16_384,
};

const DEFAULT_RELIABILITY: Required<ModelReliabilityPolicy> = {
  timeoutMs: 300_000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  retryMaximumDelayMs: 10_000,
  circuitThreshold: 5,
  circuitCooldownMs: 30_000,
  maxConcurrency: 8,
};

const DEFAULT_PROTECTED_PATHS = [
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "credentials.json",
  "secrets",
  "node_modules",
  ".focuscode",
];

export async function resolveAgentConfig(
  cwd: string,
  overrides: AgentConfigOverrides = {},
): Promise<ResolvedAgentConfig> {
  const projectTrusted = overrides.projectTrusted ?? false;
  const globalPath = resolve(
    overrides.globalConfigPath ?? join(homedir(), ".focuscode", "config.json"),
  );
  const projectPath = resolve(
    overrides.projectConfigPath ?? join(resolve(cwd), ".focuscode", "agent.json"),
  );
  const localPath = resolve(
    overrides.localConfigPath ?? join(resolve(cwd), ".focuscode.local", "agent.json"),
  );
  // ─── L1: 三层配置加载开始（debug 级别）────────────────────────────
  // 列出预期路径，便于诊断配置加载问题。
  if (process.env.FOCUSCODE_DEBUG_CONFIG) {
    process.stderr.write(
      `[config] loading layers: user=${globalPath} project=${projectPath} local=${localPath}\n`,
    );
  }
  const sources: string[] = [];
  const global = await readConfigIfPresent(globalPath);
  if (global) sources.push(globalPath);
  // settingSources 仅从 user (global) 层读取，project/local 声明被忽略
  // 以防止恶意项目通过 settingSources: ["user"] 关闭 local 覆盖层。
  const declaredSources = global?.settingSources;
  const settingSources: SettingSource[] = validateSettingSources(declaredSources);
  const allowProject = settingSources.includes("project");
  const allowLocal = settingSources.includes("local");
  const project =
    projectTrusted && allowProject ? await readConfigIfPresent(projectPath) : undefined;
  if (project) sources.push(projectPath);
  // local 层不受 projectTrusted 限制：它是个人本地文件（通常 git-ignored），
  // 由当前用户拥有。即便项目不受信任，个人本地覆盖仍应生效。
  const local = allowLocal ? await readConfigIfPresent(localPath) : undefined;
  if (local) sources.push(localPath);
  // ─── L2: 每层加载完成（info 级别）────────────────────────────────
  if (process.env.FOCUSCODE_DEBUG_CONFIG) {
    process.stderr.write(
      `[config] layers loaded: user=${global ? "yes" : "no"} project=${project ? "yes" : "no"} local=${local ? "yes" : "no"} (settingSources=${settingSources.join(",")})\n`,
    );
  }
  const merged = mergeConfig(global, project, local, overrides);
  validateAgentConfig(merged, "merged configuration");
  const customPresets = {
    ...(global?.providers ?? {}),
    ...(project?.providers ?? {}),
    ...(local?.providers ?? {}),
    ...(overrides.providers ?? {}),
  };
  const providerId = merged.provider ?? inferProviderFromEnvironment() ?? "openai";
  const basePreset = PRESETS[providerId];
  const custom = customPresets[providerId];
  if (!basePreset && !custom && !merged.baseUrl) {
    throw new Error(`Unknown provider ${providerId}; configure baseUrl and protocol`);
  }
  const presetApiKeyEnv = merged.apiKeyEnv ?? custom?.apiKeyEnv ?? basePreset?.apiKeyEnv;
  const preset: ProviderPreset = {
    id: providerId,
    protocol: merged.protocol ?? custom?.protocol ?? basePreset?.protocol ?? "openai-chat",
    baseUrl: merged.baseUrl ?? custom?.baseUrl ?? basePreset?.baseUrl ?? "",
    ...(presetApiKeyEnv ? { apiKeyEnv: presetApiKeyEnv } : {}),
    defaultContextWindow:
      custom?.defaultContextWindow ?? basePreset?.defaultContextWindow ?? 128_000,
    defaultMaxOutputTokens:
      custom?.defaultMaxOutputTokens ?? basePreset?.defaultMaxOutputTokens ?? 16_384,
    ...((custom?.defaultModel ?? basePreset?.defaultModel)
      ? { defaultModel: (custom?.defaultModel ?? basePreset?.defaultModel)! }
      : {}),
    ...((custom?.defaultRevision ?? basePreset?.defaultRevision)
      ? { defaultRevision: (custom?.defaultRevision ?? basePreset?.defaultRevision)! }
      : {}),
    ...((custom?.defaultReasoningEffort ?? basePreset?.defaultReasoningEffort)
      ? {
          defaultReasoningEffort: (custom?.defaultReasoningEffort ??
            basePreset?.defaultReasoningEffort)!,
        }
      : {}),
    capabilities: custom?.capabilities ?? basePreset?.capabilities ?? DEFAULT_CAPABILITIES,
    compatibility: {
      ...DEFAULT_COMPATIBILITY,
      ...basePreset?.compatibility,
      ...custom?.compatibility,
    },
    reliability: {
      ...DEFAULT_RELIABILITY,
      ...basePreset?.reliability,
      ...custom?.reliability,
    },
    extraHeaders: { ...basePreset?.extraHeaders, ...custom?.extraHeaders },
    ...((merged.authType ?? custom?.defaultAuthType ?? basePreset?.defaultAuthType)
      ? {
          defaultAuthType:
            merged.authType ?? custom?.defaultAuthType ?? basePreset?.defaultAuthType,
        }
      : {}),
  };
  const modelId = merged.model ?? process.env.FOCUSCODE_MODEL ?? preset.defaultModel;
  if (!modelId) {
    throw new Error("No model selected. Use --model, FOCUSCODE_MODEL, or config.json");
  }
  const modelPreset = merged.models?.[`${providerId}/${modelId}`] ?? merged.models?.[modelId] ?? {};
  const modelBaseUrl = modelPreset.baseUrl ?? preset.baseUrl;
  if (!modelBaseUrl) throw new Error(`Provider ${providerId} has no baseUrl`);
  const modelApiKeyEnv = modelPreset.apiKeyEnv ?? preset.apiKeyEnv;
  const apiKey =
    overrides.apiKey ??
    process.env.FOCUSCODE_API_KEY ??
    (modelApiKeyEnv ? process.env[modelApiKeyEnv] : undefined);
  const authType = merged.authType ?? modelPreset.authType ?? preset.defaultAuthType ?? "api-key";
  if (modelApiKeyEnv && !apiKey && authType === "api-key" && !merged.oauthAccount) {
    throw new Error(`Provider ${providerId} requires ${modelApiKeyEnv}; set it or pass --api-key`);
  }
  const enterpriseEnabled = merged.enterprise?.enabled ?? false;
  const expectedSystemFingerprint =
    merged.expectedSystemFingerprint ?? modelPreset.expectedSystemFingerprint;
  const systemFingerprintPolicy =
    merged.systemFingerprintPolicy ??
    modelPreset.systemFingerprintPolicy ??
    (expectedSystemFingerprint ? (enterpriseEnabled ? "warn" : "fail") : undefined);
  const model = resolveModelProfile({
    providerId,
    modelId,
    modelPreset,
    preset,
    apiKey,
    apiKeyEnv: modelApiKeyEnv,
    authType: merged.oauthAccount ? "bearer" : authType,
    revision: merged.revision ?? modelPreset.revision ?? preset.defaultRevision,
    expectedSystemFingerprint,
    systemFingerprintPolicy,
    contextWindow: merged.contextWindow ?? modelPreset.contextWindow,
    maxOutputTokens: merged.maxOutputTokens ?? modelPreset.maxOutputTokens,
    temperature: merged.temperature ?? modelPreset.temperature,
    reasoningEffort:
      merged.reasoningEffort ??
      modelPreset.reasoningEffort ??
      preset.defaultReasoningEffort ??
      ((modelPreset.capabilities ?? preset.capabilities)?.reasoning ? "medium" : "off"),
    toolMode: merged.toolMode ?? modelPreset.toolMode,
    ...(merged.oauthAccount ? { oauthAccount: merged.oauthAccount } : {}),
  });
  enforceEnterprisePolicy(merged, providerId, modelId, model.revision);
  const fallbackModels = resolveFallbackModels(merged, customPresets, enterpriseEnabled);
  return {
    model,
    fallbackModels,
    approval: validApproval(merged.approval) ? merged.approval : "ask",
    maxRounds: boundedInteger(merged.maxRounds, 40, 1, 200),
    steeringMaximum: boundedInteger(merged.steeringMaximum, 32, 1, 1_000),
    steeringDelivery: merged.steeringDelivery ?? "all",
    projectTrusted,
    protectedPaths: [...new Set([...DEFAULT_PROTECTED_PATHS, ...(merged.protectedPaths ?? [])])],
    instructions: merged.instructions ?? [],
    ...(merged.enabledTools ? { enabledTools: merged.enabledTools } : {}),
    disabledTools: merged.disabledTools ?? [],
    agent: {
      effectSpine: merged.agent?.effectSpine ?? true,
      checkpoints: merged.agent?.checkpoints ?? true,
      diagnostics: resolveDiagnosticsConfig(merged.agent?.diagnostics),
      enableDelegate: merged.agent?.enableDelegate ?? true,
      ...(merged.agent?.searchEndpoint ? { searchEndpoint: merged.agent.searchEndpoint } : {}),
    },
    mcp: {
      servers: merged.mcp?.servers ?? [],
      pins: merged.mcp?.pins ?? [],
    },
    skills: { manifest: merged.skills?.manifest },
    loop: {
      maxIterations: boundedInteger(merged.loop?.maxIterations, 8, 1, 100),
      tokenBudget: boundedInteger(merged.loop?.tokenBudget, 200_000, 1_000, 10_000_000),
    },
    graph: {
      maxConcurrency: boundedInteger(merged.graph?.maxConcurrency, 4, 1, 32),
      continueOnError: merged.graph?.continueOnError ?? false,
    },
    team: {
      maxConcurrency: boundedInteger(merged.team?.maxConcurrency, 4, 1, 16),
      continueOnError: merged.team?.continueOnError ?? false,
      maxTasks: boundedInteger(merged.team?.maxTasks, 10, 1, 50),
    },
    pricing: merged.pricing ?? {},
    sandbox: {
      kind: merged.sandbox?.kind ?? "auto",
      image: merged.sandbox?.image ?? "node:22-bookworm",
      network: merged.sandbox?.network ?? "none",
      allowHostFallback: merged.sandbox?.allowHostFallback ?? false,
      requireImageDigest: merged.sandbox?.requireImageDigest ?? enterpriseEnabled,
      ...(merged.sandbox?.vmHost ? { vmHost: merged.sandbox.vmHost } : {}),
      ...(merged.sandbox?.vmWorkspace ? { vmWorkspace: merged.sandbox.vmWorkspace } : {}),
      ...(merged.sandbox?.vmIdentityFile ? { vmIdentityFile: merged.sandbox.vmIdentityFile } : {}),
    },
    tui: {
      enabled: merged.tui?.enabled ?? true,
      title: merged.tui?.title ?? "FocusCode",
      theme: merged.tui?.theme ?? "foxglow",
      mascot: merged.tui?.mascot ?? "foxy",
      keymap: merged.tui?.keymap ?? {},
    },
    media: {
      allowRemoteImages: merged.media?.allowRemoteImages ?? !enterpriseEnabled,
    },
    extensions: {
      host: merged.extensions?.host ?? (enterpriseEnabled ? "process" : "in-process"),
    },
    enterprise: {
      enabled: enterpriseEnabled,
      allowedProviders: merged.enterprise?.allowedProviders ?? [],
      allowedModels: merged.enterprise?.allowedModels ?? [],
      requireIsolatedSandbox: merged.enterprise?.requireIsolatedSandbox ?? true,
      auditDirectory: merged.enterprise?.auditDirectory ?? join(homedir(), ".focuscode", "audit"),
      auditHmacKeyEnv: merged.enterprise?.auditHmacKeyEnv ?? "FOCUSCODE_AUDIT_HMAC_KEY",
      allowProjectExtensions: merged.enterprise?.allowProjectExtensions ?? false,
      allowedExtensions: merged.enterprise?.allowedExtensions ?? [],
    },
    ...(merged.extensionDirectory ? { extensionDirectory: merged.extensionDirectory } : {}),
    requireExtensionSignatures: merged.requireExtensionSignatures ?? true,
    ...(merged.shareEndpoint ? { shareEndpoint: merged.shareEndpoint } : {}),
    sources,
    settingSources,
  };
}

export function listProviderPresets(): ProviderPreset[] {
  return Object.values(PRESETS).map((preset) => ({ ...preset }));
}

async function readConfigIfPresent(path: string): Promise<AgentConfigFile | undefined> {
  if (!(await exists(path))) return undefined;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent config must be an object: ${path}`);
  }
  const config = value as AgentConfigFile;
  if (config.schemaVersion && config.schemaVersion !== "focuscode-agent.v1") {
    throw new Error(`Unsupported agent config schema in ${path}`);
  }
  validateStringArray(config.protectedPaths, "protectedPaths", path);
  validateStringArray(config.instructions, "instructions", path);
  validateStringArray(config.enabledTools, "enabledTools", path);
  validateStringArray(config.disabledTools, "disabledTools", path);
  validateAgentConfig(config, path);
  return config;
}

/**
 * Validate the `settingSources` declaration from the user-layer config.
 * Returns the default three-layer list when the declaration is absent.
 * Throws on malformed entries to fail fast at config load time.
 */
function validateSettingSources(declared: SettingSource[] | undefined): SettingSource[] {
  if (declared === undefined) return [...DEFAULT_SETTING_SOURCES];
  if (!Array.isArray(declared)) {
    throw new Error("settingSources must be an array");
  }
  const valid = new Set<SettingSource>(["user", "project", "local"]);
  for (const entry of declared) {
    if (typeof entry !== "string" || !valid.has(entry as SettingSource)) {
      throw new Error(
        `settingSources must contain only "user", "project", or "local"; got: ${JSON.stringify(entry)}`,
      );
    }
  }
  return [...declared];
}

function mergeConfig(...configs: Array<AgentConfigFile | undefined>): AgentConfigFile {
  const merged: AgentConfigFile = {};
  for (const config of configs) {
    if (!config) continue;
    for (const [key, value] of Object.entries(config)) {
      if (key === "agent" && value && typeof value === "object") {
        merged.agent = { ...merged.agent, ...(value as AgentConfigFile["agent"]) };
        continue;
      }
      if (key === "sandbox" && value && typeof value === "object") {
        merged.sandbox = { ...merged.sandbox, ...(value as AgentConfigFile["sandbox"]) };
        continue;
      }
      if (key === "tui" && value && typeof value === "object") {
        merged.tui = { ...merged.tui, ...(value as AgentConfigFile["tui"]) };
        continue;
      }
      if (key === "media" && value && typeof value === "object") {
        merged.media = { ...merged.media, ...(value as AgentConfigFile["media"]) };
        continue;
      }
      if (key === "extensions" && value && typeof value === "object") {
        merged.extensions = { ...merged.extensions, ...(value as AgentConfigFile["extensions"]) };
        continue;
      }
      if (key === "enterprise" && value && typeof value === "object") {
        merged.enterprise = {
          ...merged.enterprise,
          ...(value as AgentConfigFile["enterprise"]),
        };
        continue;
      }
      if (key === "providers" && value && typeof value === "object") {
        merged.providers = {
          ...merged.providers,
          ...(value as AgentConfigFile["providers"]),
        };
        continue;
      }
      if (key === "models" && value && typeof value === "object") {
        merged.models = {
          ...merged.models,
          ...(value as AgentConfigFile["models"]),
        };
        continue;
      }
      if (
        value !== undefined &&
        ![
          "apiKey",
          "projectTrusted",
          "globalConfigPath",
          "projectConfigPath",
          "localConfigPath",
        ].includes(key)
      ) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

function inferProviderFromEnvironment(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.DASHSCOPE_API_KEY) return "qwen";
  if (process.env.KIMI_API_KEY) return "kimi-coding";
  if (process.env.MOONSHOT_API_KEY) return "kimi";
  if (process.env.ZAI_API_KEY) return "glm";
  if (process.env.ARK_API_KEY) return "ark";
  if (process.env.MINIMAX_API_KEY) return "minimax";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    // Path does not exist or is inaccessible; this is a normal control-flow
    // signal for callers that probe for optional files. Debug-level only.
    return false;
  }
}

function validateStringArray(value: unknown, label: string, path: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
  ) {
    throw new Error(`${label} must be a string array in ${path}`);
  }
}

function validateAgentConfig(config: AgentConfigFile, path: string): void {
  validateEnum(
    config.protocol,
    ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"],
    "protocol",
    path,
  );
  validateEnum(config.authType, ["api-key", "bearer", "none"], "authType", path);
  validateEnum(config.toolMode, ["native", "prompt-json", "auto"], "toolMode", path);
  validateEnum(config.approval, ["ask", "auto-edit", "full-auto", "deny"], "approval", path);
  validateEnum(config.steeringDelivery, ["all", "one-at-a-time"], "steeringDelivery", path);
  validateEnum(
    config.reasoningEffort,
    ["off", "minimal", "low", "medium", "high", "max"],
    "reasoningEffort",
    path,
  );
  validateEnum(
    config.systemFingerprintPolicy,
    ["fail", "warn", "off"],
    "systemFingerprintPolicy",
    path,
  );
  for (const [label, value] of [
    ["provider", config.provider],
    ["model", config.model],
    ["revision", config.revision],
    ["expectedSystemFingerprint", config.expectedSystemFingerprint],
    ["apiKeyEnv", config.apiKeyEnv],
    ["oauthAccount", config.oauthAccount],
    ["extensionDirectory", config.extensionDirectory],
  ] as const) {
    validateOptionalString(value, label, path);
  }
  validateHttpUrl(config.baseUrl, "baseUrl", path);
  validateHttpUrl(config.shareEndpoint, "shareEndpoint", path);
  for (const [label, value] of [
    ["contextWindow", config.contextWindow],
    ["maxOutputTokens", config.maxOutputTokens],
    ["temperature", config.temperature],
    ["maxRounds", config.maxRounds],
    ["steeringMaximum", config.steeringMaximum],
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`${label} must be a finite number in ${path}`);
    }
  }
  if (
    config.requireExtensionSignatures !== undefined &&
    typeof config.requireExtensionSignatures !== "boolean"
  ) {
    throw new Error(`requireExtensionSignatures must be boolean in ${path}`);
  }
  if (config.agent !== undefined) {
    if (!config.agent || typeof config.agent !== "object" || Array.isArray(config.agent)) {
      throw new Error(`agent must be an object in ${path}`);
    }
    validateOptionalBoolean(config.agent.effectSpine, "agent.effectSpine", path);
    validateOptionalBoolean(config.agent.checkpoints, "agent.checkpoints", path);
    validateDiagnosticsConfig(config.agent.diagnostics, "agent.diagnostics", path);
    validateOptionalBoolean(config.agent.enableDelegate, "agent.enableDelegate", path);
    validateHttpUrl(config.agent.searchEndpoint, "agent.searchEndpoint", path);
  }
  if (config.mcp !== undefined) {
    if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
      throw new Error(`mcp must be an object in ${path}`);
    }
    if (config.mcp.servers !== undefined) {
      if (!Array.isArray(config.mcp.servers)) {
        throw new Error(`mcp.servers must be an array in ${path}`);
      }
      for (const [index, server] of config.mcp.servers.entries()) {
        if (!server || typeof server !== "object" || Array.isArray(server)) {
          throw new Error(`mcp.servers[${index}] must be an object in ${path}`);
        }
        if (typeof server.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(server.id)) {
          throw new Error(`mcp.servers[${index}].id must match ^[a-z][a-z0-9-]{0,31}$ in ${path}`);
        }
        validateOptionalString(server.command, `mcp.servers[${index}].command`, path);
        validateStringArray(server.args, `mcp.servers[${index}].args`, path);
        validateStringRecord(server.env, `mcp.servers[${index}].env`, path);
        validateOptionalBoolean(server.disabled, `mcp.servers[${index}].disabled`, path);
      }
    }
    if (config.mcp.pins !== undefined) {
      if (!Array.isArray(config.mcp.pins)) {
        throw new Error(`mcp.pins must be an array in ${path}`);
      }
      for (const [index, pin] of config.mcp.pins.entries()) {
        if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
          throw new Error(`mcp.pins[${index}] must be an object in ${path}`);
        }
        validateString(pin.serverId, `mcp.pins[${index}].serverId`, path);
        validateString(pin.serverVersion, `mcp.pins[${index}].serverVersion`, path);
        validateString(pin.toolName, `mcp.pins[${index}].toolName`, path);
        validateString(pin.schemaDigest, `mcp.pins[${index}].schemaDigest`, path);
        validateString(pin.transportDigest, `mcp.pins[${index}].transportDigest`, path);
      }
    }
  }
  if (config.skills !== undefined) {
    if (!config.skills || typeof config.skills !== "object" || Array.isArray(config.skills)) {
      throw new Error(`skills must be an object in ${path}`);
    }
    const manifest = config.skills.manifest;
    if (manifest !== undefined) {
      if (typeof manifest !== "string") {
        if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
          throw new Error(`skills.manifest must be a string path or object in ${path}`);
        }
        if (manifest.schemaVersion !== "focuscode-skills.v1") {
          throw new Error(`skills.manifest.schemaVersion must be focuscode-skills.v1 in ${path}`);
        }
        if (!Array.isArray(manifest.skills)) {
          throw new Error(`skills.manifest.skills must be an array in ${path}`);
        }
      }
    }
  }
  if (config.loop !== undefined) {
    if (!config.loop || typeof config.loop !== "object" || Array.isArray(config.loop)) {
      throw new Error(`loop must be an object in ${path}`);
    }
    for (const [label, value] of [
      ["maxIterations", config.loop.maxIterations],
      ["tokenBudget", config.loop.tokenBudget],
    ] as const) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`loop.${label} must be a finite number in ${path}`);
      }
    }
  }
  if (config.graph !== undefined) {
    if (!config.graph || typeof config.graph !== "object" || Array.isArray(config.graph)) {
      throw new Error(`graph must be an object in ${path}`);
    }
    if (
      config.graph.maxConcurrency !== undefined &&
      (typeof config.graph.maxConcurrency !== "number" ||
        !Number.isFinite(config.graph.maxConcurrency))
    ) {
      throw new Error(`graph.maxConcurrency must be a finite number in ${path}`);
    }
    if (
      config.graph.continueOnError !== undefined &&
      typeof config.graph.continueOnError !== "boolean"
    ) {
      throw new Error(`graph.continueOnError must be boolean in ${path}`);
    }
  }
  if (config.team !== undefined) {
    if (!config.team || typeof config.team !== "object" || Array.isArray(config.team)) {
      throw new Error(`team must be an object in ${path}`);
    }
    for (const [label, value] of [
      ["maxConcurrency", config.team.maxConcurrency],
      ["maxTasks", config.team.maxTasks],
    ] as const) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`team.${label} must be a finite number in ${path}`);
      }
    }
    if (
      config.team.continueOnError !== undefined &&
      typeof config.team.continueOnError !== "boolean"
    ) {
      throw new Error(`team.continueOnError must be boolean in ${path}`);
    }
  }
  if (config.pricing !== undefined) {
    if (!config.pricing || typeof config.pricing !== "object" || Array.isArray(config.pricing)) {
      throw new Error(`pricing must be an object in ${path}`);
    }
    for (const [key, entry] of Object.entries(config.pricing)) {
      validateOptionalString(key, "pricing key", path);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`pricing.${key} must be an object in ${path}`);
      }
      for (const [label, value] of [
        ["input", entry.input],
        ["output", entry.output],
        ["cachedInput", entry.cachedInput],
      ] as const) {
        if (value === undefined) {
          if (label !== "cachedInput") {
            throw new Error(`pricing.${key}.${label} is required in ${path}`);
          }
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error(`pricing.${key}.${label} must be a non-negative number in ${path}`);
        }
      }
    }
  }
  if (config.sandbox !== undefined) {
    if (!config.sandbox || typeof config.sandbox !== "object" || Array.isArray(config.sandbox)) {
      throw new Error(`sandbox must be an object in ${path}`);
    }
    validateEnum(
      config.sandbox.kind,
      ["host", "docker", "gvisor", "vm", "auto"],
      "sandbox.kind",
      path,
    );
    validateEnum(config.sandbox.network, ["none", "bridge"], "sandbox.network", path);
    validateOptionalString(config.sandbox.image, "sandbox.image", path);
    validateOptionalString(config.sandbox.vmHost, "sandbox.vmHost", path);
    validateOptionalString(config.sandbox.vmWorkspace, "sandbox.vmWorkspace", path);
    validateOptionalString(config.sandbox.vmIdentityFile, "sandbox.vmIdentityFile", path);
    if (
      config.sandbox.allowHostFallback !== undefined &&
      typeof config.sandbox.allowHostFallback !== "boolean"
    ) {
      throw new Error(`sandbox.allowHostFallback must be boolean in ${path}`);
    }
    validateOptionalBoolean(config.sandbox.requireImageDigest, "sandbox.requireImageDigest", path);
    if (config.sandbox.kind === "vm") {
      if (!config.sandbox.vmHost || !config.sandbox.vmWorkspace) {
        throw new Error(`VM sandbox requires vmHost and vmWorkspace in ${path}`);
      }
      if (!config.sandbox.vmWorkspace.startsWith("/")) {
        throw new Error(`sandbox.vmWorkspace must be absolute in ${path}`);
      }
    }
  }
  if (config.tui !== undefined) {
    if (!config.tui || typeof config.tui !== "object" || Array.isArray(config.tui)) {
      throw new Error(`tui must be an object in ${path}`);
    }
    if (config.tui.enabled !== undefined && typeof config.tui.enabled !== "boolean") {
      throw new Error(`tui.enabled must be boolean in ${path}`);
    }
    validateOptionalString(config.tui.theme, "tui.theme", path);
    validateOptionalString(config.tui.mascot, "tui.mascot", path);
    validateOptionalString(config.tui.title, "tui.title", path);
    if (config.tui.keymap !== undefined) {
      if (
        !config.tui.keymap ||
        typeof config.tui.keymap !== "object" ||
        Array.isArray(config.tui.keymap)
      ) {
        throw new Error(`tui.keymap must be an object in ${path}`);
      }
      const actions = new Set([
        "submit",
        "newline",
        "abort",
        "exit",
        "clear",
        "backspace",
        "delete_word",
        "cursor_left",
        "cursor_right",
        "history_previous",
        "history_next",
        "scroll_up",
        "scroll_down",
        "cycle_theme",
        "cycle_mascot",
      ]);
      for (const [key, action] of Object.entries(config.tui.keymap)) {
        if (!/^(ctrl\+[a-z]|enter|backspace|left|right|up|down|pageup|pagedown)$/.test(key)) {
          throw new Error(`Invalid TUI key ${key} in ${path}`);
        }
        if (typeof action !== "string" || !actions.has(action)) {
          throw new Error(`Invalid TUI action for ${key} in ${path}`);
        }
      }
    }
  }
  if (config.media !== undefined) {
    if (!config.media || typeof config.media !== "object" || Array.isArray(config.media)) {
      throw new Error(`media must be an object in ${path}`);
    }
    validateOptionalBoolean(config.media.allowRemoteImages, "media.allowRemoteImages", path);
  }
  if (config.extensions !== undefined) {
    if (
      !config.extensions ||
      typeof config.extensions !== "object" ||
      Array.isArray(config.extensions)
    ) {
      throw new Error(`extensions must be an object in ${path}`);
    }
    validateEnum(config.extensions.host, ["in-process", "process"], "extensions.host", path);
  }
  if (config.enterprise !== undefined) {
    if (
      !config.enterprise ||
      typeof config.enterprise !== "object" ||
      Array.isArray(config.enterprise)
    ) {
      throw new Error(`enterprise must be an object in ${path}`);
    }
    validateOptionalBoolean(config.enterprise.enabled, "enterprise.enabled", path);
    validateOptionalBoolean(
      config.enterprise.requireIsolatedSandbox,
      "enterprise.requireIsolatedSandbox",
      path,
    );
    validateOptionalBoolean(
      config.enterprise.allowProjectExtensions,
      "enterprise.allowProjectExtensions",
      path,
    );
    validateStringArray(config.enterprise.allowedProviders, "enterprise.allowedProviders", path);
    validateStringArray(config.enterprise.allowedModels, "enterprise.allowedModels", path);
    validateStringArray(config.enterprise.allowedExtensions, "enterprise.allowedExtensions", path);
    validateOptionalString(config.enterprise.auditDirectory, "enterprise.auditDirectory", path);
    validateOptionalString(config.enterprise.auditHmacKeyEnv, "enterprise.auditHmacKeyEnv", path);
  }
  if (config.providers !== undefined) {
    if (
      !config.providers ||
      typeof config.providers !== "object" ||
      Array.isArray(config.providers)
    ) {
      throw new Error(`providers must be an object in ${path}`);
    }
    for (const [id, preset] of Object.entries(config.providers)) {
      if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
        throw new Error(`Provider ${id} must be an object in ${path}`);
      }
      validateEnum(
        preset.protocol,
        ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"],
        `providers.${id}.protocol`,
        path,
      );
      validateEnum(
        preset.defaultAuthType,
        ["api-key", "bearer", "none"],
        `providers.${id}.defaultAuthType`,
        path,
      );
      validateHttpUrl(preset.baseUrl, `providers.${id}.baseUrl`, path);
      validateOptionalString(preset.apiKeyEnv, `providers.${id}.apiKeyEnv`, path);
      validateOptionalString(preset.defaultModel, `providers.${id}.defaultModel`, path);
      validateOptionalString(preset.defaultRevision, `providers.${id}.defaultRevision`, path);
      validateEnum(
        preset.defaultReasoningEffort,
        ["off", "minimal", "low", "medium", "high", "max"],
        `providers.${id}.defaultReasoningEffort`,
        path,
      );
      validateCapabilities(preset.capabilities, `providers.${id}.capabilities`, path);
      validateCompatibility(preset.compatibility, `providers.${id}.compatibility`, path);
      validateReliability(preset.reliability, `providers.${id}.reliability`, path);
      validateStringRecord(preset.extraHeaders, `providers.${id}.extraHeaders`, path);
    }
  }
  if (config.models !== undefined) {
    if (!config.models || typeof config.models !== "object" || Array.isArray(config.models)) {
      throw new Error(`models must be an object in ${path}`);
    }
    for (const [id, profile] of Object.entries(config.models)) {
      validateOptionalString(id, "model profile id", path);
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new Error(`Model profile ${id} must be an object in ${path}`);
      }
      validateEnum(
        profile.protocol,
        ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"],
        `models.${id}.protocol`,
        path,
      );
      validateEnum(profile.authType, ["api-key", "bearer", "none"], `models.${id}.authType`, path);
      validateEnum(
        profile.reasoningEffort,
        ["off", "minimal", "low", "medium", "high", "max"],
        `models.${id}.reasoningEffort`,
        path,
      );
      validateEnum(
        profile.toolMode,
        ["native", "prompt-json", "auto"],
        `models.${id}.toolMode`,
        path,
      );
      validateHttpUrl(profile.baseUrl, `models.${id}.baseUrl`, path);
      validateOptionalString(profile.apiKeyEnv, `models.${id}.apiKeyEnv`, path);
      validateOptionalString(profile.revision, `models.${id}.revision`, path);
      validateOptionalString(
        profile.expectedSystemFingerprint,
        `models.${id}.expectedSystemFingerprint`,
        path,
      );
      validateEnum(
        profile.systemFingerprintPolicy,
        ["fail", "warn", "off"],
        `models.${id}.systemFingerprintPolicy`,
        path,
      );
      for (const [label, value] of [
        ["contextWindow", profile.contextWindow],
        ["maxOutputTokens", profile.maxOutputTokens],
        ["temperature", profile.temperature],
      ] as const) {
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error(`models.${id}.${label} must be a finite number in ${path}`);
        }
      }
      validateCapabilities(profile.capabilities, `models.${id}.capabilities`, path);
      validateCompatibility(profile.compatibility, `models.${id}.compatibility`, path);
      validateReliability(profile.reliability, `models.${id}.reliability`, path);
      validateStringRecord(profile.extraHeaders, `models.${id}.extraHeaders`, path);
    }
  }
  if (config.fallbackModels !== undefined) {
    if (!Array.isArray(config.fallbackModels)) {
      throw new Error(`fallbackModels must be an array in ${path}`);
    }
    for (const [index, entry] of config.fallbackModels.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`fallbackModels[${index}] must be an object in ${path}`);
      }
      validateString(entry.provider, `fallbackModels[${index}].provider`, path);
      validateString(entry.model, `fallbackModels[${index}].model`, path);
      validateEnum(
        entry.protocol,
        ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"],
        `fallbackModels[${index}].protocol`,
        path,
      );
      validateEnum(
        entry.authType,
        ["api-key", "bearer", "none"],
        `fallbackModels[${index}].authType`,
        path,
      );
      validateEnum(
        entry.reasoningEffort,
        ["off", "minimal", "low", "medium", "high", "max"],
        `fallbackModels[${index}].reasoningEffort`,
        path,
      );
      validateEnum(
        entry.toolMode,
        ["native", "prompt-json", "auto"],
        `fallbackModels[${index}].toolMode`,
        path,
      );
      validateHttpUrl(entry.baseUrl, `fallbackModels[${index}].baseUrl`, path);
      validateOptionalString(entry.apiKeyEnv, `fallbackModels[${index}].apiKeyEnv`, path);
      validateOptionalString(entry.revision, `fallbackModels[${index}].revision`, path);
      validateOptionalString(
        entry.expectedSystemFingerprint,
        `fallbackModels[${index}].expectedSystemFingerprint`,
        path,
      );
      validateEnum(
        entry.systemFingerprintPolicy,
        ["fail", "warn", "off"],
        `fallbackModels[${index}].systemFingerprintPolicy`,
        path,
      );
      for (const [label, value] of [
        ["contextWindow", entry.contextWindow],
        ["maxOutputTokens", entry.maxOutputTokens],
        ["temperature", entry.temperature],
      ] as const) {
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error(`fallbackModels[${index}].${label} must be a finite number in ${path}`);
        }
      }
      validateCapabilities(entry.capabilities, `fallbackModels[${index}].capabilities`, path);
      validateCompatibility(entry.compatibility, `fallbackModels[${index}].compatibility`, path);
      validateReliability(entry.reliability, `fallbackModels[${index}].reliability`, path);
      validateStringRecord(entry.extraHeaders, `fallbackModels[${index}].extraHeaders`, path);
    }
  }
}

function validateEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
  path: string,
): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    throw new Error(`${label} must be one of ${allowed.join(", ")} in ${path}`);
  }
}

function validateString(value: unknown, label: string, path: string): void {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string in ${path}`);
  }
}

function validateOptionalString(value: unknown, label: string, path: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value))
  ) {
    throw new Error(`${label} must be a non-empty string in ${path}`);
  }
}

function validateOptionalBoolean(value: unknown, label: string, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${label} must be boolean in ${path}`);
  }
}

const VALID_DIAGNOSTIC_PROVIDER_IDS = ["typescript", "python", "go", "rust"];

function validateDiagnosticsConfig(value: unknown, label: string, path: string): void {
  if (value === undefined) return;
  if (typeof value === "boolean") return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { providers?: unknown };
    if (v.providers !== undefined) {
      if (!Array.isArray(v.providers) || !v.providers.every((p) => typeof p === "string")) {
        throw new Error(`${label}.providers must be a string array in ${path}`);
      }
      for (const p of v.providers as string[]) {
        if (!VALID_DIAGNOSTIC_PROVIDER_IDS.includes(p)) {
          throw new Error(
            `${label}.providers contains unknown provider '${p}' in ${path}; valid: ${VALID_DIAGNOSTIC_PROVIDER_IDS.join(", ")}`,
          );
        }
      }
    }
    return;
  }
  throw new Error(`${label} must be boolean or object in ${path}`);
}

function resolveDiagnosticsConfig(value: boolean | { providers?: string[] } | undefined): {
  enabled: boolean;
  providers: string[] | undefined;
} {
  if (value === undefined) return { enabled: true, providers: undefined };
  if (typeof value === "boolean") return { enabled: value, providers: undefined };
  return { enabled: true, providers: value.providers };
}

function validateCapabilities(value: unknown, label: string, path: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object in ${path}`);
  }
  const capabilities = value as Partial<ModelCapabilities>;
  if (
    !Array.isArray(capabilities.input) ||
    capabilities.input.length === 0 ||
    !capabilities.input.every((item) => item === "text" || item === "image")
  ) {
    throw new Error(`${label}.input must contain text and/or image in ${path}`);
  }
  validateOptionalBoolean(capabilities.reasoning, `${label}.reasoning`, path);
  validateOptionalBoolean(capabilities.toolCalling, `${label}.toolCalling`, path);
}

function validateCompatibility(value: unknown, label: string, path: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object in ${path}`);
  }
  const compatibility = value as ProviderCompatibility;
  for (const [key, item] of Object.entries(compatibility)) {
    if (
      [
        "maxTokensField",
        "thinkingFormat",
        "reasoningEffortMap",
        "anthropicThinking",
        "anthropicThinkingBudgetTokens",
      ].includes(key)
    )
      continue;
    validateOptionalBoolean(item, `${label}.${key}`, path);
  }
  validateEnum(
    compatibility.maxTokensField,
    ["max_tokens", "max_completion_tokens"],
    `${label}.maxTokensField`,
    path,
  );
  if (compatibility.reasoningEffortMap !== undefined) {
    if (
      !compatibility.reasoningEffortMap ||
      typeof compatibility.reasoningEffortMap !== "object" ||
      Array.isArray(compatibility.reasoningEffortMap)
    ) {
      throw new Error(`${label}.reasoningEffortMap must be an object in ${path}`);
    }
    const efforts = ["off", "minimal", "low", "medium", "high", "max"] as const;
    for (const [source, target] of Object.entries(compatibility.reasoningEffortMap)) {
      if (!efforts.includes(source as (typeof efforts)[number])) {
        throw new Error(`${label}.reasoningEffortMap has invalid source ${source} in ${path}`);
      }
      validateEnum(target, efforts, `${label}.reasoningEffortMap.${source}`, path);
    }
  }
  validateEnum(
    compatibility.thinkingFormat,
    ["openai", "deepseek", "qwen", "zai"],
    `${label}.thinkingFormat`,
    path,
  );
  validateEnum(
    compatibility.anthropicThinking,
    ["omit", "adaptive", "enabled", "disabled"],
    `${label}.anthropicThinking`,
    path,
  );
  if (
    compatibility.anthropicThinkingBudgetTokens !== undefined &&
    (!Number.isInteger(compatibility.anthropicThinkingBudgetTokens) ||
      compatibility.anthropicThinkingBudgetTokens < 1 ||
      compatibility.anthropicThinkingBudgetTokens > 512_000)
  ) {
    throw new Error(`${label}.anthropicThinkingBudgetTokens must be 1..512000 in ${path}`);
  }
}

function validateReliability(value: unknown, label: string, path: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object in ${path}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0) {
      throw new Error(`${label}.${key} must be a non-negative integer in ${path}`);
    }
  }
}

function validateStringRecord(value: unknown, label: string, path: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object in ${path}`);
  }
  for (const [key, item] of Object.entries(value)) {
    validateOptionalString(key, `${label} key`, path);
    validateOptionalString(item, `${label}.${key}`, path);
  }
}

function validateHttpUrl(value: unknown, label: string, path: string): void {
  if (value === undefined) return;
  validateOptionalString(value, label, path);
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} must be an absolute URL in ${path}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS in ${path}`);
  }
}

function validApproval(value: unknown): value is ApprovalMode {
  return ["ask", "auto-edit", "full-auto", "deny"].includes(String(value));
}

function validToolMode(value: unknown): value is ModelProfile["toolMode"] {
  return ["native", "prompt-json", "auto"].includes(String(value));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function cloneCapabilities(value: ModelCapabilities): ModelCapabilities {
  return { ...value, input: [...value.input] };
}

function enforceEnterprisePolicy(
  config: AgentConfigFile,
  provider: string,
  model: string,
  revision: string | undefined,
): void {
  if (config.enterprise?.enabled !== true) return;
  const allowedProviders = config.enterprise.allowedProviders ?? [];
  if (allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
    throw new Error(`Enterprise policy denies provider ${provider}`);
  }
  const allowedModels = config.enterprise.allowedModels ?? [];
  const qualifiedModel = `${provider}/${model}`;
  if (
    allowedModels.length > 0 &&
    !matchesAllowedModel(allowedModels, model, qualifiedModel, revision)
  ) {
    throw new Error(`Enterprise policy denies model ${qualifiedModel}`);
  }
  if (
    (config.enterprise.requireIsolatedSandbox ?? true) &&
    (config.sandbox?.kind === "host" || config.sandbox?.allowHostFallback === true)
  ) {
    throw new Error("Enterprise policy requires an isolated sandbox and forbids host fallback");
  }
  if (
    (config.sandbox?.requireImageDigest ?? true) &&
    config.sandbox?.kind !== "vm" &&
    !/@sha256:[a-f0-9]{64}$/i.test(config.sandbox?.image ?? "node:22-bookworm")
  ) {
    throw new Error("Enterprise policy requires a sandbox image pinned by sha256 digest");
  }
  if (config.requireExtensionSignatures === false) {
    throw new Error("Enterprise policy requires signed extension packages");
  }
  if (config.extensions?.host === "in-process") {
    throw new Error("Enterprise policy requires the process extension host");
  }
  if (config.media?.allowRemoteImages === true) {
    throw new Error(
      "Enterprise policy blocks remote image URLs; use local files or disable enterprise mode",
    );
  }
}

/**
 * Matches one allowlist entry against the resolved model. Entries may pin a
 * revision as `[provider/]model@revision`; a pinned entry then requires an
 * exact match on both the model name and the configured revision, and never
 * matches a model whose revision is unknown (fail closed).
 */
function matchesAllowedModel(
  allowedModels: string[],
  model: string,
  qualifiedModel: string,
  revision: string | undefined,
): boolean {
  return allowedModels.some((entry) => {
    const separator = entry.lastIndexOf("@");
    if (separator <= 0) return entry === model || entry === qualifiedModel;
    const namePart = entry.slice(0, separator);
    if (namePart !== model && namePart !== qualifiedModel) return false;
    return revision !== undefined && entry.slice(separator + 1) === revision;
  });
}

/**
 * Build a fully-resolved `ModelProfile` from a provider preset, model-level
 * overrides, and already-resolved top-level values (API key, auth type,
 * revision, etc.). Shared by the primary model and each fallback entry so
 * every link in the chain goes through the same capability/compatibility/
 * reliability merge and bounded-integer clamping path.
 */
function resolveModelProfile(input: {
  providerId: string;
  modelId: string;
  modelPreset: ModelProfilePreset;
  preset: ProviderPreset;
  apiKey: string | undefined;
  apiKeyEnv: string | undefined;
  authType: "api-key" | "bearer" | "none";
  revision: string | undefined;
  expectedSystemFingerprint: string | undefined;
  systemFingerprintPolicy: "fail" | "warn" | "off" | undefined;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  reasoningEffort: ReasoningEffort;
  toolMode: "native" | "prompt-json" | "auto" | undefined;
  oauthAccount?: string;
}): ModelProfile {
  const capabilities = cloneCapabilities(
    input.modelPreset.capabilities ?? input.preset.capabilities ?? DEFAULT_CAPABILITIES,
  );
  const compatibility: ProviderCompatibility = {
    ...DEFAULT_COMPATIBILITY,
    ...input.preset.compatibility,
    ...input.modelPreset.compatibility,
  };
  const reliability: ModelReliabilityPolicy = {
    timeoutMs: boundedInteger(
      input.modelPreset.reliability?.timeoutMs ?? input.preset.reliability?.timeoutMs,
      DEFAULT_RELIABILITY.timeoutMs,
      1_000,
      1_800_000,
    ),
    maxRetries: boundedInteger(
      input.modelPreset.reliability?.maxRetries ?? input.preset.reliability?.maxRetries,
      DEFAULT_RELIABILITY.maxRetries,
      0,
      10,
    ),
    retryBaseDelayMs: boundedInteger(
      input.modelPreset.reliability?.retryBaseDelayMs ?? input.preset.reliability?.retryBaseDelayMs,
      DEFAULT_RELIABILITY.retryBaseDelayMs,
      10,
      60_000,
    ),
    retryMaximumDelayMs: boundedInteger(
      input.modelPreset.reliability?.retryMaximumDelayMs ??
        input.preset.reliability?.retryMaximumDelayMs,
      DEFAULT_RELIABILITY.retryMaximumDelayMs,
      10,
      300_000,
    ),
    circuitThreshold: boundedInteger(
      input.modelPreset.reliability?.circuitThreshold ?? input.preset.reliability?.circuitThreshold,
      DEFAULT_RELIABILITY.circuitThreshold,
      1,
      100,
    ),
    circuitCooldownMs: boundedInteger(
      input.modelPreset.reliability?.circuitCooldownMs ??
        input.preset.reliability?.circuitCooldownMs,
      DEFAULT_RELIABILITY.circuitCooldownMs,
      100,
      600_000,
    ),
    maxConcurrency: boundedInteger(
      input.modelPreset.reliability?.maxConcurrency ?? input.preset.reliability?.maxConcurrency,
      DEFAULT_RELIABILITY.maxConcurrency,
      1,
      256,
    ),
  };
  const extraHeaders: Record<string, string> = {
    ...input.preset.extraHeaders,
    ...input.modelPreset.extraHeaders,
  };
  const profile: ModelProfile = {
    provider: input.providerId,
    model: input.modelId,
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.expectedSystemFingerprint
      ? { expectedSystemFingerprint: input.expectedSystemFingerprint }
      : {}),
    ...(input.systemFingerprintPolicy
      ? { systemFingerprintPolicy: input.systemFingerprintPolicy }
      : {}),
    protocol: input.modelPreset.protocol ?? input.preset.protocol,
    baseUrl: input.modelPreset.baseUrl ?? input.preset.baseUrl,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
    authType: input.authType,
    ...(input.oauthAccount ? { oauthAccount: input.oauthAccount } : {}),
    contextWindow: boundedInteger(
      input.contextWindow,
      input.preset.defaultContextWindow,
      4_096,
      4_000_000,
    ),
    maxOutputTokens: boundedInteger(
      input.maxOutputTokens,
      input.preset.defaultMaxOutputTokens,
      256,
      512_000,
    ),
    temperature: boundedNumber(input.temperature, 0, 0, 2),
    toolMode: validToolMode(input.toolMode) ? input.toolMode : "auto",
    reasoningEffort: input.reasoningEffort,
    capabilities,
    compatibility,
    reliability,
    ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
  };
  return profile;
}

/**
 * Resolve each `fallbackModels` entry into a fully-resolved `ModelProfile`
 * using the same provider-preset lookup and `resolveModelProfile` path as the
 * primary model. Enterprise policy is enforced on every entry so a fallback
 * cannot bypass an allowlist. Unlike the primary, a missing API key does not
 * throw — the key is left `undefined` and the fallback client will surface a
 * clear error at runtime if it is ever selected.
 */
function resolveFallbackModels(
  merged: AgentConfigFile,
  customPresets: Record<string, Partial<ProviderPreset>>,
  enterpriseEnabled: boolean,
): ModelProfile[] {
  const entries = merged.fallbackModels ?? [];
  if (entries.length === 0) return [];
  return entries.map((entry) => {
    const basePreset = PRESETS[entry.provider];
    const custom = customPresets[entry.provider];
    if (!basePreset && !custom && !entry.baseUrl) {
      throw new Error(
        `Unknown fallback provider ${entry.provider}; configure baseUrl and protocol`,
      );
    }
    const fallbackApiKeyEnv = entry.apiKeyEnv ?? custom?.apiKeyEnv ?? basePreset?.apiKeyEnv;
    const preset: ProviderPreset = {
      id: entry.provider,
      protocol: custom?.protocol ?? basePreset?.protocol ?? "openai-chat",
      baseUrl: custom?.baseUrl ?? basePreset?.baseUrl ?? "",
      ...(fallbackApiKeyEnv ? { apiKeyEnv: fallbackApiKeyEnv } : {}),
      defaultContextWindow:
        custom?.defaultContextWindow ?? basePreset?.defaultContextWindow ?? 128_000,
      defaultMaxOutputTokens:
        custom?.defaultMaxOutputTokens ?? basePreset?.defaultMaxOutputTokens ?? 16_384,
      ...((custom?.defaultModel ?? basePreset?.defaultModel)
        ? { defaultModel: (custom?.defaultModel ?? basePreset?.defaultModel)! }
        : {}),
      ...((custom?.defaultRevision ?? basePreset?.defaultRevision)
        ? { defaultRevision: (custom?.defaultRevision ?? basePreset?.defaultRevision)! }
        : {}),
      ...((custom?.defaultReasoningEffort ?? basePreset?.defaultReasoningEffort)
        ? {
            defaultReasoningEffort: (custom?.defaultReasoningEffort ??
              basePreset?.defaultReasoningEffort)!,
          }
        : {}),
      capabilities: custom?.capabilities ?? basePreset?.capabilities ?? DEFAULT_CAPABILITIES,
      compatibility: {
        ...DEFAULT_COMPATIBILITY,
        ...basePreset?.compatibility,
        ...custom?.compatibility,
      },
      reliability: {
        ...DEFAULT_RELIABILITY,
        ...basePreset?.reliability,
        ...custom?.reliability,
      },
      extraHeaders: { ...basePreset?.extraHeaders, ...custom?.extraHeaders },
      ...((custom?.defaultAuthType ?? basePreset?.defaultAuthType)
        ? {
            defaultAuthType: (custom?.defaultAuthType ?? basePreset?.defaultAuthType)!,
          }
        : {}),
    };
    const modelApiKeyEnv = entry.apiKeyEnv ?? preset.apiKeyEnv;
    const apiKey = modelApiKeyEnv ? process.env[modelApiKeyEnv] : undefined;
    const authType = entry.authType ?? preset.defaultAuthType ?? "api-key";
    const revision = entry.revision ?? preset.defaultRevision;
    const expectedSystemFingerprint = entry.expectedSystemFingerprint;
    const systemFingerprintPolicy =
      entry.systemFingerprintPolicy ??
      (expectedSystemFingerprint ? (enterpriseEnabled ? "warn" : "fail") : undefined);
    const profile = resolveModelProfile({
      providerId: entry.provider,
      modelId: entry.model,
      modelPreset: entry,
      preset,
      apiKey,
      apiKeyEnv: modelApiKeyEnv,
      authType,
      revision,
      expectedSystemFingerprint,
      systemFingerprintPolicy,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      temperature: entry.temperature,
      reasoningEffort:
        entry.reasoningEffort ??
        preset.defaultReasoningEffort ??
        ((entry.capabilities ?? preset.capabilities)?.reasoning ? "medium" : "off"),
      toolMode: entry.toolMode,
    });
    enforceEnterpriseModelAllowlist(merged, entry.provider, entry.model, profile.revision);
    return profile;
  });
}

/**
 * Enforce only the provider/model allowlist portion of enterprise policy on a
 * fallback chain entry. Global concerns (sandbox isolation, image digest,
 * extension signatures, remote images) are validated once for the primary
 * model via `enforceEnterprisePolicy`; re-checking them per fallback would
 * surface misleading errors unrelated to the fallback's own declaration.
 */
function enforceEnterpriseModelAllowlist(
  config: AgentConfigFile,
  provider: string,
  model: string,
  revision: string | undefined,
): void {
  if (config.enterprise?.enabled !== true) return;
  const allowedProviders = config.enterprise.allowedProviders ?? [];
  if (allowedProviders.length > 0 && !allowedProviders.includes(provider)) {
    throw new Error(`Enterprise policy denies provider ${provider}`);
  }
  const allowedModels = config.enterprise.allowedModels ?? [];
  const qualifiedModel = `${provider}/${model}`;
  if (
    allowedModels.length > 0 &&
    !matchesAllowedModel(allowedModels, model, qualifiedModel, revision)
  ) {
    throw new Error(`Enterprise policy denies model ${qualifiedModel}`);
  }
}

/**
 * Read-modify-write helper for the global user-layer config
 * (`~/.focuscode/config.json`). Reads the current config (or `{}` if absent),
 * applies the updater, and writes it back. This is the single entry point
 * for CLI/SDK integrators that need to persist preference fields (e.g.
 * `tui.vimEnabled`) — it avoids the last-write-wins race that arises when
 * callers re-implement their own read/write path against the same file.
 *
 * The updater receives the parsed config object and may mutate it in place
 * or return a replacement; if it throws, the write is skipped and the error
 * propagates to the caller.
 */
export async function editGlobalConfig(
  updater: (config: Record<string, unknown>) => void | Promise<void>,
  overrides?: { globalConfigPath?: string },
): Promise<void> {
  const path = resolve(overrides?.globalConfigPath ?? join(homedir(), ".focuscode", "config.json"));
  let config: Record<string, unknown>;
  try {
    const text = await readFile(path, "utf8");
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      config = value as Record<string, unknown>;
    } else {
      config = {};
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      config = {};
    } else {
      throw error;
    }
  }
  await updater(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Read the global user-layer config as a plain object. Returns `{}` when the
 * file does not exist. Use {@link editGlobalConfig} for read-modify-write;
 * this helper is for read-only access (e.g. seeding TUI options at startup).
 */
export async function readGlobalConfig(overrides?: {
  globalConfigPath?: string;
}): Promise<Record<string, unknown>> {
  const path = resolve(overrides?.globalConfigPath ?? join(homedir(), ".focuscode", "config.json"));
  try {
    const text = await readFile(path, "utf8");
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
