import type {
  AgentMessage,
  AgentToolCall,
  AnthropicThinkingBlock,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelReliabilityPolicy,
  ModelStopReason,
  ModelStreamEvent,
  ProviderCompatibility,
  TokenUsage,
} from "./types.js";
import { GeminiClient, OpenAIResponsesClient } from "./native-provider-clients.js";
import { fetchWithReliability } from "./http-transport.js";

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  authType?: "api-key" | "bearer" | "none";
  accessTokenProvider?: () => Promise<string | undefined>;
  extraHeaders?: Record<string, string>;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  compatibility?: ProviderCompatibility;
  reliability?: ModelReliabilityPolicy;
  /** Expected OpenAI-compatible `system_fingerprint`; see ModelProfile. */
  expectedSystemFingerprint?: string;
  systemFingerprintPolicy?: "fail" | "warn" | "off";
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class ModelHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}

/** Raised when an observed `system_fingerprint` does not match the pinned expectation. */
export class ModelResponseDriftError extends Error {
  constructor(
    readonly expected: string,
    readonly observed: string | undefined,
  ) {
    super(
      `Model system_fingerprint drift: expected ${expected}, observed ${observed ?? "<absent>"}`,
    );
    this.name = "ModelResponseDriftError";
  }
}

/**
 * Compares an observed fingerprint against the pinned expectation. Missing
 * fingerprints count as drift: a pinned expectation the provider does not
 * report on cannot be verified, so silence is not a pass.
 */
export function enforceSystemFingerprint(
  observed: string | undefined,
  options: Pick<ClientOptions, "expectedSystemFingerprint" | "systemFingerprintPolicy">,
): void {
  const expected = options.expectedSystemFingerprint;
  if (!expected) return;
  const policy = options.systemFingerprintPolicy ?? "fail";
  if (policy === "off") return;
  if (observed === expected) return;
  if (policy === "warn") {
    process.stderr.write(
      `Warning: model system_fingerprint drift: expected ${expected}, observed ${observed ?? "<absent>"}\n`,
    );
    return;
  }
  throw new ModelResponseDriftError(expected, observed);
}

export class OpenAIChatClient implements ModelClient {
  readonly protocol = "openai-chat";
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async complete(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void = () => undefined,
  ): Promise<ModelResponse> {
    const policy = reliabilityPolicy(this.options);
    const controller = linkedAbortController(request.signal, policy.timeoutMs);
    try {
      const credential = await resolveCredential(this.options);
      const compatibility = compatibilityPolicy(this.options);
      const response = await fetchWithReliability(
        this.fetchImplementation,
        openAIEndpoint(this.options.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
            ...this.options.extraHeaders,
          },
          body: JSON.stringify(buildOpenAIRequest(request, compatibility)),
          signal: controller.signal,
        },
        policy,
        onEvent,
      );
      if (!response.ok) await throwHttpError(response);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const parsed = parseOpenAIJson(await response.json(), onEvent);
        enforceSystemFingerprint(parsed.systemFingerprint, this.options);
        return parsed;
      }
      if (!response.body) throw new Error("Model response has no stream body");
      const streamed = await consumeOpenAIStream(response.body, onEvent, controller.signal);
      enforceSystemFingerprint(streamed.systemFingerprint, this.options);
      return streamed;
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ModelHttpError)) {
        if (request.signal?.aborted) return emptyResponse("aborted");
        throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
      }
      throw error;
    } finally {
      controller.dispose();
    }
  }
}

