import type {
  AgentMessage,
  AgentTool,
  ModelClient,
  ModelProfile,
  ModelRequest,
  ModelResponse,
} from "./types.js";
import type { ExplorerResult } from "./spec-types.js";
import { emptyExplorerResult, parseJsonResponse } from "./spec-pipeline-helpers.js";

const EXPLORER_SYSTEM_PROMPT = `You are exploring a codebase to gather context for a requirement. You have
read-only tools: read, grep, glob, ls. Do NOT modify any files.

Goal: Understand the current code structure, patterns, and constraints
relevant to this request. Focus on:
1. Entry points and main modules related to the request
2. Existing patterns the new work should follow
3. Test conventions (where tests live, naming, framework)
4. Architectural constraints (boundary rules, dependency limits)

Explore efficiently: 3-6 tool calls maximum. Prioritize breadth over depth.

After exploration, summarize findings as a JSON object:
{
  "entryPoints": ["path:role", ...],
  "patterns": ["pattern:description", ...],
  "testConventions": "description",
  "constraints": ["constraint", ...],
  "relevantFiles": ["path", ...]
}

Request:`;

export interface ExploreCodebaseParams {
  prompt: string;
  cwd: string;
  modelClient: ModelClient;
  model: ModelProfile;
  readOnlyTools: AgentTool[];
  maxRounds: number;
  signal?: AbortSignal;
}

export async function exploreCodebase(params: ExploreCodebaseParams): Promise<ExplorerResult> {
  if (params.signal?.aborted) return emptyExplorerResult();

  const toolMap = new Map<string, AgentTool>();
  for (const tool of params.readOnlyTools) {
    toolMap.set(tool.definition.name, tool);
  }

  const messages: AgentMessage[] = [
    { role: "user", content: `${EXPLORER_SYSTEM_PROMPT}\n${params.prompt}` },
  ];

  for (let round = 0; round < params.maxRounds; round++) {
    if (params.signal?.aborted) return emptyExplorerResult();

    const request: ModelRequest = {
      model: params.model.model,
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
      messages: [...messages],
      tools: params.readOnlyTools.map((tool) => tool.definition),
      temperature: params.model.temperature,
      maxOutputTokens: params.model.maxOutputTokens,
      ...(params.signal ? { signal: params.signal } : {}),
    };

    let response: ModelResponse;
    try {
      response = await params.modelClient.complete(request);
    } catch {
      return emptyExplorerResult();
    }

    if (response.stopReason !== "tool_use" || response.toolCalls.length === 0) {
      // Model is done — parse final JSON from content
      const parsed = parseJsonResponse<ExplorerResult>(response.content);
      if (parsed && Array.isArray(parsed.entryPoints)) {
        return normalizeExplorerResult(parsed);
      }
      return emptyExplorerResult();
    }

    // Execute tool calls and append results to messages
    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const tool = toolMap.get(call.name);
      let resultContent: string;
      if (!tool) {
        resultContent = `Error: tool "${call.name}" not available`;
      } else {
        try {
          const result = await tool.execute(call.arguments, {
            cwd: params.cwd,
            ...(params.signal ? { signal: params.signal } : {}),
          });
          resultContent = result.content;
        } catch (error) {
          resultContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      messages.push({
        role: "tool",
        content: resultContent,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  // Exhausted rounds without a final JSON — return empty
  return emptyExplorerResult();
}

function normalizeExplorerResult(raw: Partial<ExplorerResult>): ExplorerResult {
  return {
    entryPoints: Array.isArray(raw.entryPoints) ? raw.entryPoints.map(String) : [],
    patterns: Array.isArray(raw.patterns) ? raw.patterns.map(String) : [],
    testConventions: typeof raw.testConventions === "string" ? raw.testConventions : "",
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String) : [],
    relevantFiles: Array.isArray(raw.relevantFiles) ? raw.relevantFiles.map(String) : [],
  };
}
