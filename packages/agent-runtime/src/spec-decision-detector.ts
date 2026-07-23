import type { ModelClient, ModelProfile, ModelRequest } from "./types.js";
import type { KeyDecisionRule, SpecDraft, SpecKeyDecision } from "./spec-types.js";
import { parseJsonResponse } from "./spec-pipeline-helpers.js";

const SYSTEM_PROMPT = `You are a decision detector. Given a specification draft, identify decisions
that should be confirmed by the user before execution begins.

Respond ONLY with a JSON array of decisions.

Detection rules (check each):
1. "destructive-change": Any task that deletes files, drops database tables,
   or removes existing functionality.
2. "arch-decision": Choice between fundamentally different approaches
   (e.g., new module vs. extend existing, REST vs. GraphQL).
3. "new-dependency": Introduction of a new npm/package dependency.
4. "breaking-change": Changes to public API, exported interfaces, or config
   schema that consumers depend on.
5. "security-sensitive": Changes to auth, permissions, crypto, or sandbox.
6. "irreversible": Operations that cannot be undone (migrations, publishes).

For each detected decision, output:
{
  "id": "d1",
  "point": "what needs to be decided",
  "options": [
    {"label": "A", "description": "...", "tradeoffs": "..."},
    {"label": "B", "description": "...", "tradeoffs": "..."}
  ],
  "severity": "critical|major|minor"
}

severity guide:
- critical: destructive, irreversible, security-sensitive
- major: arch-decision, breaking-change, new-dependency
- minor: style choices, naming, minor scope

If no decisions need confirmation, output: []

Now analyze this spec:`;

export async function detectDecisions(
  client: ModelClient,
  profile: ModelProfile,
  draft: SpecDraft,
  rules: KeyDecisionRule[],
): Promise<SpecKeyDecision[]> {
  const rulesText = rules.map((r) => `${r.name}: ${r.description}`).join("\n");
  const userMessage = `Detection rules:\n${rulesText}\n\nSpec draft:\n${JSON.stringify(draft, null, 2)}`;

  const first = await tryParse(client, profile, userMessage);
  if (first !== null) return first;

  const retryProfile: ModelProfile = { ...profile, temperature: 0 };
  const second = await tryParse(
    client,
    retryProfile,
    `${userMessage}\n\nIMPORTANT: Output must be valid JSON array, no markdown fences.`,
  );
  if (second !== null) return second;

  throw new Error("Decision detector failed to produce valid JSON after retry");
}

async function tryParse(
  client: ModelClient,
  profile: ModelProfile,
  userMessage: string,
): Promise<SpecKeyDecision[] | null> {
  const request: ModelRequest = {
    model: profile.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
  };
  const response = await client.complete(request);
  const parsed = parseJsonResponse<unknown>(response.content);
  if (parsed === null) return null;
  if (!Array.isArray(parsed)) return null;
  return parsed.map(normalizeDecision).filter((d): d is SpecKeyDecision => d !== null);
}

function normalizeDecision(item: unknown): SpecKeyDecision | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id || typeof obj.point !== "string") return null;
  const severity =
    obj.severity === "critical" || obj.severity === "major" || obj.severity === "minor"
      ? obj.severity
      : "minor";
  // Missing `options` defaults to []; a present-but-non-array `options` is malformed.
  let options: SpecKeyDecision["options"];
  if (obj.options === undefined) {
    options = [];
  } else if (Array.isArray(obj.options)) {
    options = obj.options
      .map(normalizeOption)
      .filter((o): o is SpecKeyDecision["options"][number] => o !== null);
  } else {
    return null;
  }
  return { id: obj.id, point: obj.point, options, severity };
}

function normalizeOption(
  item: unknown,
): { label: string; description: string; tradeoffs: string } | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.label !== "string" || typeof obj.description !== "string") return null;
  return {
    label: obj.label,
    description: obj.description,
    tradeoffs: typeof obj.tradeoffs === "string" ? obj.tradeoffs : "",
  };
}
