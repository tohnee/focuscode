import type { AgentMessage, AgentToolCall, ModelProfile, TokenUsage } from "./types.js";
import {
  activeBranch,
  type SessionCompactionStructured,
  type SessionEntry,
  type SessionSnapshot,
} from "./session-store.js";

export interface CompiledConversation {
  messages: AgentMessage[];
  summary?: string;
  estimatedTokens: number;
  shouldCompact: boolean;
  compactableEntries: SessionEntry[];
}

export class ConversationContext {
  constructor(private readonly model: ModelProfile) {}

  compile(snapshot: SessionSnapshot, toolsSchemaChars = 0): CompiledConversation {
    const branch = activeBranch(snapshot);
    let selected = branch;
    let summary = snapshot.compaction?.summary;
    if (snapshot.compaction) {
      const index = branch.findIndex((entry) => entry.entryId === snapshot.compaction?.upToEntryId);
      if (index >= 0) selected = branch.slice(index + 1);
      else summary = undefined;
    }
    const messages = selected.map((entry) => entry.message);
    const estimatedTokens =
      estimateMessages(messages) +
      Math.ceil(toolsSchemaChars / 4) +
      Math.ceil((summary?.length ?? 0) / 4);
    const usable = Math.max(1_000, this.model.contextWindow - this.model.maxOutputTokens);
    const shouldCompact = estimatedTokens > usable * 0.82 && branch.length > 6;
    const keepBudget = Math.max(2_000, Math.floor(usable * 0.45));
    let keptTokens = 0;
    let split = branch.length;
    while (split > 0 && keptTokens < keepBudget) {
      split -= 1;
      keptTokens += estimateMessage(branch[split]!.message);
    }
    split = adjustSplitForToolPairs(branch, split);
    return {
      messages,
      ...(summary ? { summary } : {}),
      estimatedTokens,
      shouldCompact,
      compactableEntries: branch.slice(0, Math.max(0, split)),
    };
  }

  summarize(
    entries: SessionEntry[],
    previousSummary?: string,
    structured?: SessionCompactionStructured,
  ): string {
    const lines: string[] = [];
    const structuredSections = renderStructuredSummary(
      structured ?? summarizeEntriesStructured(entries),
    );
    if (structuredSections) lines.push(structuredSections);
    if (previousSummary) lines.push(`Previous summary:\n${previousSummary.slice(0, 8_000)}`);
    const userRequests: string[] = [];
    const assistantOutcomes: string[] = [];
    const toolFacts: string[] = [];
    for (const entry of entries) {
      const content = entry.message.content.replace(/\s+/g, " ").trim();
      if (!content) continue;
      if (entry.message.role === "user") userRequests.push(content.slice(0, 600));
      if (entry.message.role === "assistant") assistantOutcomes.push(content.slice(0, 800));
      if (entry.message.role === "tool") {
        toolFacts.push(`${entry.message.toolName ?? "tool"}: ${content.slice(0, 500)}`);
      }
    }
    if (userRequests.length) lines.push(`User goals:\n${bullet(last(userRequests, 12))}`);
    if (assistantOutcomes.length) {
      lines.push(`Agent conclusions and progress:\n${bullet(last(assistantOutcomes, 12))}`);
    }
    if (toolFacts.length) lines.push(`Observed tool facts:\n${bullet(last(toolFacts, 20))}`);
    return lines.join("\n\n").slice(0, 24_000);
  }
}

const READ_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit", "apply_patch"]);
const DECISION_PREFIX = /^(我决定|我将|我选择|选择|改用|决定)/;
const APPROVAL_MARKER =
  /(待批准|待审批|待确认|请确认|需要确认|pending approval|awaiting approval)/i;

const STRUCTURED_FILE_LIMIT = 50;
const STRUCTURED_COMMAND_LIMIT = 50;
const STRUCTURED_DECISION_LIMIT = 20;
const STRUCTURED_ITEM_TEXT_LIMIT = 200;
const STRUCTURED_COMMAND_TEXT_LIMIT = 120;

/**
 * Non-destructive structured projection over the entries covered by a
 * compaction: the original session entries stay untouched, and the extracted
 * facts are merged with the prior compaction's structured summary (union,
 * deduplicated, bounded) so key engineering context survives repeated
 * compactions even after the raw text summary is truncated.
 */
