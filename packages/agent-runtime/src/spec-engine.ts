import type { AgentEvent, AgentTool, ModelClient, ModelProfile } from "./types.js";
import type { AgentToolRegistry } from "./tools.js";
import type {
  SpecClarifyInput,
  SpecClarifyResult,
  SpecDraft,
  SpecEngineDeps,
  SpecEngineOptions,
  SpecKeyDecision,
  SpecStageModel,
  SpecStageTrace,
  ExplorerResult,
  SpecDocument,
} from "./spec-types.js";
import { SpecStoreImpl } from "./spec-store.js";
import { classifyIntent } from "./spec-classifier.js";
import { exploreCodebase } from "./spec-explorer.js";
import { draftSpec } from "./spec-drafter.js";
import { detectDecisions } from "./spec-decision-detector.js";
import { enhancePrompt } from "./spec-enhancer.js";
import { emptyExplorerResult, fallbackEnhance } from "./spec-pipeline-helpers.js";

type ConfirmationResolver = (choices: Record<string, string> | null) => void;

export class SpecEngine {
  private readonly store: SpecStoreImpl;
  private readonly projectType: string;
  private readonly instructionsSummary: string;
  private readonly confirmationResolvers = new Map<string, ConfirmationResolver>();
  private _pendingSpecId = "";

  constructor(
    private readonly options: SpecEngineOptions,
    private readonly deps: SpecEngineDeps,
  ) {
    this.store = new SpecStoreImpl(process.cwd(), options.specDirectory, deps);
    this.projectType = deps.detectProjectType(process.cwd());
    const instructions = deps.instructions ?? [];
    this.instructionsSummary = instructions.join("\n").slice(0, 2000);
  }

  get pendingSpecId(): string {
    return this._pendingSpecId;
  }

