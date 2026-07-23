import type { UsageRecordV1 } from "@focuscode/contracts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelTransportRequest {
  model: string;
  messages: ChatMessage[];
  responseFormat: "json";
  timeoutMs: number;
}

export interface ModelTransportResponse {
  chunks: string[];
  finishReason: string | null;
  usage: UsageRecordV1;
}

export interface ModelTransport {
  complete(request: ModelTransportRequest): Promise<ModelTransportResponse>;
}

export interface OpenAICompatibleTransportOptions {
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}

export class OpenAICompatibleTransport implements ModelTransport {
  constructor(private readonly options: OpenAICompatibleTransportOptions) {}

  async complete(request: ModelTransportRequest): Promise<ModelTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    timer.unref();
    try {
      const endpoint = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.extraHeaders,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
          temperature: 0,
          response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined,
        }),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(
          `Model endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 1_000)}`,
        );
      }
      const body: unknown = JSON.parse(bodyText);
      if (!body || typeof body !== "object") throw new Error("Model response must be an object");
      const record = body as Record<string, unknown>;
      const choices = record.choices;
      if (
        !Array.isArray(choices) ||
        choices.length === 0 ||
        !choices[0] ||
        typeof choices[0] !== "object"
      ) {
        throw new Error("Model response has no choices[0]");
      }
      const choice = choices[0] as Record<string, unknown>;
      const message = choice.message;
      if (!message || typeof message !== "object") throw new Error("Model response has no message");
      const content = (message as Record<string, unknown>).content;
      if (typeof content !== "string") throw new Error("Model response content must be a string");
      const rawUsage =
        record.usage && typeof record.usage === "object"
          ? (record.usage as Record<string, unknown>)
          : {};
      return {
        chunks: [content],
        finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
        usage: {
          inputTokens: numberOrZero(rawUsage.prompt_tokens),
          outputTokens: numberOrZero(rawUsage.completion_tokens),
          ...(typeof rawUsage.prompt_tokens_details === "object" &&
          rawUsage.prompt_tokens_details &&
          typeof (rawUsage.prompt_tokens_details as Record<string, unknown>).cached_tokens ===
            "number"
            ? {
                cachedInputTokens: numberOrZero(
                  (rawUsage.prompt_tokens_details as Record<string, unknown>).cached_tokens,
                ),
              }
            : {}),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