export class AnthropicMessagesClient implements ModelClient {
  readonly protocol = "anthropic-messages";
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async complete(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void = () => undefined,
  ): Promise<ModelResponse> {
    const policy = reliabilityPolicy(this.options);
    const controller = linkedAbortController(request.signal, policy.timeoutMs);
    try {
      const credential = await resolveCredential(this.options);
      const compatibility = compatibilityPolicy(this.options);
      const thinking = anthropicThinkingRequest(request, compatibility);
      const response = await fetchWithReliability(
        this.fetchImplementation,
        anthropicEndpoint(this.options.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(credential && this.options.authType === "bearer"
              ? { authorization: `Bearer ${credential}` }
              : credential
                ? { "x-api-key": credential }
                : {}),
            ...this.options.extraHeaders,
          },
          body: JSON.stringify({
            model: request.model,
            system: anthropicSystemField(request),
            messages: toAnthropicMessages(request.messages),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
            max_tokens: request.maxOutputTokens,
            temperature: request.temperature,
            stream: true,
            ...(thinking ? { thinking } : {}),
          }),
          signal: controller.signal,
        },
        policy,
        onEvent,
      );
      if (!response.ok) await throwHttpError(response);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        return parseAnthropicJson(await response.json(), onEvent);
      }
      if (!response.body) throw new Error("Model response has no stream body");
      return consumeAnthropicStream(response.body, onEvent, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ModelHttpError)) {
        if (request.signal?.aborted) return emptyResponse("aborted");
        throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
      }
      throw error;
    } finally {
      controller.dispose();
    }
  }
}

export function createModelClient(options: {
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages" | "google-gemini";
  baseUrl: string;
  apiKey?: string;
  authType?: "api-key" | "bearer" | "none";
  accessTokenProvider?: () => Promise<string | undefined>;
  extraHeaders?: Record<string, string>;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  compatibility?: ProviderCompatibility;
  reliability?: ModelReliabilityPolicy;
}): ModelClient {
  if (options.protocol === "anthropic-messages") return new AnthropicMessagesClient(options);
  if (options.protocol === "openai-responses") return new OpenAIResponsesClient(options);
  if (options.protocol === "google-gemini") return new GeminiClient(options);
  return new OpenAIChatClient(options);
}

function buildOpenAIRequest(
  request: ModelRequest,
  compatibility: Required<ProviderCompatibility>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAIMessages(request.systemPrompt, request.messages, compatibility),
    stream: true,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    if (compatibility.supportsToolChoice) body.tool_choice = "auto";
    if (compatibility.supportsParallelToolCalls) body.parallel_tool_calls = true;
    if (compatibility.zaiToolStream) body.tool_stream = true;
  }
  if (compatibility.supportsStreamUsage) body.stream_options = { include_usage: true };
  if (compatibility.supportsTemperature) body.temperature = request.temperature;
  body[compatibility.maxTokensField] = request.maxOutputTokens;
  applyReasoningOptions(body, request, compatibility);
  return body;
}

function applyReasoningOptions(
  body: Record<string, unknown>,
  request: ModelRequest,
  compatibility: Required<ProviderCompatibility>,
): void {
  const enabled = request.reasoningEffort !== undefined && request.reasoningEffort !== "off";
  if (compatibility.thinkingFormat === "qwen") {
    body.enable_thinking = enabled;
    return;
  }
  if (compatibility.thinkingFormat === "zai") {
    body.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
  } else if (compatibility.thinkingFormat === "deepseek") {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
  }
  if (enabled && compatibility.supportsReasoningEffort) {
    body.reasoning_effort =
      compatibility.reasoningEffortMap[request.reasoningEffort!] ?? request.reasoningEffort;
  }
}

function compatibilityPolicy(options: ClientOptions): Required<ProviderCompatibility> {
  return {
    supportsParallelToolCalls: options.compatibility?.supportsParallelToolCalls ?? true,
    supportsStreamUsage: options.compatibility?.supportsStreamUsage ?? true,
    supportsToolChoice: options.compatibility?.supportsToolChoice ?? true,
    supportsTemperature: options.compatibility?.supportsTemperature ?? true,
    supportsReasoningEffort: options.compatibility?.supportsReasoningEffort ?? false,
    maxTokensField: options.compatibility?.maxTokensField ?? "max_tokens",
    thinkingFormat: options.compatibility?.thinkingFormat ?? "openai",
    requiresReasoningContentOnAssistantMessages:
      options.compatibility?.requiresReasoningContentOnAssistantMessages ?? false,
    requiresToolResultName: options.compatibility?.requiresToolResultName ?? false,
    requiresAssistantContentForToolCalls:
      options.compatibility?.requiresAssistantContentForToolCalls ?? false,
    zaiToolStream: options.compatibility?.zaiToolStream ?? false,
    reasoningEffortMap: options.compatibility?.reasoningEffortMap ?? {},
    anthropicThinking: options.compatibility?.anthropicThinking ?? "omit",
    anthropicThinkingBudgetTokens: options.compatibility?.anthropicThinkingBudgetTokens ?? 16_384,
  };
}

