import { describe, expect, it } from "vitest";
import { listProviderPresets } from "@focuscode/agent-runtime";
import { parseAgentArgs } from "../src/agent-args.js";
import { printModels } from "../src/agent-command.js";

// Capture process.stdout.write into a string buffer so we can assert on the
// human-readable output that printModels emits without spawning the CLI.
// We replace write directly (instead of vi.spyOn) because the WriteStream
// overloads confuse mockImplementation's parameter inference.
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") chunks.push(chunk);
    else chunks.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("parseAgentArgs: --list-models and --cost flags", () => {
  it("parses --list-models as a boolean flag", () => {
    const args = parseAgentArgs(["--list-models"]);
    expect(args.listModels).toBe(true);
    expect(args.listProviders).toBe(false);
  });

  it("parses --cost as a boolean flag", () => {
    const args = parseAgentArgs(["--cost"]);
    expect(args.cost).toBe(true);
  });

  it("defaults listModels and cost to false when absent", () => {
    const args = parseAgentArgs(["hello"]);
    expect(args.listModels).toBe(false);
    expect(args.cost).toBe(false);
  });

  it("rejects --list-models=value form", () => {
    expect(() => parseAgentArgs(["--list-models=yes"])).toThrow(/does not accept a value/);
  });

  it("rejects --cost=value form", () => {
    expect(() => parseAgentArgs(["--cost=1"])).toThrow(/does not accept a value/);
  });
});

describe("printModels output format", () => {
  const output = captureStdout(() => printModels());

  it("groups presets under a `# <provider>` header per provider", () => {
    const presets = listProviderPresets();
    const providerIds = new Set(presets.map((preset) => preset.id));
    for (const id of providerIds) {
      expect(output).toContain(`# ${id}\n`);
    }
  });

  it("emits one row per preset with all four annotations", () => {
    const presets = listProviderPresets();
    // Every row must contain provider/model, context, maxOutput, toolMode,
    // and reasoning in the documented tab-separated shape.
    for (const preset of presets) {
      const model = preset.defaultModel ?? "(user-supplied model id)";
      const row = `${preset.id}/${model}\tcontext=${preset.defaultContextWindow}\tmaxOutput=${preset.defaultMaxOutputTokens}\ttoolMode=auto\treasoning=${preset.defaultReasoningEffort ?? "off"}\n`;
      expect(output).toContain(row);
    }
  });

  it("always reports toolMode=auto (harness default before ModelProfile resolution)", () => {
    // Every non-header line must contain toolMode=auto.
    const lines = output.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain("toolMode=auto");
    }
  });

  it("reports `off` when a preset has no defaultReasoningEffort", () => {
    const presets = listProviderPresets();
    const noReasoning = presets.find((preset) => preset.defaultReasoningEffort === undefined);
    if (!noReasoning) return; // skip if every preset pins reasoning
    const model = noReasoning.defaultModel ?? "(user-supplied model id)";
    expect(output).toContain(
      `${noReasoning.id}/${model}\tcontext=${noReasoning.defaultContextWindow}\tmaxOutput=${noReasoning.defaultMaxOutputTokens}\ttoolMode=auto\treasoning=off\n`,
    );
  });

  it("emits the built-in openai preset with its documented context window", () => {
    // OpenAI is the canonical first preset; pinning its row guards against
    // accidental drift in the default context/maxOutput values.
    expect(output).toContain(
      `# openai\nopenai/(user-supplied model id)\tcontext=128000\tmaxOutput=16384\ttoolMode=auto\treasoning=off\n`,
    );
  });

  it("emits the deepseek preset with reasoning=high", () => {
    expect(output).toContain("deepseek/deepseek-v4-pro\t");
    expect(output).toContain("\treasoning=high\n");
  });

  it("includes a row for every preset exactly once", () => {
    // Count non-header lines and compare against the preset count.
    const dataLines = output.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(dataLines.length).toBe(listProviderPresets().length);
  });
});