  async clarify(input: SpecClarifyInput): Promise<SpecClarifyResult> {
    const controller = new AbortController();
    if (input.externalSignal) {
      if (input.externalSignal.aborted)
        return { action: "abort", reason: "external signal aborted" };
      input.externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    // Stage 0: trigger logic
    const trimmed = input.prompt.trim();
    if (trimmed.startsWith("/raw")) {
      await this.emit(input, { type: "spec_skipped", reason: "user forced /raw" });
      return { action: "skip", reason: "user forced /raw" };
    }
    const forced = trimmed.startsWith("/spec");
    const prompt = forced ? trimmed.slice(5).trim() : trimmed;
    if (!prompt) {
      await this.emit(input, { type: "spec_skipped", reason: "empty prompt after command" });
      return { action: "skip", reason: "empty prompt after command" };
    }

    const trace: SpecStageTrace[] = [];
    const startTime = Date.now();
    let hadFallback = false;

    // Stage 1: Classifier
    let needsClarification = true;
    if (this.options.autoTrigger && !forced) {
      const classifierStage = this.options.pipeline.classifier;
      if (classifierStage) {
        try {
          const result = await this.runStage(
            "classify",
            classifierStage,
            (client, profile) =>
              classifyIntent(client, profile, prompt, this.projectType, controller.signal),
            trace,
            input,
          );
          needsClarification = result.needsClarification;
          if (!needsClarification && result.confidence >= 0.6) {
            const reason = `classifier: ${result.reason}`;
            await this.emit(input, { type: "spec_skipped", reason });
            return { action: "skip", reason };
          }
        } catch {
          if (classifierStage.fallback === "skip") {
            await this.emit(input, {
              type: "spec_skipped",
              reason: "classifier failed, assuming execute",
            });
            return { action: "skip", reason: "classifier failed, assuming execute" };
          }
          // "primary" fallback already attempted in runStage; "strict" falls through
          await this.emit(input, {
            type: "spec_skipped",
            reason: "classifier stage failed",
          });
          return { action: "skip", reason: "classifier stage failed" };
        }
      }
    }

    await this.emit(input, {
      type: "spec_start",
      input: prompt,
      trigger: forced ? "explicit" : "auto",
    });

    // Stage 2: Explorer (always uses main model)
    let explorerResult: ExplorerResult = emptyExplorerResult();
    try {
      explorerResult = await this.runStageMain(
        "explore",
        input.modelClient,
        input.model,
        () =>
          exploreCodebase({
            prompt,
            cwd: input.cwd,
            modelClient: input.modelClient,
            model: input.model,
            readOnlyTools: this.readOnlyTools(input.toolRegistry),
            maxRounds: this.options.maxExplorationRounds,
            signal: controller.signal,
          }),
        trace,
        "main-model",
      );
      await this.emitSpecStage(input, "explore", trace);
    } catch {
      hadFallback = true;
      trace.push({
        name: "explore",
        model: "main-model",
        durationMs: 0,
        fellBack: true,
        fallbackReason: "exploration failed",
      });
      await this.emitSpecStage(input, "explore", trace);
    }

    // Stage 3: Drafter
    let draft: SpecDraft;
    const drafterStage = this.options.pipeline.drafter;
    try {
      draft = await this.runStage(
        "draft",
        drafterStage ?? this.fallbackToMain(input),
        (client, profile) =>
          draftSpec(client, profile, {
            prompt,
            explorerResult,
            instructionsSummary: this.instructionsSummary,
          }),
        trace,
        input,
      );
    } catch {
      await this.emit(input, { type: "spec_skipped", reason: "drafter failed" });
      return { action: "skip", reason: "drafter failed" };
    }

    await this.emit(input, {
      type: "spec_draft_ready",
      specId: draft.id,
      topic: draft.topic,
      understanding: draft.understanding,
      taskBreakdown: draft.taskBreakdown,
    });

    // Stage 4: Decision Detector
    let keyDecisions: SpecKeyDecision[] = [];
    const detectorStage = this.options.pipeline.decisionDetector;
    try {
      keyDecisions = await this.runStage(
        "detect-decisions",
        detectorStage ?? this.fallbackToMain(input),
        (client, profile) => detectDecisions(client, profile, draft, this.options.keyDecisionRules),
        trace,
        input,
      );
    } catch {
      hadFallback = true;
      trace.push({
        name: "detect-decisions",
        model: "unknown",
        durationMs: 0,
        fellBack: true,
        fallbackReason: "detector failed",
      });
    }

    // Filter: only critical/major pause
    const blockingDecisions = keyDecisions.filter(
      (d) => d.severity === "critical" || d.severity === "major",
    );
    let confirmedDecisions = keyDecisions.map((d) => ({
      ...d,
      ...(d.severity === "minor" && d.options.length > 0 ? { chosen: d.options[0]!.label } : {}),
    }));

    if (blockingDecisions.length > 0) {
      this._pendingSpecId = draft.id;
      await this.emit(input, {
        type: "spec_confirmation_required",
        specId: draft.id,
        decisions: blockingDecisions,
      });
      const userChoices = await this.waitForConfirmation(draft.id, controller.signal);
      if (userChoices === null) {
        return { action: "abort", reason: "user declined spec" };
      }
      confirmedDecisions = keyDecisions.map((d) => ({
        ...d,
        // Preserve minor auto-choice — userChoices only contains blocking decisions
        ...(d.severity === "minor" && d.options.length > 0 ? { chosen: d.options[0]!.label } : {}),
        ...(userChoices[d.id] ? { chosen: userChoices[d.id] } : {}),
      }));
      await this.emit(input, {
        type: "spec_confirmed",
        specId: draft.id,
        decisions: confirmedDecisions,
      });
    }

    // Stage 5: Enhancer
    let enhancedPrompt: string;
    const enhancerStage = this.options.pipeline.enhancer;
    try {
      enhancedPrompt = await this.runStage(
        "enhance",
        enhancerStage ?? this.fallbackToMain(input),
        (client, profile) => enhancePrompt(client, profile, { draft, confirmedDecisions }),
        trace,
        input,
      );
    } catch {
      hadFallback = true;
      enhancedPrompt = fallbackEnhance(draft, confirmedDecisions);
      trace.push({
        name: "enhance",
        model: "unknown",
        durationMs: 0,
        fellBack: true,
        fallbackReason: "enhancer failed, using manual fallback",
      });
    }

    // Persist
    const totalMs = Date.now() - startTime;
    const doc: SpecDocument = {
      id: draft.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      topic: draft.topic,
      trigger: forced ? "explicit" : "auto",
      originalInput: input.prompt,
      understanding: draft.understanding,
      taskBreakdown: draft.taskBreakdown,
      keyDecisions: confirmedDecisions,
      enhancedPrompt,
      initialTodos: this.extractTodos(draft),
      status: "confirmed",
      pipelineTrace: { stages: trace, totalMs, hadFallback },
    };

    let specPath = "";
    try {
      specPath = await this.store.save(doc);
    } catch {
      hadFallback = true;
      trace.push({
        name: "persist",
        model: "none",
        durationMs: 0,
        fellBack: true,
        fallbackReason: "save failed",
      });
    }

    await this.emit(input, { type: "spec_completed", specId: doc.id, enhancedPrompt });

    return {
      action: "apply",
      specId: doc.id,
      enhancedPrompt,
      initialTodos: doc.initialTodos,
      specPath,
      topic: doc.topic,
    };
  }

  resolveDecisions(specId: string, choices: Record<string, string>): void {
    const resolver = this.confirmationResolvers.get(specId);
    if (resolver) resolver(choices);
  }

  declineSpec(specId: string): void {
    const resolver = this.confirmationResolvers.get(specId);
    if (resolver) resolver(null);
  }

  private async runStage<T>(
    name: SpecStageTrace["name"],
    stage: SpecStageModel | undefined,
    fn: (client: ModelClient, profile: ModelProfile) => Promise<T>,
    trace: SpecStageTrace[],
    input: SpecClarifyInput,
  ): Promise<T> {
    const start = Date.now();
    if (!stage) {
      // No stage configured — use main model
      const result = await this.runStageMain(
        name,
        input.modelClient,
        input.model,
        () => fn(input.modelClient, input.model),
        trace,
        "main-model",
      );
      await this.emitSpecStage(input, name, trace);
      return result;
    }
    try {
      const result = await fn(stage.client, stage.profile);
      trace.push({
        name,
        model: `${stage.profile.provider}/${stage.profile.model}`,
        durationMs: Date.now() - start,
        fellBack: false,
      });
      await this.emitSpecStage(input, name, trace);
      return result;
    } catch (error) {
      if (stage.fallback === "strict") throw error;
      if (stage.fallback === "skip") throw error;
      // "primary" — retry with main model
      trace.push({
        name,
        model: `${stage.profile.provider}/${stage.profile.model}`,
        durationMs: Date.now() - start,
        fellBack: true,
        fallbackReason: error instanceof Error ? error.message : String(error),
      });
      const result = await this.runStageMain(
        name,
        input.modelClient,
        input.model,
        () => fn(input.modelClient, input.model),
        trace,
        "main-model",
      );
      await this.emitSpecStage(input, name, trace);
      return result;
    }
  }

  private async runStageMain<T>(
    name: SpecStageTrace["name"],
    client: ModelClient,
    profile: ModelProfile,
    fn: () => Promise<T>,
    trace: SpecStageTrace[],
    modelLabel: string,
  ): Promise<T> {
    void client;
    void profile;
    const start = Date.now();
    const result = await fn();
    trace.push({ name, model: modelLabel, durationMs: Date.now() - start, fellBack: false });
    return result;
  }

  private async emitSpecStage(
    input: SpecClarifyInput,
    name: string,
    trace: SpecStageTrace[],
  ): Promise<void> {
    const last = trace[trace.length - 1];
    await this.emit(input, {
      type: "spec_stage",
      stage: name,
      model: last?.model ?? "unknown",
      durationMs: last?.durationMs ?? 0,
      fellBack: last?.fellBack ?? false,
    });
  }

  private fallbackToMain(input: SpecClarifyInput): SpecStageModel {
    return {
      profile: input.model,
      client: input.modelClient,
      fallback: "primary",
    };
  }

  private waitForConfirmation(
    specId: string,
    signal: AbortSignal,
  ): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        this.confirmationResolvers.delete(specId);
        this._pendingSpecId = "";
      };
      const onAbort = () => {
        cleanup();
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.confirmationResolvers.set(specId, (choices) => {
        cleanup();
        resolve(choices);
      });
    });
  }

  private readOnlyTools(registry: AgentToolRegistry): AgentTool[] {
    const names = ["read", "grep", "find", "ls"];
    const tools: AgentTool[] = [];
    for (const name of names) {
      const tool = registry.get?.(name);
      if (tool) tools.push(tool);
    }
    return tools;
  }

  private extractTodos(draft: SpecDraft): SpecDocument["initialTodos"] {
    return draft.taskBreakdown.map((task) => ({
      taskId: task.id,
      content: task.description,
      priority: "medium" as const,
    }));
  }

  private async emit(input: SpecClarifyInput, event: AgentEvent): Promise<void> {
    if (input.eventSink) {
      try {
        await input.eventSink(event);
      } catch {
        // eventSink failures must not block pipeline
      }
    }
  }
}
