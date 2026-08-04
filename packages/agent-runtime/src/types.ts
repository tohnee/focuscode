import type { ApprovalMode, CommandPrefixRule } from "@focuscode/action-domain";

export type { ApprovalMode };

export type AgentRole = "user" | "assistant" | "tool";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

export interface ImageAttachment {
  type: "image";
  id: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes: number;
  source: { type: "base64"; data: string } | { type: "url"; url: string };
  detail?: "auto" | "low" | "high";
  sha256?: string;
}

export type AgentAttachment = ImageAttachment;

export interface AgentMessage {
  role: AgentRole;
  content: string;
  attachments?: AgentAttachment[];
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Opaque protocol state required by some reasoning providers for tool continuation. */
  providerState?: {
    reasoningContent?: string;
    thinkingBlocks?: AnthropicThinkingBlock[];
  };
}

export type AnthropicThinkingBlock =
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type ModelStopReason = "stop" | "tool_use" | "length" | "aborted" | "error";

export interface ModelResponse {
  content: string;
  reasoning?: string;
  /** Provider-owned continuation state that must be replayed without rewriting. */
  providerState?: AgentMessage["providerState"];
  /** Last `system_fingerprint` observed on an OpenAI-compatible response, when present. */
  systemFingerprint?: string;
  toolCalls: AgentToolCall[];
  usage: TokenUsage;
  stopReason: ModelStopReason;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: "read" | "write" | "shell" | "git" | "network";
}

export interface ModelRequest {
  model: string;
  systemPrompt: string;
  /**
   * Optional split of system prompt into cacheable segments. When set, the
   * Provider client may insert cache breakpoints at the boundary between
   * stable and dynamic so prefix-cache hits are maximized across rounds.
   * When absent, `systemPrompt` is used as the single monolithic prompt
   * (backward compatible).
   */
  systemPromptParts?: {
    /** Stable prefix that rarely changes between rounds (cached by Provider). */
    stable: string;
    /** Dynamic suffix that changes per-round (not cached). */
    dynamic: string;
  };
  messages: AgentMessage[];
  tools: ToolDefinition[];
  temperature: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  /** 稳定缓存键（如 session/task ID），由 provider 的 cacheControl.promptCacheKeyField 声明后写入请求体。 */
  cacheKey?: string;
  signal?: AbortSignal;
}

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "max";

export interface ProviderCompatibility {
  supportsParallelToolCalls?: boolean;
  supportsStreamUsage?: boolean;
  supportsToolChoice?: boolean;
  supportsTemperature?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  thinkingFormat?: "openai" | "deepseek" | "qwen" | "zai";
  requiresReasoningContentOnAssistantMessages?: boolean;
  requiresToolResultName?: boolean;
  requiresAssistantContentForToolCalls?: boolean;
  zaiToolStream?: boolean;
  reasoningEffortMap?: Partial<Record<ReasoningEffort, ReasoningEffort>>;
  anthropicThinking?: "omit" | "adaptive" | "enabled" | "disabled";
  anthropicThinkingBudgetTokens?: number;
  /**
   * 声明式缓存控制策略。决定客户端如何在请求中插入缓存断点以最大化
   * Provider 侧的 prefix cache 命中率。未设置时回退到 "none"（向后兼容）。
   */
  cacheControl?: {
    /**
     * - "anthropic-ephemeral": 在 system block 上插入 cache_control: { type: "ephemeral" }，
     *   适用于 Anthropic Messages 协议及兼容该协议的 Provider（如 MiniMax）。
     * - "openai-prefix": 依赖 Provider 侧 prefix cache，客户端将 systemPromptParts.stable
     *   独立为首条 system message，避免 dynamic 段污染前缀，适用于 OpenAI 兼容协议。
     * - "none": 不插入任何缓存标记。
     */
    mode: "anthropic-ephemeral" | "openai-prefix" | "none";
    /** OpenAI prefix cache 最小前缀 token 估算；stable 段低于该阈值时退化为单块 system prompt。 */
    minPrefixTokens?: number;
    /**
     * Provider 要求的稳定缓存键字段名（如 Kimi 的 "prompt_cache_key"）。
     * 设置了该字段且 openai-prefix 模式下，把 request.cacheKey 写入 body 对应字段。
     */
    promptCacheKeyField?: string;
  };
}

