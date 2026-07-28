import type { ModelClient, ModelResponse } from "./types.js";
import type { ExplorerResult, SpecDraft, SpecKeyDecision } from "./spec-types.js";

/**
 * Parse a model response as JSON, tolerating markdown code fences.
 * Returns null on parse failure (caller decides retry/fallback).
 */
export function parseJsonResponse<T = unknown>(raw: string): T | null {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  const candidate = fenceMatch ? fenceMatch[1]! : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    console.warn(
      `parseJsonResponse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function emptyExplorerResult(): ExplorerResult {
  return {
    entryPoints: [],
    patterns: [],
    testConventions: "",
    constraints: [],
    relevantFiles: [],
  };
}

/**
 * Manual fallback prompt builder used when the enhancer stage fails.
 * Concatenates spec goal + constraints + acceptance criteria + tasks
 * into a self-contained prompt. Format matches the enhancer's expected
 * output format so the downstream tool loop is unaffected.
 */
export function fallbackEnhance(draft: SpecDraft, decisions: SpecKeyDecision[]): string {
  const lines: string[] = [];
  lines.push("## Objective");
  lines.push(draft.understanding.goal);
  lines.push("");

  if (draft.understanding.constraints.length > 0) {
    lines.push("## Constraints");
    for (const c of draft.understanding.constraints) {
      lines.push(`- [${c.severity}|${c.source}] ${c.description}`);
    }
    lines.push("");
  }

  if (draft.understanding.acceptanceCriteria.length > 0) {
    lines.push("## Acceptance Criteria");
    for (const ac of draft.understanding.acceptanceCriteria) {
      lines.push(`- [${ac.verification}] ${ac.description}`);
    }
    lines.push("");
  }

  if (draft.understanding.affectedAreas.length > 0) {
    lines.push("## Files");
    for (const area of draft.understanding.affectedAreas) {
      lines.push(`- ${area.path}: ${area.reason} (${area.impact})`);
    }
    lines.push("");
  }

  if (draft.taskBreakdown.length > 0) {
    lines.push("## Execution Order");
    for (const task of draft.taskBreakdown) {
      const deps = task.dependsOn.length > 0 ? ` (after ${task.dependsOn.join(", ")})` : "";
      lines.push(`${task.id}: ${task.description}${deps}`);
    }
    lines.push("");
  }

  if (decisions.length > 0) {
    lines.push("## Confirmed Decisions");
    for (const d of decisions) {
      if (d.chosen) {
        lines.push(`- ${d.point}: ${d.chosen}`);
      }
    }
  }

  lines.push(
    "Begin working on the tasks above. Verify each acceptance criterion before claiming completion.",
  );
  return lines.join("\n");
}

// === Test utilities (exported for test files) ===

export function mockClient(response: string): ModelClient {
  return {
    protocol: "openai-chat",
    async complete(): Promise<ModelResponse> {
      return {
        content: response,
        stopReason: "stop",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}

export function mockClientSequence(responses: string[]): ModelClient {
  let i = 0;
  return {
    protocol: "openai-chat",
    async complete(): Promise<ModelResponse> {
      if (responses.length === 0) {
        throw new Error("mockClientSequence: response array is empty — no responses to return");
      }
      const idx = Math.min(i, responses.length - 1);
      i += 1;
      return {
        content: responses[idx]!,
        stopReason: "stop",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}
