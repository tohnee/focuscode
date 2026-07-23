import type { ModelClient, ModelProfile, ModelRequest } from "./types.js";
import type { SpecDraft, SpecKeyDecision } from "./spec-types.js";

const SYSTEM_PROMPT = `You are a prompt enhancer. Transform a confirmed specification into an
executable prompt for a coding agent.

The enhanced prompt must:
1. Start with a clear objective statement
2. List concrete constraints (not goals)
3. Specify acceptance criteria as checkable conditions
4. Reference affected files with their paths
5. Suggest execution order based on task dependencies
6. Be self-contained (the agent should not need to re-clarify)
7. Include confirmed decisions as a dedicated section when decisions have a chosen value

Do NOT include:
- The specification JSON itself
- Meta-commentary about the clarification process
- Instructions to ask the user questions (decisions are already confirmed)

Format:
## Objective
<1-2 sentences>

## Constraints
- <constraint 1>
- <constraint 2>

## Acceptance Criteria
- [ ] <criterion 1>
- [ ] <criterion 2>

## Files
- <path>: <what to do>

## Execution Order
1. <task 1>
2. <task 2> (after 1)

## Confirmed Decisions
- <decision point>: <chosen option>
- <decision point>: <chosen option>

Begin working on the tasks above. Verify each acceptance criterion before
claiming completion.`;

export interface EnhancePromptParams {
  draft: SpecDraft;
  confirmedDecisions: SpecKeyDecision[];
}

export async function enhancePrompt(
  client: ModelClient,
  profile: ModelProfile,
  params: EnhancePromptParams,
): Promise<string> {
  const userMessage = buildUserMessage(params);
  const request: ModelRequest = {
    model: profile.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
  };
  const response = await client.complete(request);
  const content = response.content.trim();
  if (!content) {
    throw new Error("Enhancer returned empty content");
  }
  return content;
}

function buildUserMessage(params: EnhancePromptParams): string {
  const lines: string[] = ["Confirmed specification:", JSON.stringify(params.draft, null, 2)];
  if (params.confirmedDecisions.length > 0) {
    lines.push("", "User's confirmed decisions:");
    for (const d of params.confirmedDecisions) {
      const chosen = d.chosen ?? d.options[0]?.label ?? "(none)";
      lines.push(`- ${d.point}: chosen: ${chosen}`);
    }
  }
  return lines.join("\n");
}
