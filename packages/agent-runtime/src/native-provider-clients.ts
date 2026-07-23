import type { ClientOptions } from "./model-clients.js";
import { fetchWithReliability } from "./http-transport.js";
import type {
  AgentMessage,
  AgentToolCall,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelReliabilityPolicy,
  ModelStopReason,
  ModelStreamEvent,
  TokenUsage,
} from "./types.js";

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

export class NativeProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "NativeProviderHttpError";
  }
}

export class OpenAIResponsesClient implements ModelClient {
  readonly protocol = "openai-responses";
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async complete(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void = () => undefined,
  ): Promise<ModelResponse> {
    const policy = nativeReliabilityPolicy(this.options);
    const controller = linkedController(request.signal, policy.timeoutMs);
    try {
      const credential = await credentialFor(this.options);
      const response = await fetchWithReliability(
        this.fetchImplementation,
        responsesEndpoint(this.options.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(credential ? { authorization: "Bearer " + credential } : {}),
            ...this.options.extraHeaders,
          },
          body: JSON.stringify({
            model: request.model,
            instructions: request.systemPrompt,
            input: toResponsesInput(request.messages),
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            })),
            tool_choice: request.tools.length ? "auto" : undefined,
            parallel_tool_calls: true,
            max_output_tokens: request.maxOutputTokens,
            temperature: request.temperature,
            stream: true,
          }),
          signal: controller.signal,
        },
        policy,
        onEvent,
      );
      if (!response.ok) await throwNativeHttpError(response);
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return parseResponsesJson(await response.json(), onEvent);
      }
      if (!response.body) throw new Error("OpenAI Responses stream has no body");
      return consumeResponsesStream(response.body, onEvent, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof NativeProviderHttpError)) {
        if (request.signal?.aborted) return emptyResponse("aborted");
        throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
      }
      throw error;
    } finally {
      controller.dispose();
    }
  }
}

export class GeminiClient implements ModelClient {
  readonly protocol = "google-gemini";
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async complete(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void = () => undefined,
  ): Promise<ModelResponse> {
    const policy = nativeReliabilityPolicy(this.options);
    const controller = linkedController(request.signal, policy.timeoutMs);
    try {
      const credential = await credentialFor(this.options);
      const response = await fetchWithReliability(
        this.fetchImplementation,
        geminiEndpoint(this.options.baseUrl, request.model),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(credential && this.options.authType === "bearer"
              ? { authorization: "Bearer " + credential }
              : credential
                ? { "x-goog-api-key": credential }
                : {}),
            ...this.options.extraHeaders,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: toGeminiContents(request.messages),
            ...(request.tools.length
              ? {
                  tools: [
                    {
                      functionDeclarations: request.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                      })),
                    },
                  ],
                  toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                }
              : {}),
            generationConfig: {
              temperature: request.temperature,
              maxOutputTokens: request.maxOutputTokens,
            },
          }),
          signal: controller.signal,
        },
        policy,
        onEvent,
      );
      if (!response.ok) await throwNativeHttpError(response);
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return parseGeminiJson(await response.json(), onEvent);
      }
      if (!response.body) throw new Error("Gemini stream has no body");
      return consumeGeminiStream(response.body, onEvent, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof NativeProviderHttpError)) {
        if (request.signal?.aborted) return emptyResponse("aborted");
        throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
      }
      throw error;
    } finally {
      controller.dispose();
    }
  }
}

export async function consumeResponsesStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ModelStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  let content = "";
  let reasoning = "";
  let usage = zeroUsage();
  let stopReason: ModelStopReason = "stop";
  const calls = new Map<number, PartialCall>();
  await consumeSse(
    body,
    (data) => {
      if (data === "[DONE]") return;
      const event = parseObject(data, "Responses stream event");
      const type = stringValue(event.type);
      if (type === "response.output_text.delta") {
        const delta = stringValue(event.delta);
        if (delta) {
          content += delta;
          onEvent({ type: "text_delta", delta });
        }
      }
      if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      ) {
        const delta = stringValue(event.delta);
        if (delta) {
          reasoning += delta;
          onEvent({ type: "reasoning_delta", delta });
        }
      }
      if (type === "response.output_item.added") {
        const index = numberValue(event.output_index);
        const item = objectValue(event.item);
        if (item?.type === "function_call") {
          calls.set(index, {
            id: stringValue(item.call_id) || stringValue(item.id) || "call_" + index,
            name: stringValue(item.name),
            arguments: stringValue(item.arguments),
          });
        }
      }
      if (type === "response.function_call_arguments.delta") {
        const index = numberValue(event.output_index);
        const current = calls.get(index) ?? {
          id: stringValue(event.item_id) || "call_" + index,
          name: stringValue(event.name),
          arguments: "",
        };
        const delta = stringValue(event.delta);
        current.arguments += delta;
        calls.set(index, current);
        onEvent({ type: "tool_call_delta", index, arguments: delta });
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const response = objectValue(event.response);
        usage = responsesUsage(objectValue(response?.usage) ?? {});
        onEvent({ type: "usage", usage });
        if (type === "response.incomplete") stopReason = "length";
        mergeResponseOutput(response, calls);
      }
      if (type === "response.failed" || type === "error") stopReason = "error";
    },
    signal,
  );
  const toolCalls = finalizeCalls(calls);
  if (toolCalls.length) stopReason = "tool_use";
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage,
    stopReason,
  };
}