export function summarizeEntriesStructured(
  entries: SessionEntry[],
  prior?: SessionCompactionStructured,
): SessionCompactionStructured {
  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  const commandsRun: string[] = [];
  const keyDecisions: string[] = [];
  const pendingApprovals: string[] = [];
  const openQuestions: string[] = [];
  for (const entry of entries) {
    const message = entry.message;
    for (const call of message.toolCalls ?? []) {
      const path = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
      if (path) {
        if (READ_TOOL_NAMES.has(call.name)) filesRead.add(path);
        if (WRITE_TOOL_NAMES.has(call.name)) filesChanged.add(path);
      }
      if (call.name === "bash" && typeof call.arguments.command === "string") {
        pushUniqueBounded(
          commandsRun,
          call.arguments.command.slice(0, STRUCTURED_COMMAND_TEXT_LIMIT),
          STRUCTURED_COMMAND_LIMIT,
        );
      }
    }
    if (message.role !== "assistant" && message.role !== "user") continue;
    for (const sentence of splitSentences(message.content)) {
      if (message.role === "assistant" && DECISION_PREFIX.test(sentence)) {
        pushUniqueBounded(
          keyDecisions,
          sentence.slice(0, STRUCTURED_ITEM_TEXT_LIMIT),
          STRUCTURED_DECISION_LIMIT,
        );
      }
      if (APPROVAL_MARKER.test(sentence)) {
        pushUniqueBounded(
          pendingApprovals,
          sentence.slice(0, STRUCTURED_ITEM_TEXT_LIMIT),
          STRUCTURED_DECISION_LIMIT,
        );
      }
      if (/[?？]$/.test(sentence)) {
        pushUniqueBounded(
          openQuestions,
          sentence.slice(0, STRUCTURED_ITEM_TEXT_LIMIT),
          STRUCTURED_DECISION_LIMIT,
        );
      }
    }
  }
  return {
    schemaVersion: "focuscode-compaction.v1",
    filesRead: mergeSorted(prior?.filesRead, filesRead, STRUCTURED_FILE_LIMIT),
    filesChanged: mergeSorted(prior?.filesChanged, filesChanged, STRUCTURED_FILE_LIMIT),
    commandsRun: mergeOrdered(prior?.commandsRun, commandsRun, STRUCTURED_COMMAND_LIMIT),
    keyDecisions: mergeOrdered(prior?.keyDecisions, keyDecisions, STRUCTURED_DECISION_LIMIT),
    pendingApprovals: mergeOrdered(
      prior?.pendingApprovals,
      pendingApprovals,
      STRUCTURED_DECISION_LIMIT,
    ),
    openQuestions: mergeOrdered(prior?.openQuestions, openQuestions, STRUCTURED_DECISION_LIMIT),
  };
}

function renderStructuredSummary(structured: SessionCompactionStructured): string | undefined {
  const sections: string[] = [];
  if (structured.filesChanged.length) {
    sections.push(`## Files changed\n${bullet(structured.filesChanged)}`);
  }
  if (structured.filesRead.length) sections.push(`## Files read\n${bullet(structured.filesRead)}`);
  if (structured.commandsRun.length) {
    sections.push(`## Commands run\n${bullet(structured.commandsRun)}`);
  }
  if (structured.keyDecisions.length) {
    sections.push(`## Key decisions\n${bullet(structured.keyDecisions)}`);
  }
  if (structured.pendingApprovals.length) {
    sections.push(`## Pending approvals\n${bullet(structured.pendingApprovals)}`);
  }
  if (structured.openQuestions.length) {
    sections.push(`## Open questions\n${bullet(structured.openQuestions)}`);
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[。！？.!?\n])/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function pushUniqueBounded(values: string[], value: string, limit: number): void {
  if (!value || values.includes(value) || values.length >= limit) return;
  values.push(value);
}

function mergeSorted(prior: string[] | undefined, current: Set<string>, limit: number): string[] {
  return [...new Set([...(prior ?? []), ...current])].sort().slice(0, limit);
}

function mergeOrdered(prior: string[] | undefined, current: string[], limit: number): string[] {
  return [...new Set([...(prior ?? []), ...current])].slice(-limit);
}

export function extractPromptToolCalls(content: string): AgentToolCall[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of content.matchAll(fenced)) candidates.push(match[1]!.trim());
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  for (const candidate of candidates.reverse()) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const rawCalls = record.tool_calls ?? record.toolCalls ?? record.actions;
      if (!Array.isArray(rawCalls)) continue;
      const calls: AgentToolCall[] = [];
      for (const [index, raw] of rawCalls.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const call = raw as Record<string, unknown>;
        const name = call.name ?? call.tool;
        const argumentsValue = call.arguments ?? call.input ?? {};
        if (
          typeof name !== "string" ||
          !argumentsValue ||
          typeof argumentsValue !== "object" ||
          Array.isArray(argumentsValue)
        )
          continue;
        calls.push({
          id: typeof call.id === "string" ? call.id : `prompt_call_${index}`,
          name,
          arguments: argumentsValue as Record<string, unknown>,
          rawArguments: JSON.stringify(argumentsValue),
        });
      }
      if (calls.length > 0) return calls;
    } catch {
      // Non-JSON code fences are ordinary assistant content.
    }
  }
  return [];
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const cached = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function estimateMessages(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessage(message), 0);
}

function estimateMessage(message: AgentMessage): number {
  return (
    8 +
    Math.ceil(message.content.length / 4) +
    (message.attachments ?? []).reduce(
      (sum, attachment) =>
        sum + (attachment.sizeBytes > 0 ? Math.ceil(attachment.sizeBytes / 750) : 1_000),
      0,
    ) +
    (message.toolCalls ?? []).reduce(
      (sum, call) => sum + Math.ceil(JSON.stringify(call.arguments).length / 4) + 12,
      0,
    ) +
    Math.ceil(
      ((message.providerState?.reasoningContent?.length ?? 0) +
        (message.providerState?.thinkingBlocks ?? []).reduce(
          (sum, block) =>
            sum +
            (block.type === "thinking"
              ? block.thinking.length + (block.signature?.length ?? 0)
              : block.data.length),
          0,
        )) /
        4,
    )
  );
}

function adjustSplitForToolPairs(branch: SessionEntry[], split: number): number {
  if (split <= 0 || split >= branch.length) return split;
  while (split > 0 && branch[split]?.message.role === "tool") split -= 1;
  return split;
}

function last<T>(values: T[], count: number): T[] {
  return values.slice(-count);
}

function bullet(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}
