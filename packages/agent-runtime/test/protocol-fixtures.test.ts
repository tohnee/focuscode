import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { consumeAnthropicStream, consumeOpenAIStream, type ModelResponse } from "../src/index.js";

// Replays the hand-written, desensitized protocol fixtures under
// evals/protocol/. Every fixture is a JSON array of SSE data payloads; the
// parse result must match the expectation table below and must be identical
// for any chunk boundary (fast-check), mirroring the differential SSE tests
// in model-clients.test.ts.

type Protocol = "openai" | "anthropic";

const FAMILIES: Record<string, { protocol: Protocol; cases: string[] }> = {
  kimi: {
    protocol: "openai",
    cases: ["text", "reasoning", "tool", "usage", "image", "abort", "overflow"],
  },
  qwen: { protocol: "openai", cases: ["text", "reasoning", "tool", "usage", "abort", "overflow"] },
  glm: { protocol: "openai", cases: ["text", "reasoning", "tool", "usage", "abort", "overflow"] },
  deepseek: {
    protocol: "openai",
    cases: ["text", "reasoning", "tool", "usage", "abort", "overflow"],
  },
  minimax: {
    protocol: "anthropic",
    cases: ["text", "reasoning", "tool", "usage", "image", "abort", "overflow"],
  },
};

const EXPECTED: Record<string, Record<string, Record<string, unknown>>> = {
  kimi: {
    text: {
      content: "The repository uses a layered harness design.",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 128, outputTokens: 9 },
      systemFingerprint: "fp_kimi_k3_2026_06",
    },
    reasoning: {
      content: "Fixed the parser.",
      reasoning: "First, inspect the entry point. Then patch the parser.",
      stopReason: "stop",
      usage: { inputTokens: 210, outputTokens: 24 },
      systemFingerprint: "fp_kimi_k3_2026_06",
    },
    tool: {
      content: "",
      stopReason: "tool_use",
      toolCalls: [{ id: "call_kimi_fixture_1", name: "read", arguments: { path: "src/index.ts" } }],
      usage: { inputTokens: 156, outputTokens: 14 },
    },
    usage: {
      content: "Done.",
      stopReason: "stop",
      usage: { inputTokens: 512, outputTokens: 4, cachedInputTokens: 256 },
    },
    image: {
      content: "The diagram shows two execution paths: a session agent and an audit kernel.",
      stopReason: "stop",
      usage: { inputTokens: 1024, outputTokens: 16 },
    },
    abort: {
      content: "This answer is cut off mid-sentence",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    overflow: {
      content: "A very long answer that exceeds the output budget and therefore stops early",
      stopReason: "length",
      usage: { inputTokens: 300, outputTokens: 131_072 },
    },
  },
  qwen: {
    text: {
      content: "Run the tests with pnpm test.",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 96, outputTokens: 7 },
    },
    reasoning: {
      content: "Added the boundary fixture.",
      reasoning: "The failure is in the tokenizer. Add a boundary case to the fixture.",
      stopReason: "stop",
      usage: { inputTokens: 188, outputTokens: 31 },
    },
    tool: {
      content: "",
      stopReason: "tool_use",
      toolCalls: [
        {
          id: "call_qwen_fixture_1",
          name: "edit",
          arguments: { path: "a.ts", old: "x=1", new: "x=2" },
        },
      ],
      usage: { inputTokens: 140, outputTokens: 22 },
    },
    usage: {
      content: "Cached context reused.",
      stopReason: "stop",
      usage: { inputTokens: 640, outputTokens: 5, cachedInputTokens: 384 },
    },
    abort: {
      content: "Partial reply from qwen",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    overflow: {
      content: "An answer that runs into the token ceiling and is truncated",
      stopReason: "length",
      usage: { inputTokens: 260, outputTokens: 65_536 },
    },
  },
  glm: {
    text: {
      content: "The sandbox defaults to auto isolation.",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 110, outputTokens: 8 },
    },
    reasoning: {
      content: "Receipts now cite their grant.",
      reasoning: "Check the grant before the effect. The receipt must cite the grant.",
      stopReason: "stop",
      usage: { inputTokens: 175, outputTokens: 26 },
    },
    tool: {
      content: "",
      stopReason: "tool_use",
      toolCalls: [
        {
          id: "call_glm_fixture_1",
          name: "grep",
          arguments: { pattern: "circuit", path: "src" },
        },
      ],
      usage: { inputTokens: 132, outputTokens: 17 },
    },
    usage: {
      content: "Usage follows.",
      stopReason: "stop",
      usage: { inputTokens: 420, outputTokens: 3, cachedInputTokens: 128 },
    },
    abort: {
      content: "Interrupted glm stream",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    overflow: {
      content: "A response that hits the completion limit mid-paragraph",
      stopReason: "length",
      usage: { inputTokens: 240, outputTokens: 131_072 },
    },
  },
  deepseek: {
    text: {
      content: "Facts are append-only; checkpoints are derived.",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 88, outputTokens: 8 },
      systemFingerprint: "fp_deepseek_v4_2026_06",
    },
    reasoning: {
      content: "Replay now rebuilds the checkpoint.",
      reasoning: "The race is between checkpoint save and event append; replay must rebuild.",
      stopReason: "stop",
      usage: { inputTokens: 320, outputTokens: 40 },
      systemFingerprint: "fp_deepseek_v4_2026_06",
    },
    tool: {
      content: "",
      stopReason: "tool_use",
      toolCalls: [
        { id: "call_deepseek_fixture_1", name: "bash", arguments: { command: "pnpm build" } },
      ],
      usage: { inputTokens: 148, outputTokens: 12 },
    },
    usage: {
      content: "Cache hit.",
      stopReason: "stop",
      usage: { inputTokens: 900, outputTokens: 2, cachedInputTokens: 512 },
    },
    abort: {
      content: "DeepSeek partial answer",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    overflow: {
      content: "A completion that reaches the cap without finishing",
      stopReason: "length",
      usage: { inputTokens: 512, outputTokens: 8_192 },
    },
  },
  minimax: {
    text: {
      content: "The harness keeps provider secrets out of the sandbox.",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 96, outputTokens: 12 },
    },
    reasoning: {
      content: "Both runs pass.",
      reasoning: "Compare the baseline and target runs. ",
      stopReason: "stop",
      providerState: {
        thinkingBlocks: [
          {
            type: "thinking",
            thinking: "Compare the baseline and target runs. ",
            signature: "sig-fixture-minimax",
          },
        ],
      },
      usage: { inputTokens: 88, outputTokens: 20 },
    },
    tool: {
      content: "",
      stopReason: "tool_use",
      toolCalls: [
        { id: "toolu_minimax_fixture_1", name: "bash", arguments: { command: "pnpm test" } },
      ],
      usage: { inputTokens: 120, outputTokens: 18 },
    },
    usage: {
      content: "Served from cache.",
      stopReason: "stop",
      usage: { inputTokens: 1000, outputTokens: 5, cachedInputTokens: 300 },
    },
    image: {
      content: "The screenshot shows a failing CI pipeline on the lint step.",
      stopReason: "stop",
      usage: { inputTokens: 1500, outputTokens: 14 },
    },
    abort: {
      content: "This minimax reply stops before the turn ends",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 64, outputTokens: 1 },
    },
    overflow: {
      content: "A long generation that reaches the token budget",
      stopReason: "length",
      usage: { inputTokens: 200, outputTokens: 32_768 },
    },
  },
};