function anthropicThinkingRequest(
  request: ModelRequest,
  compatibility: Required<ProviderCompatibility>,
): Record<string, unknown> | undefined {
  const mode = compatibility.anthropicThinking;
  if (mode === "omit") return undefined;
  if (request.reasoningEffort === undefined || request.reasoningEffort === "off") {
    return { type: "disabled" };
  }
  if (mode === "adaptive") return { type: "adaptive" };
  if (mode === "enabled") {
    return {
      type: "enabled",
      budget_tokens: Math.min(
        compatibility.anthropicThinkingBudgetTokens,
        Math.max(1_024, request.maxOutputTokens - 1),
      ),
    };
  }
  return { type: "disabled" };
}

export function reliabilityPolicy(options: ClientOptions): ModelReliabilityPolicy {
  return {
    timeoutMs: options.reliability?.timeoutMs ?? options.timeoutMs ?? 300_000,
    // Keep in sync with DEFAULT_RELIABILITY in config.ts.
    maxRetries: options.reliability?.maxRetries ?? 2,
    retryBaseDelayMs: options.reliability?.retryBaseDelayMs ?? 500,
    retryMaximumDelayMs: options.reliability?.retryMaximumDelayMs ?? 10_000,
    ...(options.reliability?.circuitThreshold !== undefined
      ? { circuitThreshold: options.reliability.circuitThreshold }
      : {}),
    ...(options.reliability?.circuitCooldownMs !== undefined
      ? { circuitCooldownMs: options.reliability.circuitCooldownMs }
      : {}),
    ...(options.reliability?.maxConcurrency !== undefined
      ? { maxConcurrency: options.reliability.maxConcurrency }
      : {}),
  };
}

export async function consumeOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ModelStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  let content = "";
  let reasoning = "";
  let usage = zeroUsage();
  let stopReason: ModelStopReason = "stop";
  let systemFingerprint: string | undefined;
  const calls = new Map<number, PartialToolCall>();
  await consumeSse(
    body,
    (data) => {
      if (data === "[DONE]") return;
      const chunk = parseObject(data, "OpenAI stream event");
      const fingerprint = stringOrUndefined(chunk.system_fingerprint);
      if (fingerprint) systemFingerprint = fingerprint;
      const rawUsage = objectOrUndefined(chunk.usage);
      if (rawUsage) {
        usage = openAIUsage(rawUsage);
        onEvent({ type: "usage", usage });
      }
      const choice = arrayFirstObject(chunk.choices);
      if (!choice) return;
      const finish = stringOrUndefined(choice.finish_reason);
      if (finish) stopReason = normalizeOpenAIStop(finish);
      const delta = objectOrUndefined(choice.delta);
      if (!delta) return;
      const text = stringOrUndefined(delta.content);
      if (text) {
        content += text;
        onEvent({ type: "text_delta", delta: text });
      }
      const thought =
        stringOrUndefined(delta.reasoning_content) ?? stringOrUndefined(delta.reasoning);
      if (thought) {
        reasoning += thought;
        onEvent({ type: "reasoning_delta", delta: thought });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!rawCall || typeof rawCall !== "object") continue;
          const call = rawCall as Record<string, unknown>;
          const index = typeof call.index === "number" ? call.index : calls.size;
          const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
          const fn = objectOrUndefined(call.function);
          current.id += stringOrUndefined(call.id) ?? "";
          current.name += stringOrUndefined(fn?.name) ?? "";
          current.arguments += stringOrUndefined(fn?.arguments) ?? "";
          calls.set(index, current);
          onEvent({
            type: "tool_call_delta",
            index,
            ...(call.id ? { id: String(call.id) } : {}),
            ...(fn?.name ? { name: String(fn.name) } : {}),
            ...(fn?.arguments ? { arguments: String(fn.arguments) } : {}),
          });
        }
      }
    },
    signal,
  );
  const toolCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => finalizeCall(call, index));
  if (toolCalls.length > 0) stopReason = "tool_use";
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(systemFingerprint ? { systemFingerprint } : {}),
    toolCalls,
    usage,
    stopReason,
  };
}