export async function consumeGeminiStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ModelStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  let content = "";
  let reasoning = "";
  let usage = zeroUsage();
  let stopReason: ModelStopReason = "stop";
  const calls = new Map<number, PartialCall>();
  await consumeSse(
    body,
    (data) => {
      if (data === "[DONE]") return;
      const chunk = parseObject(data, "Gemini stream event");
      const candidate = firstObject(chunk.candidates);
      const contentValue = objectValue(candidate?.content);
      const parts = Array.isArray(contentValue?.parts) ? contentValue.parts : [];
      for (const raw of parts) {
        const part = objectValue(raw);
        if (!part) continue;
        const text = stringValue(part.text);
        if (text && part.thought === true) {
          reasoning += text;
          onEvent({ type: "reasoning_delta", delta: text });
        } else if (text) {
          content += text;
          onEvent({ type: "text_delta", delta: text });
        }
        const functionCall = objectValue(part.functionCall);
        if (functionCall) {
          const index = calls.size;
          const argumentsValue = objectValue(functionCall.args) ?? {};
          calls.set(index, {
            id: stringValue(functionCall.id) || "gemini_call_" + index,
            name: stringValue(functionCall.name),
            arguments: JSON.stringify(argumentsValue),
          });
          onEvent({
            type: "tool_call_delta",
            index,
            id: stringValue(functionCall.id) || "gemini_call_" + index,
            name: stringValue(functionCall.name),
            arguments: JSON.stringify(argumentsValue),
          });
        }
      }
      const rawFinish = stringValue(candidate?.finishReason);
      if (rawFinish === "MAX_TOKENS") stopReason = "length";
      if (rawFinish && !["STOP", "MAX_TOKENS"].includes(rawFinish)) stopReason = "error";
      const metadata = objectValue(chunk.usageMetadata);
      if (metadata) {
        usage = geminiUsage(metadata);
        onEvent({ type: "usage", usage });
      }
    },
    signal,
  );
  const toolCalls = finalizeCalls(calls);
  if (toolCalls.length) stopReason = "tool_use";
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage,
    stopReason,
  };
}

function parseResponsesJson(
  value: unknown,
  onEvent: (event: ModelStreamEvent) => void,
): ModelResponse {
  const response = requireObject(value, "Responses response");
  let content = "";
  let reasoning = "";
  const calls = new Map<number, PartialCall>();
  for (const [index, raw] of (Array.isArray(response.output) ? response.output : []).entries()) {
    const item = objectValue(raw);
    if (item?.type === "message") {
      for (const rawPart of Array.isArray(item.content) ? item.content : []) {
        const part = objectValue(rawPart);
        if (part?.type === "output_text") content += stringValue(part.text);
      }
    }
    if (item?.type === "reasoning") {
      for (const rawPart of Array.isArray(item.summary) ? item.summary : []) {
        reasoning += stringValue(objectValue(rawPart)?.text);
      }
    }
    if (item?.type === "function_call") {
      calls.set(index, {
        id: stringValue(item.call_id) || stringValue(item.id) || "call_" + index,
        name: stringValue(item.name),
        arguments: stringValue(item.arguments),
      });
    }
  }
  if (content) onEvent({ type: "text_delta", delta: content });
  if (reasoning) onEvent({ type: "reasoning_delta", delta: reasoning });
  const usage = responsesUsage(objectValue(response.usage) ?? {});
  onEvent({ type: "usage", usage });
  const toolCalls = finalizeCalls(calls);
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage,
    stopReason: toolCalls.length
      ? "tool_use"
      : response.status === "incomplete"
        ? "length"
        : response.status === "failed"
          ? "error"
          : "stop",
  };
}

function parseGeminiJson(
  value: unknown,
  onEvent: (event: ModelStreamEvent) => void,
): ModelResponse {
  const body = requireObject(value, "Gemini response");
  const candidate = firstObject(body.candidates);
  const responseContent = objectValue(candidate?.content);
  const parts = Array.isArray(responseContent?.parts) ? responseContent.parts : [];
  let content = "";
  let reasoning = "";
  const calls = new Map<number, PartialCall>();
  for (const raw of parts) {
    const part = objectValue(raw);
    if (!part) continue;
    const text = stringValue(part.text);
    if (part.thought === true) reasoning += text;
    else content += text;
    const functionCall = objectValue(part.functionCall);
    if (functionCall) {
      const index = calls.size;
      calls.set(index, {
        id: stringValue(functionCall.id) || "gemini_call_" + index,
        name: stringValue(functionCall.name),
        arguments: JSON.stringify(objectValue(functionCall.args) ?? {}),
      });
    }
  }
  if (content) onEvent({ type: "text_delta", delta: content });
  if (reasoning) onEvent({ type: "reasoning_delta", delta: reasoning });
  const usage = geminiUsage(objectValue(body.usageMetadata) ?? {});
  onEvent({ type: "usage", usage });
  const toolCalls = finalizeCalls(calls);
  return {
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    usage,
    stopReason: toolCalls.length
      ? "tool_use"
      : stringValue(candidate?.finishReason) === "MAX_TOKENS"
        ? "length"
        : "stop",
  };
}

