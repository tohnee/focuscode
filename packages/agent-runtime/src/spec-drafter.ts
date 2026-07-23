import { randomBytes } from "node:crypto";
import type { ModelClient, ModelProfile, ModelRequest } from "./types.js";
import type {
  ExplorerResult,
  SpecAcceptanceCriterion,
  SpecAffectedArea,
  SpecAmbiguity,
  SpecConstraint,
  SpecDraft,
  SpecTaskNode,
  SpecUnderstanding,
} from "./spec-types.js";
import { parseJsonResponse } from "./spec-pipeline-helpers.js";

const SYSTEM_PROMPT = `You are a requirements drafter for a coding agent. Given a user request and
codebase context, produce a structured specification.

Respond ONLY with a JSON object matching this schema:
{
  "topic": "5-15 word slug describing the feature",
  "understanding": {
    "goal": "1-2 sentence statement of what the user wants",
    "constraints": [
      {"source": "user|codebase|convention", "description": "...", "severity": "hard|soft"}
    ],
    "acceptanceCriteria": [
      {"description": "...", "verification": "test|lint|build|manual", "verificationTarget": "command or file"}
    ],
    "affectedAreas": [
      {"path": "relative/path", "impact": "modify|create|delete|review", "reason": "..."}
    ],
    "ambiguities": [
      {"description": "what is unclear", "resolvedBy": "auto|user", "resolution": "best guess or empty"}
    ]
  },
  "taskBreakdown": [
    {"id": "t1", "description": "...", "dependsOn": [], "files": ["path"], "kind": "design|implement|test|refactor|doc"}
  ]
}

Rules:
- Constraints from codebase context must have source "codebase"
- Project conventions (from AGENTS.md, CONTRIBUTING.md) have source "convention"
- Mark ambiguities you can reasonably infer as resolvedBy "auto" with your best guess
- Mark ambiguities requiring user input as resolvedBy "user" with empty resolution
- Task breakdown should be 3-8 tasks, ordered by dependency
- Keep descriptions concise (1 sentence each)

Now draft a spec for:`;

export interface DraftSpecParams {
  prompt: string;
  explorerResult: ExplorerResult;
  instructionsSummary: string;
}

export async function draftSpec(
  client: ModelClient,
  profile: ModelProfile,
  params: DraftSpecParams,
): Promise<SpecDraft> {
  const userMessage = buildUserMessage(params);
  const first = await tryParse(client, profile, userMessage);
  if (first) return first;

  // Retry with stricter instruction
  const retryMessage = `${userMessage}\n\nIMPORTANT: Output must be valid JSON, no markdown fences.`;
  const retryProfile: ModelProfile = { ...profile, temperature: 0 };
  const second = await tryParse(client, retryProfile, retryMessage);
  if (second) return second;

  throw new Error("Drafter failed to produce valid JSON after retry");
}

function buildUserMessage(params: DraftSpecParams): string {
  const lines = [
    `User request: ${params.prompt}`,
    "",
    "Codebase context:",
    JSON.stringify(params.explorerResult, null, 2),
  ];
  if (params.instructionsSummary) {
    lines.push("", "Project conventions (from AGENTS.md):", params.instructionsSummary);
  }
  return lines.join("\n");
}

async function tryParse(
  client: ModelClient,
  profile: ModelProfile,
  userMessage: string,
): Promise<SpecDraft | null> {
  const request: ModelRequest = {
    model: profile.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
  };
  const response = await client.complete(request);
  const parsed = parseJsonResponse<Partial<SpecDraft>>(response.content);
  if (!parsed) return null;
  return normalizeDraft(parsed);
}

function normalizeDraft(raw: Partial<SpecDraft>): SpecDraft | null {
  if (
    typeof raw.topic !== "string" ||
    typeof raw.understanding !== "object" ||
    raw.understanding === null
  ) {
    return null;
  }
  const u = raw.understanding as Partial<SpecUnderstanding>;
  if (typeof u.goal !== "string") return null;

  return {
    id: generateSpecId(),
    topic: raw.topic,
    understanding: {
      goal: u.goal,
      constraints: normalizeArray(u.constraints, normalizeConstraint),
      acceptanceCriteria: normalizeArray(u.acceptanceCriteria, normalizeAcceptance),
      affectedAreas: normalizeArray(u.affectedAreas, normalizeAffectedArea),
      ambiguities: normalizeArray(u.ambiguities, normalizeAmbiguity),
    },
    taskBreakdown: normalizeArray(raw.taskBreakdown, normalizeTask),
    keyDecisions: [],
  };
}

function normalizeArray<T>(raw: unknown, normalizer: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizer).filter((x): x is T => x !== null);
}

function normalizeConstraint(item: unknown): SpecConstraint | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.description !== "string") return null;
  const source =
    obj.source === "user" || obj.source === "codebase" || obj.source === "convention"
      ? obj.source
      : "codebase";
  const severity = obj.severity === "hard" || obj.severity === "soft" ? obj.severity : "soft";
  return { source, description: obj.description, severity };
}

function normalizeAcceptance(item: unknown): SpecAcceptanceCriterion | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.description !== "string") return null;
  const verification = ["test", "lint", "build", "manual"].includes(obj.verification as string)
    ? (obj.verification as SpecAcceptanceCriterion["verification"])
    : "manual";
  return {
    description: obj.description,
    verification,
    ...(typeof obj.verificationTarget === "string"
      ? { verificationTarget: obj.verificationTarget }
      : {}),
  };
}

function normalizeAffectedArea(item: unknown): SpecAffectedArea | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.reason !== "string") return null;
  const impact = ["modify", "create", "delete", "review"].includes(obj.impact as string)
    ? (obj.impact as SpecAffectedArea["impact"])
    : "review";
  return { path: obj.path, impact, reason: obj.reason };
}

function normalizeAmbiguity(item: unknown): SpecAmbiguity | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.description !== "string") return null;
  const resolvedBy =
    obj.resolvedBy === "auto" || obj.resolvedBy === "user" ? obj.resolvedBy : "auto";
  return {
    description: obj.description,
    resolvedBy,
    resolution: typeof obj.resolution === "string" ? obj.resolution : "",
  };
}

function normalizeTask(item: unknown): SpecTaskNode | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.description !== "string") return null;
  const kind = ["design", "implement", "test", "refactor", "doc"].includes(obj.kind as string)
    ? (obj.kind as SpecTaskNode["kind"])
    : "implement";
  return {
    id: obj.id,
    description: obj.description,
    dependsOn: Array.isArray(obj.dependsOn) ? obj.dependsOn.map(String) : [],
    files: Array.isArray(obj.files) ? obj.files.map(String) : [],
    kind,
  };
}

function generateSpecId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = randomBytes(3).toString("hex");
  return `spec_${timestamp}_${random}`;
}
