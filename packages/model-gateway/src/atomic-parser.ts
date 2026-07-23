import {
  ModelDecisionSchema,
  assertSchema,
  type AtomicDecisionResultV1,
  type ModelPackV1,
  type UsageRecordV1,
} from "@focuscode/contracts";

export interface AtomicParserInput {
  chunks: string[];
  finishReason: string | null;
  usage?: Partial<UsageRecordV1>;
}

function usage(value: Partial<UsageRecordV1> | undefined): UsageRecordV1 {
  return {
    inputTokens: value?.inputTokens ?? 0,
    outputTokens: value?.outputTokens ?? 0,
    ...(value?.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: value.cachedInputTokens }),
    ...(value?.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: value.estimatedCostUsd }),
  };
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export class AtomicDecisionParser {
  constructor(private readonly pack: ModelPackV1) {}

  parse(input: AtomicParserInput): AtomicDecisionResultV1 {
    const recordedUsage = usage(input.usage);
    const finishReason = input.finishReason?.toLowerCase() ?? "unknown";
    if (["length", "max_tokens", "incomplete"].includes(finishReason)) {
      return {
        status: "truncated",
        usage: recordedUsage,
        parserDiagnostics: [
          { code: "finish_reason.truncated", message: `Provider finish reason: ${finishReason}` },
        ],
      };
    }
    if (["error", "content_filter"].includes(finishReason)) {
      return {
        status: "provider_error",
        usage: recordedUsage,
        parserDiagnostics: [
          {
            code: "finish_reason.provider_error",
            message: `Provider finish reason: ${finishReason}`,
          },
        ],
      };
    }
    const completeText = input.chunks.join("");
    const candidates = [stripSingleJsonFence(completeText)];
    if (this.pack.recovery.deterministicRepair) {
      const extracted = extractBalancedObject(completeText);
      if (extracted && extracted !== candidates[0]) candidates.push(extracted);
    }
    const diagnostics: Array<{ code: string; message: string }> = [];
    for (const [index, candidate] of candidates.entries()) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        assertSchema(ModelDecisionSchema, parsed, "model decision");
        if (
          parsed.kind === "tool_intent" &&
          parsed.intents.length > this.pack.maxToolIntentsPerTurn
        ) {
          throw new Error(
            `Pack allows ${this.pack.maxToolIntentsPerTurn} tool intents per turn, received ${parsed.intents.length}`,
          );
        }
        return {
          status: "complete",
          decision: parsed,
          usage: recordedUsage,
          parserDiagnostics: diagnostics,
        };
      } catch (error) {
        diagnostics.push({
          code: index === 0 ? "parse.primary_failed" : "parse.repair_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { status: "invalid", usage: recordedUsage, parserDiagnostics: diagnostics };
  }
}