export async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ModelStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  let content = "";
  let reasoning = "";
  let usage = zeroUsage();
  let stopReason: ModelStopReason = "stop";
  const calls = new Map<number, PartialToolCall>();
  const thinkingBlocks = new Map<number, AnthropicThinkingBlock>();
  await consumeSse(
    body,
    (data) => {
      if (data === "[DONE]") return;
      const event = parseObject(data, "Anthropic stream event");
      const type = stringOrUndefined(event.type);
      if (type === "message_start") {
        const message = objectOrUndefined(event.message);
        usage = anthropicUsage(objectOrUndefined(message?.usage) ?? {});
      }
      if (type === "content_block_start") {
        const index = numberOrZero(event.index);
        const block = objectOrUndefined(event.content_block);
        if (block?.type === "tool_use") {
          calls.set(index, {
            id: stringOrUndefined(block.id) ?? `call_${index}`,
            name: stringOrUndefined(block.name) ?? "",
            arguments: "",
          });
        }
        if (block?.type === "thinking") {
          thinkingBlocks.set(index, {
            type: "thinking",
            thinking: stringOrUndefined(block.thinking) ?? "",
            ...(stringOrUndefined(block.signature)
              ? { signature: stringOrUndefined(block.signature)! }
              : {}),
          });
        }
        if (block?.type === "redacted_thinking" && typeof block.data === "string") {
          thinkingBlocks.set(index, { type: "redacted_thinking", data: block.data });
        }
      }
      if (type === "content_block_delta") {
        const index = numberOrZero(event.index);
        const delta = objectOrUndefined(event.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          content += delta.text;
          onEvent({ type: "text_delta", delta: delta.text });
        }
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          reasoning += delta.thinking;
          const current = thinkingBlocks.get(index);
          if (current?.type === "thinking") current.thinking += delta.thinking;
          else thinkingBlocks.set(index, { type: "thinking", thinking: delta.thinking });
          onEvent({ type: "reasoning_delta", delta: delta.thinking });
        }
        if (delta?.type === "signature_delta" && typeof delta.signature === "string") {
          const current = thinkingBlocks.get(index);
          if (current?.type === "thinking") {
            current.signature = (current.signature ?? "") + delta.signature;
          }
        }
        if (delta?.type === "input_json_delta") {
          const partial = stringOrUndefined(delta.partial_json) ?? "";
          const current = calls.get(index) ?? { id: `call_${index}`, name: "", arguments: "" };
          current.arguments += partial;
          calls.set(index, current);
          onEvent({ type: "tool_call_delta", index, arguments: partial });
        }
      }
      if (type === "message_delta") {
        const delta = objectOrUndefined(event.delta);
        const rawStop = stringOrUndefined(delta?.stop_reason);
        if (rawStop) stopReason = normalizeAnthropicStop(rawStop);
        const nextUsage = objectOrUndefined(event.usage);
        if (nextUsage) {
          usage = {
            inputTokens: usage.inputTokens,
            outputTokens: numberOrZero(nextUsage.output_tokens),
            ...(usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
          };
          onEvent({ type: "usage", usage });
        }
      }
    },
    signal,
  );
  const toolCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => finalizeCall(call, index));
  if (toolCalls.length > 0) stopReason = "tool_use";
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(thinkingBlocks.size > 0
      ? {
          providerState: {
            thinkingBlocks: [...thinkingBlocks.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, block]) => block),
          },
        }
      : {}),
    toolCalls,
    usage,
    stopReason,
  };
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = buffer.split(/\r?\n\r?\n/);
      buffer = split.pop() ?? "";
      for (const event of split) emitSseData(event, onData);
    }
    buffer += decoder.decode();
    if (buffer.trim()) emitSseData(buffer, onData);
  } finally {
    reader.releaseLock();
  }
}

function emitSseData(event: string, onData: (data: string) => void): void {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data) onData(data);
}

