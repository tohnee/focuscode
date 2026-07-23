import type {
  AtomicDecisionResultV1,
  CertifiedModelRefV1,
  DecisionPort,
  ModelPackV1,
  TurnInputV1,
} from "@focuscode/contracts";
import { ContextCompiler } from "@focuscode/context-compiler";
import { AtomicDecisionParser } from "./atomic-parser.js";
import { assertPackBinding, type LoadedModelPack } from "./model-pack.js";
import type { ChatMessage, ModelTransport } from "./openai-transport.js";

export interface GatewayDecisionPortOptions {
  loadedPack: LoadedModelPack;
  contextCompiler: ContextCompiler;
  transport: ModelTransport;
  timeoutMs?: number;
}

function decisionContract(taskId: string, pack: ModelPackV1): string {
  return [
    "Output one JSON object and no surrounding prose.",
    'Allowed kinds: "respond", "ask_user", "tool_intent", "plan_revision", "completion_candidate".',
    `For tool_intent use at most ${pack.maxToolIntentsPerTurn} intent(s).`,
    `Every intent must include schemaVersion "action-intent.v1", taskId "${taskId}", a unique actionId,`,
    "an exact tool {id,version,schemaDigest} copied from tools.schemas, arguments, expectedEffects,",
    "and a concise justification. Tool output arrives in a later turn.",
    "completion_candidate requires summary, evidence array and residualRisks array.",
  ].join("\n");
}

export class GatewayDecisionPort implements DecisionPort {
  private readonly parser: AtomicDecisionParser;

  constructor(private readonly options: GatewayDecisionPortOptions) {
    this.parser = new AtomicDecisionParser(options.loadedPack.pack);
  }

  async decide(input: TurnInputV1, model: CertifiedModelRefV1): Promise<AtomicDecisionResultV1> {
    assertPackBinding(this.options.loadedPack, model);
    const compiled = this.options.contextCompiler.compile(input, this.options.loadedPack.pack);
    const stable = compiled.frames.filter((frame) =>
      ["harness.contract", "policy.snapshot", "tools.schemas", "repo.profile"].includes(frame.kind),
    );
    const dynamic = compiled.frames.filter((frame) => !stable.includes(frame));
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${this.options.loadedPack.pack.systemPrompt}\n\n${decisionContract(input.execution.taskId, this.options.loadedPack.pack)}\n\n${stable.map(renderFrame).join("\n\n")}`,
      },
      { role: "user", content: dynamic.map(renderFrame).join("\n\n") },
    ];
    try {
      const response = await this.options.transport.complete({
        model: model.modelId,
        messages,
        responseFormat: this.options.loadedPack.pack.responseFormat,
        timeoutMs: this.options.timeoutMs ?? 120_000,
      });
      return this.parser.parse(response);
    } catch (error) {
      return {
        status: "provider_error",
        usage: { inputTokens: 0, outputTokens: 0 },
        parserDiagnostics: [
          {
            code: "transport.error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
}

function renderFrame(frame: { kind: string; trust: string; content: string }): string {
  return `--- ${frame.kind} [trust=${frame.trust}] ---\n${frame.content}`;
}
