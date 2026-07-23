import type { ApprovalMode } from "@focuscode/action-domain";

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
  messages: AgentMessage[];
  tools: ToolDefinition[];
  temperature: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
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
  | { type: "error"; message: string }
  | { type: "spec_start"; input: string; trigger: "auto" | "explicit" }
  | { type: "spec_stage"; stage: string; model: string; durationMs: number; fellBack: boolean }
  | { type: "spec_draft_ready"; specId: string; topic: string; understanding: unknown }
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