function parseOpenAIJson(
  value: unknown,
  onEvent: (event: ModelStreamEvent) => void,
): ModelResponse {
  const body = requireObject(value, "OpenAI response");
  const choice = arrayFirstObject(body.choices);
  if (!choice) throw new Error("OpenAI response has no choices[0]");
  const message = requireObject(choice.message, "OpenAI response message");
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning =
    stringOrUndefined(message.reasoning_content) ??
    stringOrUndefined(message.reasoning) ??
    stringOrUndefined(message.reasoning_text);
  if (content) onEvent({ type: "text_delta", delta: content });
  if (reasoning) onEvent({ type: "reasoning_delta", delta: reasoning });
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((raw, index) => {
        const call = requireObject(raw, `tool_calls[${index}]`);
        const fn = requireObject(call.function, `tool_calls[${index}].function`);
        return finalizeCall(
          {
            id: stringOrUndefined(call.id) ?? `call_${index}`,
            name: stringOrUndefined(fn.name) ?? "",
            arguments: stringOrUndefined(fn.arguments) ?? "{}",
          },
          index,
        );
      })
    : [];
  const usage = openAIUsage(objectOrUndefined(body.usage) ?? {});
  onEvent({ type: "usage", usage });
  const systemFingerprint = stringOrUndefined(body.system_fingerprint);
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(systemFingerprint ? { systemFingerprint } : {}),
    toolCalls: calls,
    usage,
    stopReason: calls.length > 0 ? "tool_use" : normalizeOpenAIStop(String(choice.finish_reason)),
  };
}

function parseAnthropicJson(
  value: unknown,
  onEvent: (event: ModelStreamEvent) => void,
): ModelResponse {
  const body = requireObject(value, "Anthropic response");
  const blocks = Array.isArray(body.content) ? body.content : [];
  let content = "";
  let reasoning = "";
  const calls: AgentToolCall[] = [];
  const thinkingBlocks: AnthropicThinkingBlock[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") content += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoning += block.thinking;
      thinkingBlocks.push({
        type: "thinking",
        thinking: block.thinking,
        ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      });
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") {
      thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
    }
    if (block.type === "tool_use") {
      calls.push({
        id: stringOrUndefined(block.id) ?? `call_${calls.length}`,
        name: stringOrUndefined(block.name) ?? "",
        arguments: objectOrUndefined(block.input) ?? {},
      });
    }
  }
  if (content) onEvent({ type: "text_delta", delta: content });
  if (reasoning) onEvent({ type: "reasoning_delta", delta: reasoning });
  const usage = anthropicUsage(objectOrUndefined(body.usage) ?? {});
  onEvent({ type: "usage", usage });
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    ...(thinkingBlocks.length > 0 ? { providerState: { thinkingBlocks } } : {}),
    toolCalls: calls,
    usage,
    stopReason:
      calls.length > 0
        ? "tool_use"
        : normalizeAnthropicStop(String(body.stop_reason ?? "end_turn")),
  };
}

function toOpenAIMessages(
  systemPrompt: string,
  messages: AgentMessage[],
  compatibility: Required<ProviderCompatibility>,
): unknown[] {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
          ...(compatibility.requiresToolResultName && message.toolName
            ? { name: message.toolName }
            : {}),
        };
      }
      if (message.role === "assistant") {
        const output: Record<string, unknown> = {
          role: "assistant",
          content:
            message.content ||
            (message.toolCalls?.length && compatibility.requiresAssistantContentForToolCalls
              ? ""
              : null),
        };
        if (message.toolCalls?.length) {
          output.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.rawArguments ?? JSON.stringify(call.arguments),
            },
          }));
        }
        if (message.providerState?.reasoningContent) {
          output.reasoning_content = message.providerState.reasoningContent;
        } else if (compatibility.requiresReasoningContentOnAssistantMessages) {
          output.reasoning_content = "";
        }
        return output;
      }
      return { role: message.role, content: toOpenAIContent(message) };
    }),
  ];
}

/**
 * Build the Anthropic Messages API `system` field. When `systemPromptParts`
 * is provided, the stable prefix gets an `ephemeral` cache breakpoint so the
 * Provider caches the stable portion across rounds. When absent, the plain
 * `systemPrompt` string is returned (backward compatible).
 */
function anthropicSystemField(
  request: ModelRequest,
): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  const parts = request.systemPromptParts;
  if (!parts) return request.systemPrompt;
  const blocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
    { type: "text", text: parts.stable, cache_control: { type: "ephemeral" } },
  ];
  if (parts.dynamic) {
    blocks.push({ type: "text", text: parts.dynamic });
  }
  return blocks;
}

