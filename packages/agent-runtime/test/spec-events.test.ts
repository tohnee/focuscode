import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/types.js";

describe("AgentEvent spec_* variants", () => {
  it("supports spec_start event", () => {
    const event: AgentEvent = { type: "spec_start", input: "test", trigger: "auto" };
    expect(event.type).toBe("spec_start");
  });

  it("supports spec_stage event", () => {
    const event: AgentEvent = {
      type: "spec_stage",
      stage: "classify",
      model: "test",
      durationMs: 100,
      fellBack: false,
    };
    expect(event.type).toBe("spec_stage");
  });

  it("supports spec_draft_ready event", () => {
    const event: AgentEvent = {
      type: "spec_draft_ready",
      specId: "spec_1",
      topic: "test",
      understanding: {},
    };
    expect(event.type).toBe("spec_draft_ready");
  });

  it("supports spec_confirmation_required event", () => {
    const event: AgentEvent = {
      type: "spec_confirmation_required",
      specId: "spec_1",
      decisions: [],
    };
    expect(event.type).toBe("spec_confirmation_required");
  });

  it("supports spec_confirmed event", () => {
    const event: AgentEvent = { type: "spec_confirmed", specId: "spec_1", decisions: [] };
    expect(event.type).toBe("spec_confirmed");
  });

  it("supports spec_skipped event", () => {
    const event: AgentEvent = { type: "spec_skipped", reason: "test" };
    expect(event.type).toBe("spec_skipped");
  });

  it("supports spec_completed event", () => {
    const event: AgentEvent = { type: "spec_completed", specId: "spec_1", enhancedPrompt: "test" };
    expect(event.type).toBe("spec_completed");
  });

  it("preserves existing event types", () => {
    const events: AgentEvent[] = [
      { type: "agent_start", sessionId: "s1", turn: 1 },
      { type: "error", message: "test" },
    ];
    expect(events).toHaveLength(2);
  });
});
