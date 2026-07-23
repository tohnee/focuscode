import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HumanEventRenderer, terminalSafe } from "../src/agent-output.js";

describe("terminal-safe human output", () => {
  it("removes model-controlled terminal escape characters", () => {
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let rendered = "";
    let errors = "";
    output.on("data", (chunk) => (rendered += chunk.toString("utf8")));
    diagnostics.on("data", (chunk) => (errors += chunk.toString("utf8")));
    const renderer = new HumanEventRenderer({ output, diagnostics, color: false });
    renderer.handle({ type: "text_delta", delta: "safe\u001b[2Jtext" });
    renderer.handle({ type: "error", message: "bad\u009b31merror" });
    expect(rendered).toBe("safetext\n");
    expect(errors).toContain("bad31merror");
    expect(rendered + errors).not.toContain("\u001b");
    expect(terminalSafe("a\u0000b")).toBe("ab");
  });
});