function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const output: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "tool") {
      const results: unknown[] = [];
      let cursor = index;
      while (messages[cursor]?.role === "tool") {
        const tool = messages[cursor]!;
        results.push({
          type: "tool_result",
          tool_use_id: tool.toolCallId,
          content: tool.content,
        });
        cursor += 1;
      }
      output.push({
        role: "user",
        content: results,
      });
      index = cursor - 1;
    } else if (message.role === "assistant") {
      output.push({
        role: "assistant",
        content: [
          ...(message.providerState?.thinkingBlocks ?? []).map((block) => structuredClone(block)),
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        ],
      });
    } else {
      output.push({ role: message.role, content: toAnthropicContent(message) });
    }
  }
  return output;
}

function toOpenAIContent(message: AgentMessage): unknown {
  if (!message.attachments?.length) return message.content;
  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...message.attachments.map((attachment) => ({
      type: "image_url",
      image_url: {
        url:
          attachment.source.type === "url"
            ? attachment.source.url
            : `data:${attachment.mediaType};base64,${attachment.source.data}`,
        detail: attachment.detail ?? "auto",
      },
    })),
  ];
}

function toAnthropicContent(message: AgentMessage): unknown {
  if (!message.attachments?.length) return message.content;
  return [
    ...(message.content ? [{ type: "text", text: message.content }] : []),
    ...message.attachments.map((attachment) => ({
      type: "image",
      source:
        attachment.source.type === "url"
          ? { type: "url", url: attachment.source.url }
          : {
              type: "base64",
              media_type: attachment.mediaType,
              data: attachment.source.data,
            },
    })),
  ];
}

function finalizeCall(call: PartialToolCall, index: number): AgentToolCall {
  let argumentsValue: Record<string, unknown> = {};
  const raw = call.arguments || "{}";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      argumentsValue = parsed as Record<string, unknown>;
    } else {
      argumentsValue = { _invalid: "Tool arguments must be a JSON object" };
    }
  } catch (error) {
    argumentsValue = {
      _invalid: error instanceof Error ? error.message : "Invalid JSON",
      _raw: raw,
    };
  }
  return {
    id: call.id || `call_${index}`,
    name: call.name,
    arguments: argumentsValue,
    rawArguments: raw,
  };
}

function openAIEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

function anthropicEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  if (normalized.endsWith("/messages")) return normalized;
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

async function throwHttpError(response: Response): Promise<never> {
  const body = (await response.text()).slice(0, 4_000);
  throw new ModelHttpError(
    `Model endpoint returned HTTP ${response.status}`,
    response.status,
    body,
  );
}

function linkedAbortController(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Model request timed out")), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function emptyResponse(stopReason: ModelStopReason): ModelResponse {
  return { content: "", toolCalls: [], usage: zeroUsage(), stopReason };
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function openAIUsage(value: Record<string, unknown>): TokenUsage {
  const details = objectOrUndefined(value.prompt_tokens_details);
  const cached = numberOrZero(details?.cached_tokens);
  return {
    inputTokens: numberOrZero(value.prompt_tokens),
    outputTokens: numberOrZero(value.completion_tokens),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function anthropicUsage(value: Record<string, unknown>): TokenUsage {
  const cached = numberOrZero(value.cache_read_input_tokens);
  return {
    inputTokens:
      numberOrZero(value.input_tokens) + numberOrZero(value.cache_creation_input_tokens) + cached,
    outputTokens: numberOrZero(value.output_tokens),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function normalizeOpenAIStop(value: string): ModelStopReason {
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "length";
  return "stop";
}

function normalizeAnthropicStop(value: string): ModelStopReason {
  if (value === "tool_use") return "tool_use";
  if (value === "max_tokens") return "length";
  return "stop";
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    return requireObject(JSON.parse(value), label);
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayFirstObject(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? objectOrUndefined(value[0]) : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

async function resolveCredential(options: ClientOptions): Promise<string | undefined> {
  if (options.authType === "none") return undefined;
  return (await options.accessTokenProvider?.()) ?? options.apiKey;
}
