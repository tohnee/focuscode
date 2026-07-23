import { describe, expect, it } from "vitest";
import * as agentRuntime from "../src/index.js";

describe("spec-engine exports", () => {
  it("exports SpecEngine class", () => {
    expect(agentRuntime.SpecEngine).toBeDefined();
    expect(typeof agentRuntime.SpecEngine).toBe("function");
  });

  it("exports SpecStoreImpl class", () => {
    expect(agentRuntime.SpecStoreImpl).toBeDefined();
  });

  it("exports stage functions", () => {
    expect(typeof agentRuntime.classifyIntent).toBe("function");
    expect(typeof agentRuntime.exploreCodebase).toBe("function");
    expect(typeof agentRuntime.draftSpec).toBe("function");
    expect(typeof agentRuntime.detectDecisions).toBe("function");
    expect(typeof agentRuntime.enhancePrompt).toBe("function");
  });

  it("exports helper functions", () => {
    expect(typeof agentRuntime.parseJsonResponse).toBe("function");
    expect(typeof agentRuntime.emptyExplorerResult).toBe("function");
    expect(typeof agentRuntime.fallbackEnhance).toBe("function");
  });

  it("mockClient and mockClientSequence are not exported from public API (M16)", () => {
    expect("mockClient" in agentRuntime).toBe(false);
    expect("mockClientSequence" in agentRuntime).toBe(false);
    expect("parseJsonResponse" in agentRuntime).toBe(true);
    expect("emptyExplorerResult" in agentRuntime).toBe(true);
    expect("fallbackEnhance" in agentRuntime).toBe(true);
  });
});
