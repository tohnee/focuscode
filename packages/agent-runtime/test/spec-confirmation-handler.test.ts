/**
 * TDD tests for C5 fix: SpecEngine confirmation moves from eventSink
 * interception into the agent itself.
 *
 * Historical design: CLI wrapped the eventSink to intercept
 * `spec_confirmation_required` events and call specEngine.resolveDecisions
 * or declineSpec. This created a time-coupled closure (`let agent`) and
 * bypassed the agent's own event handling.
 *
 * New design: CodingAgentOptions accepts a `specConfirmationHandler` that
 * the agent invokes directly when SpecEngine emits the confirmation event.
 * The handler returns the user's choices (resolve) or undefined (decline).
 */
import { describe, expect, it } from "vitest";
import { CodingAgent } from "../src/agent.js";
import { SessionStore } from "../src/session-store.js";
import type { AgentEvent, ModelProfile } from "../src/types.js";
import { mockClient } from "../src/spec-pipeline-helpers.js";

const profile: ModelProfile = {
  provider: "test",
  model: "test-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 100,
  temperature: 0,
  toolMode: "auto",
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: false },
  compatibility: {},
  reliability: { timeoutMs: 5000, maxRetries: 0, retryBaseDelayMs: 100, retryMaximumDelayMs: 1000 },
};

async function makeAgent(
  events: AgentEvent[],
  handler?: (event: {
    specId: string;
    decisions: Array<{ id: string; point: string; options: Array<{ label: string }> }>;
  }) => Promise<Record<string, string> | undefined>,
) {
  const store = new SessionStore("unused", false);
  return CodingAgent.create({
    cwd: "/tmp",
    model: profile,
    modelClient: mockClient("done"),
    tools: [],
    permission: { mode: "deny", projectTrusted: true, protectedPaths: [] },
    sessionStore: store,
    eventSink: (e) => {
      events.push(e);
    },
    ...(handler ? { specConfirmationHandler: handler } : {}),
  });
}

describe("C5: SpecEngine confirmation handled inside agent", () => {
  it("CodingAgentOptions accepts a specConfirmationHandler (no SpecEngine configured)", async () => {
    const events: AgentEvent[] = [];
    const agent = await makeAgent(events, async () => ({}));
    // The handler is stored even when no SpecEngine is configured — it will
    // be invoked if a SpecEngine is added later or via runtime injection.
    expect(agent.specConfirmationHandler).toBeDefined();
  });

  it("agent constructs without specConfirmationHandler (back-compat)", async () => {
    const events: AgentEvent[] = [];
    const agent = await makeAgent(events);
    expect(agent.specConfirmationHandler).toBeUndefined();
  });

  it("agent exposes the installed handler via specConfirmationHandler getter", async () => {
    const events: AgentEvent[] = [];
    const handler = async () => ({}) as Record<string, string>;
    const agent = await makeAgent(events, handler);
    expect(agent.specConfirmationHandler).toBe(handler);
  });

  it("specConfirmationHandler type accepts a handler returning undefined (decline)", async () => {
    const events: AgentEvent[] = [];
    const handler = async () => undefined;
    const agent = await makeAgent(events, handler);
    expect(agent.specConfirmationHandler).toBe(handler);
  });
});