function toResponsesInput(messages: AgentMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    const content = [
      ...(message.content
        ? [
            {
              type: message.role === "assistant" ? "output_text" : "input_text",
              text: message.content,
            },
          ]
        : []),
      ...(message.role === "user"
        ? (message.attachments ?? []).map((attachment) => ({
            type: "input_image",
            image_url:
              attachment.source.type === "url"
                ? attachment.source.url
                : "data:" + attachment.mediaType + ";base64," + attachment.source.data,
            detail: attachment.detail ?? "auto",
          }))
        : []),
    ];
    input.push({ role: message.role, content });
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.rawArguments ?? JSON.stringify(call.arguments),
      });
    }
  }
  return input;
}

function toGeminiContents(messages: AgentMessage[]): unknown[] {
  const output: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      output.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName,
              response: { content: message.content },
            },
          },
        ],
      });
      continue;
    }
    const parts: unknown[] = [
      ...(message.content ? [{ text: message.content }] : []),
      ...(message.attachments ?? []).map((attachment) =>
        attachment.source.type === "url"
          ? { fileData: { mimeType: attachment.mediaType, fileUri: attachment.source.url } }
          : { inlineData: { mimeType: attachment.mediaType, data: attachment.source.data } },
      ),
      ...(message.toolCalls ?? []).map((call) => ({
        functionCall: { id: call.id, name: call.name, args: call.arguments },
      })),
    ];
    output.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return output;
}

function mergeResponseOutput(
  response: Record<string, unknown> | undefined,
  calls: Map<number, PartialCall>,
): void {
  if (!response || !Array.isArray(response.output)) return;
  for (const [index, raw] of response.output.entries()) {
    const item = objectValue(raw);
    if (item?.type !== "function_call") continue;
    const current = calls.get(index);
    calls.set(index, {
      id: current?.id || stringValue(item.call_id) || stringValue(item.id) || "call_" + index,
      name: current?.name || stringValue(item.name),
      arguments: current?.arguments || stringValue(item.arguments),
    });
  }
}

function finalizeCalls(calls: Map<number, PartialCall>): AgentToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => {
      const rawArguments = call.arguments || "{}";
      let argumentsValue: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        argumentsValue =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { _invalid: "Tool arguments must be an object" };
      } catch (error) {
        argumentsValue = {
          _invalid: error instanceof Error ? error.message : "Invalid JSON",
          _raw: rawArguments,
        };
      }
      return {
        id: call.id || "call_" + index,
        name: call.name,
        arguments: argumentsValue,
        rawArguments,
      };
    });
}

async function consumeSse(
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
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) emitSse(event, onData);
    }
    buffer += decoder.decode();
    if (buffer.trim()) emitSse(buffer, onData);
  } finally {
    reader.releaseLock();
  }
}

function emitSse(event: string, onData: (data: string) => void): void {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data) onData(data);
}

function responsesUsage(value: Record<string, unknown>): TokenUsage {
  const details = objectValue(value.input_tokens_details);
  const cached = numberValue(details?.cached_tokens);
  return {
    inputTokens: numberValue(value.input_tokens),
    outputTokens: numberValue(value.output_tokens),
    ...(cached ? { cachedInputTokens: cached } : {}),
  };
}

function geminiUsage(value: Record<string, unknown>): TokenUsage {
  const cached = numberValue(value.cachedContentTokenCount);
  return {
    inputTokens: numberValue(value.promptTokenCount),
    outputTokens: numberValue(value.candidatesTokenCount),
    ...(cached ? { cachedInputTokens: cached } : {}),
  };
}

function responsesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/responses") ? normalized : normalized + "/responses";
}

function geminiEndpoint(baseUrl: string, model: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized + "/models/" + encodeURIComponent(model) + ":streamGenerateContent?alt=sse";
}

async function credentialFor(options: ClientOptions): Promise<string | undefined> {
  if (options.authType === "none") return undefined;
  return (await options.accessTokenProvider?.()) ?? options.apiKey;
}

async function throwNativeHttpError(response: Response): Promise<never> {
  const body = (await response.text()).slice(0, 4_000);
  throw new NativeProviderHttpError(
    "Native provider endpoint returned HTTP " + response.status,
    response.status,
    body,
  );
}

function linkedController(signal: AbortSignal | undefined, timeoutMs: number) {
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

function nativeReliabilityPolicy(options: ClientOptions): ModelReliabilityPolicy {
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

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    return requireObject(JSON.parse(value), label);
  } catch (error) {
    throw new Error(
      label + " is invalid JSON: " + (error instanceof Error ? error.message : String(error)),
    );
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? objectValue(value[0]) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