export interface ModelCapabilities {
  input: Array<"text" | "image">;
  reasoning: boolean;
  toolCalling: boolean;
}

export interface ModelReliabilityPolicy {
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaximumDelayMs: number;
  /** Consecutive failures before the circuit opens for a provider/model key. */
  circuitThreshold?: number;
  /** How long an open circuit rejects calls before allowing a half-open probe. */
  circuitCooldownMs?: number;
  /** Per-provider in-flight request ceiling; excess calls queue instead of failing. */
  maxConcurrency?: number;
}

export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "model_retry"; attempt: number; delayMs: number; status?: number; reason: string }
  | { type: "usage"; usage: TokenUsage };

export interface ModelClient {
  readonly protocol: string;
  complete(
    request: ModelRequest,
    onEvent?: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse>;
}

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(
    argumentsValue: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export interface PermissionRequest {
  tool: ToolDefinition;
  arguments: Record<string, unknown>;
  reason: string;
  risk: "low" | "medium" | "high" | "critical";
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  remember?: boolean;
}

export type ApprovalHandler = (request: PermissionRequest) => Promise<boolean>;

export type AgentEvent =
  | { type: "agent_start"; sessionId: string; turn: number }
  | { type: "model_start"; model: string; round: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; call: AgentToolCall }
  | {
      type: "tool_end";
      call: AgentToolCall;
      result: ToolExecutionResult;
      durationMs: number;
    }
  | { type: "approval_required"; request: PermissionRequest }
  | {
      type: "steering_queued";
      id: string;
      text: string;
      mode: "append" | "interrupt" | "follow-up";
      queueSize: number;
    }
  | { type: "steering_applied"; ids: string[]; queueSize: number }
  | { type: "steering_removed"; ids: string[]; queueSize: number }
  | { type: "model_retry"; attempt: number; delayMs: number; status?: number; reason: string }
  | { type: "compaction"; summary: string; droppedMessages: number }
  | { type: "usage"; turn: TokenUsage; session: TokenUsage }
  | { type: "agent_end"; response: AgentRunResult }
  | {
      type: "error";
      message: string;
      /**
       * P1-C: error severity.
       *   - `"fatal"` (default): the agent run is terminating; the error
       *     is followed by a throw or `agent_end` with `stopped:"error"`.
       *     Stream consumers should close the stream.
       *   - `"recoverable"`: the agent emitted a non-fatal error (e.g.
       *     output truncation, doom-loop guard) but continues the run.
       *     Stream consumers MUST keep the stream open — the agent will
       *     still emit `agent_end` normally.
       *
       * Backward compatibility: events emitted without `severity` are
       * treated as `"fatal"` by stream helpers (preserves existing
       * behavior). Code that only inspects `event.type === "error"` keeps
       * working; only terminators need to check `severity`.
       */
      severity?: "fatal" | "recoverable";
    }
  | { type: "spec_start"; input: string; trigger: "auto" | "explicit" }
  | { type: "spec_stage"; stage: string; model: string; durationMs: number; fellBack: boolean }
  | {
      type: "spec_draft_ready";
      specId: string;
      topic: string;
      understanding: unknown;
      taskBreakdown: unknown[];
    }
  | {
      type: "spec_confirmation_required";
      specId: string;
      decisions: unknown[];
    }
  | { type: "spec_confirmed"; specId: string; decisions: unknown[] }
  | { type: "spec_skipped"; reason: string }
  | { type: "spec_completed"; specId: string; enhancedPrompt: string };

export interface AgentRunResult {
  sessionId: string;
  entryId: string;
  content: string;
  rounds: number;
  toolCalls: number;
  usage: TokenUsage;
  stopped: ModelStopReason | "max_rounds";
}

export interface ModelProfile {
  provider: string;
  model: string;
  /**
   * Version-pinned model revision the unpinned `model` alias is expected to
   * resolve to. Enterprise allowlists can require an exact revision match via
   * `provider/model@revision` entries.
   */
  revision?: string;
  /**
   * Expected OpenAI-compatible `system_fingerprint`. When set, a response
   * whose fingerprint differs (or is absent) is treated as model drift and
   * handled according to `systemFingerprintPolicy`.
   */
  expectedSystemFingerprint?: string;
  /** Drift handling for `expectedSystemFingerprint`; enterprise defaults to "warn". */
  systemFingerprintPolicy?: "fail" | "warn" | "off";
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages" | "google-gemini";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  authType?: "api-key" | "bearer" | "none";
  oauthAccount?: string;
  extraHeaders?: Record<string, string>;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  toolMode: "native" | "prompt-json" | "auto";
  reasoningEffort: ReasoningEffort;
  capabilities: ModelCapabilities;
  compatibility: ProviderCompatibility;
  reliability: ModelReliabilityPolicy;
}

/** 经济型 compaction 的定价参数(USD per 1M tokens + 剩余轮次预估)。 */
export interface CompactionEconomics {
  /** 未命中输入单价(USD/1M)。 */
  missPricePerM: number;
  /** 命中输入单价(USD/1M);缺省视为 0。 */
  hitPricePerM?: number;
  /** 生成 summary 的输出单价(USD/1M);缺省用固定常量近似。 */
  outputPricePerM?: number;
  /** 会话预计剩余轮次(经济预估用)。 */
  expectedRemainingTurns: number;
  /** 风险边际系数(默认 1.5);oneTimeCost 乘以该值。 */
  riskMargin?: number;
}

export interface AgentRuntimeOptions {
  cwd: string;
  model: ModelProfile;
  modelClient: ModelClient;
  tools: AgentTool[];
  toolRegistry?: import("./tools.js").AgentToolRegistry;
  permission: {
    mode: ApprovalMode;
    projectTrusted: boolean;
    protectedPaths: string[];
    approve?: ApprovalHandler;
    prefixRules?: CommandPrefixRule[];
  };
  sessionStore: import("./session-store.js").SessionStore;
  sessionId?: string;
  sessionName?: string;
  systemPrompt?: string;
  instructions?: string[];
  maxRounds?: number;
  steeringMaximum?: number;
  steeringDelivery?: "all" | "one-at-a-time";
  eventSink?: (event: AgentEvent) => void | Promise<void>;
  extensionHost?: import("./extensions.js").ExtensionHostLike;
  auditJournal?: import("./audit-journal.js").AuditJournal;
  /**
   * Additional approval surfacing hook, invoked (before the agent's own
   * approval_required event) whenever an approval prompt is about to be
   * shown, on either execution path. Composition roots that drive the effect
   * spine hand CodingAgent.notifyApprovalRequired to the spine's ApprovalPort
   * bridge so spine approvals emit the same event as the legacy path.
   */
  onApprovalRequired?: (request: PermissionRequest) => void | Promise<void>;
  /**
   * Called after changeApproval applies a new mode; composition roots use it
   * to repoint the effect spine's policy matrix at the same mode.
   */
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  /**
   * Optional effect spine: when both are set, tool calls execute through
   * Policy → Grant → Receipt instead of the local PermissionController
   * authorize call. Composition roots enable this by default; an explicit
   * `agent.effectSpine: false` keeps the legacy direct-execution escape
   * hatch.
   */
  effectPort?: import("@focuscode/contracts").EffectPort;
  effectContext?: import("@focuscode/contracts").EffectContextV1;
}

export interface AgentPromptInput {
  text: string;
  attachments?: AgentAttachment[];
}

export interface SteeringReceipt {
  id: string;
  queueSize: number;
  mode: "append" | "interrupt" | "follow-up";
}