const chunkSizes = fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 80 });

function sseStream(payloads: unknown[], sizes: number[]): ReadableStream<Uint8Array> {
  const text = payloads
    .map(
      (payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`,
    )
    .join("");
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.subarray(offset));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function replay(
  protocol: Protocol,
  payloads: unknown[],
  sizes: number[],
): Promise<ModelResponse> {
  const stream = sseStream(payloads, sizes);
  return protocol === "openai"
    ? consumeOpenAIStream(stream, () => undefined)
    : consumeAnthropicStream(stream, () => undefined);
}

for (const [family, { protocol, cases }] of Object.entries(FAMILIES)) {
  describe(`${family} protocol fixtures`, () => {
    for (const name of cases) {
      it(`replays ${name}.sse.json identically under arbitrary chunking`, async () => {
        const payloads: unknown[] = JSON.parse(
          await readFile(resolve(`evals/protocol/${family}/${name}.sse.json`), "utf8"),
        );
        const whole = await replay(protocol, payloads, [Number.MAX_SAFE_INTEGER]);
        expect(whole).toMatchObject(EXPECTED[family]![name]!);
        await fc.assert(
          fc.asyncProperty(chunkSizes, async (sizes) => {
            expect(await replay(protocol, payloads, sizes)).toEqual(whole);
          }),
          { numRuns: 25 },
        );
      });
    }
  });
}
