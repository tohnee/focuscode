import {
  newId,
  type AtomicDecisionResultV1,
  type CertifiedModelRefV1,
  type DecisionPort,
  type EffectClaimV1,
  type ModelDecisionV1,
  type TurnInputV1,
} from "@focuscode/contracts";

export interface ScriptedIntentTemplate {
  actionId?: string;
  toolId: string;
  arguments: unknown;
  expectedEffects: EffectClaimV1[];
  justification: string;
}

export type ScriptedStep =
  | ModelDecisionV1
  | { kind: "tool_intent_template"; intents: ScriptedIntentTemplate[] }
  | { kind: "fault"; status: "invalid" | "truncated" | "provider_error"; message: string };

export class ScriptedDecisionPort implements DecisionPort {
  private index = 0;

  constructor(private readonly steps: ScriptedStep[]) {}

  async decide(input: TurnInputV1, _model: CertifiedModelRefV1): Promise<AtomicDecisionResultV1> {
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) {
      return {
        status: "provider_error",
        usage: { inputTokens: 0, outputTokens: 0 },
        parserDiagnostics: [
          { code: "script.exhausted", message: "Scripted model has no next step" },
        ],
      };
    }
    if (step.kind === "fault") {
      return {
        status: step.status,
        usage: { inputTokens: 0, outputTokens: 0 },
        parserDiagnostics: [{ code: `script.${step.status}`, message: step.message }],
      };
    }
    let decision: ModelDecisionV1;
    if (step.kind === "tool_intent_template") {
      decision = {
        kind: "tool_intent",
        intents: step.intents.map((template) => {
          const tool = input.tools.find((candidate) => candidate.id === template.toolId);
          if (!tool) throw new Error(`Script references unavailable tool: ${template.toolId}`);
          return {
            schemaVersion: "action-intent.v1",
            actionId: template.actionId ?? newId("action"),
            taskId: input.execution.taskId,
            tool: { id: tool.id, version: tool.version, schemaDigest: tool.schemaDigest },
            arguments: template.arguments,
            expectedEffects: template.expectedEffects,
            justification: template.justification,
          };
        }),
      };
    } else {
      decision = step;
    }
    return {
      status: "complete",
      decision,
      usage: { inputTokens: 0, outputTokens: 0 },
      parserDiagnostics: [],
    };
  }
}
