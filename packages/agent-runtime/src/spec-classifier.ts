import type { ModelClient, ModelProfile, ModelRequest } from "./types.js";
import { parseJsonResponse } from "./spec-pipeline-helpers.js";

export interface ClassifyResult {
  needsClarification: boolean;
  confidence: number;
  reason: string;
}

const SYSTEM_PROMPT = `You are an intent classifier for a coding agent. Decide whether the user's
request is clear enough to execute directly, or needs clarification first.

Respond ONLY with a JSON object, no other text.

Classification rules:
- "execute": The request is specific enough to act on. Examples: fixing a
  named bug, running a known command, editing a specified file, answering a
  factual question.
- "clarify": The request is vague, ambiguous, or describes a goal without
  enough detail. Examples: "improve performance", "add tests", "refactor
  this", "make it better", multi-system features without scope.

Confidence scale:
- 0.9+: Very clear, almost certainly execute
- 0.7-0.9: Likely execute
- 0.5-0.7: Uncertain, lean clarify
- below 0.5: Likely clarify

Example inputs and outputs:

Input: "Fix the typo in README.md line 42"
{"needsClarification": false, "confidence": 0.95, "reason": "specific file and line"}

Input: "Add unit tests for the auth module"
{"needsClarification": true, "confidence": 0.7, "reason": "scope unclear: which functions, what coverage target"}

Input: "Why is my build failing?"
{"needsClarification": false, "confidence": 0.85, "reason": "investigation request, agent can explore"}

Input: "Make the agent runtime more robust"
{"needsClarification": true, "confidence": 0.95, "reason": "vague goal, no measurable criteria"}

Input: "Refactor spec-engine.ts to use async generators"
{"needsClarification": false, "confidence": 0.8, "reason": "specific file and technique"}

Now classify this input:`;

const MAX_INPUT_CHARS = 500;

export async function classifyIntent(
  client: ModelClient,
  profile: ModelProfile,
  prompt: string,
  projectType: string,
  signal?: AbortSignal,
): Promise<ClassifyResult> {
  if (signal?.aborted) {
    throw new Error("Classifier aborted before request");
  }

  const truncated = prompt.length > MAX_INPUT_CHARS ? prompt.slice(0, MAX_INPUT_CHARS) : prompt;

  const result = await callWithRetry(client, profile, truncated, projectType, signal);
  return result;
}

async function callWithRetry(
  client: ModelClient,
  profile: ModelProfile,
  prompt: string,
  projectType: string,
  signal?: AbortSignal,
): Promise<ClassifyResult> {
  const firstAttempt = await tryParse(client, profile, prompt, projectType, signal);
  if (firstAttempt !== null) return firstAttempt;

  // Retry with temperature 0 for deterministic output
  const retryProfile: ModelProfile = { ...profile, temperature: 0 };
  const secondAttempt = await tryParse(client, retryProfile, prompt, projectType, signal);
  if (secondAttempt !== null) return secondAttempt;

  throw new Error("Classifier failed to produce valid JSON after retry");
}

async function tryParse(
  client: ModelClient,
  profile: ModelProfile,
  prompt: string,
  projectType: string,
  signal: AbortSignal | undefined,
): Promise<ClassifyResult | null> {
  const request: ModelRequest = {
    model: profile.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Project type: ${projectType}\nInput: ${prompt}` }],
    tools: [],
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    ...(signal ? { signal } : {}),
  };
  const response = await client.complete(request);
  const parsed = parseJsonResponse<ClassifyResult>(response.content);
  if (parsed === null) return null;
  if (typeof parsed.needsClarification !== "boolean") return null;
  if (typeof parsed.confidence !== "number") return null;
  if (typeof parsed.reason !== "string") return null;
  return parsed;
}
