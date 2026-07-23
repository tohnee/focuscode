import {
  newId,
  type CertifiedModelRefV1,
  type DecisionPort,
  type DomainEventV1,
  type EffectPort,
  type ExecutionContextV1,
  type FactPort,
  type KernelCheckpointV1,
  type ModelDecisionV1,
  type NewDomainEventV1,
  type TaskSpecV1,
  type TaskStateV1,
  type ToolSpecV1,
  type TurnInputV1,
  type VerifyPort,
  type VerificationReportV1,
} from "@focuscode/contracts";
import { assertTransition, isQuiescentState } from "./state-machine.js";

export interface FocusKernelDependencies {
  decision: DecisionPort;
  effects: EffectPort;
  facts: FactPort;
  verifier: VerifyPort;
  tools: ToolSpecV1[];
  workerId: string;
  now?: () => Date;
}

export interface KernelRunRequest {
  task: TaskSpecV1;
  execution: ExecutionContextV1;
  model: CertifiedModelRefV1;
}

export interface KernelRunResult {
  checkpoint: KernelCheckpointV1;
  events: DomainEventV1[];
  verification?: VerificationReportV1;
}

export class FocusKernel {
  private readonly now: () => Date;

  constructor(private readonly dependencies: FocusKernelDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(request: KernelRunRequest): Promise<KernelRunResult> {
    this.validateRequest(request);
    const existingEvents = await this.dependencies.facts.loadEvents(request.execution.taskId);
    let checkpoint =
      (await this.dependencies.facts.loadCheckpoint(request.execution.taskId)) ??
      this.newCheckpoint(request, 0);
    // Crash window B: the checkpoint is newer than the event log (the checkpoint
    // save landed but a later event append did not). Treat the checkpoint as
    // uncommitted and rebuild it from the events — the source of truth —
    // otherwise the next append would wedge on a permanent version conflict.
    const maxEventSeq = existingEvents.at(-1)?.seq ?? 0;
    if (checkpoint.eventVersion > maxEventSeq) {
      checkpoint = this.newCheckpoint(request, 0);
    }
    checkpoint = await this.replayAfterCheckpoint(checkpoint, existingEvents, request.execution);

    if (isQuiescentState(checkpoint.state)) {
      return {
        checkpoint,
        events: existingEvents,
        ...(checkpoint.baseline ? { verification: checkpoint.baseline } : {}),
      };
    }

    if (checkpoint.state === "CREATED") {
      if (!existingEvents.some((event) => event.kind === "TaskCreated")) {
        await this.append(checkpoint, request.execution, "TaskCreated", { task: request.task });
      }
      await this.transition(checkpoint, request.execution, "PREFLIGHT", "task accepted");
    }
    if (checkpoint.state === "PREFLIGHT") {
      if (!checkpoint.baseline) {
        const baseline = await this.dependencies.verifier.verify({
          taskId: request.execution.taskId,
          phase: "baseline",
        });
        checkpoint.baseline = baseline;
        await this.append(checkpoint, request.execution, "PreflightCompleted", { baseline });
      }
      await this.transition(checkpoint, request.execution, "READY", "preflight completed");
      await this.dependencies.facts.saveCheckpoint(checkpoint);
    }
    if (checkpoint.state === "READY") {
      await this.transition(checkpoint, request.execution, "RUNNING", "worker lease acquired");
    }

    const started = Date.parse(checkpoint.startedAt);
    let finalVerification: VerificationReportV1 | undefined;
    while (checkpoint.state === "RUNNING") {
      if (checkpoint.turn >= request.execution.budget.maxTurns) {
        await this.block(checkpoint, request.execution, "Turn budget exhausted");
        break;
      }
      if (checkpoint.actionCount >= request.execution.budget.maxActions) {
        await this.block(checkpoint, request.execution, "Action budget exhausted");
        break;
      }
      if (this.now().getTime() - started >= request.execution.budget.maxWallTimeMs) {
        await this.block(checkpoint, request.execution, "Wall-time budget exhausted");
        break;
      }

      checkpoint.turn += 1;
      checkpoint.updatedAt = this.now().toISOString();
      const recentEvents = (
        await this.dependencies.facts.loadEvents(request.execution.taskId)
      ).slice(-20);
      const input: TurnInputV1 = {
        schemaVersion: "turn-input.v1",
        task: request.task,
        execution: request.execution,
        state: checkpoint.state,
        turn: checkpoint.turn,
        publicPlan: checkpoint.publicPlan,
        tools: this.dependencies.tools,
        recentEvents,
        recentEffects: checkpoint.recentEffects.slice(-8),
      };
      await this.append(checkpoint, request.execution, "TurnStarted", {
        turn: checkpoint.turn,
        model: request.model,
      });
      const atomic = await this.dependencies.decision.decide(input, request.model);
      if (atomic.status !== "complete" || !atomic.decision) {
        await this.append(checkpoint, request.execution, "ModelDecisionRejected", {
          turn: checkpoint.turn,
          status: atomic.status,
          diagnostics: atomic.parserDiagnostics,
          usage: atomic.usage,
        });
        await this.block(checkpoint, request.execution, `Atomic turn rejected: ${atomic.status}`);
        break;
      }
      await this.append(checkpoint, request.execution, "ModelDecisionAccepted", {
        turn: checkpoint.turn,
        decision: atomic.decision,
        usage: atomic.usage,
      });
      finalVerification = await this.applyDecision(atomic.decision, request, checkpoint);
      await this.dependencies.facts.saveCheckpoint(checkpoint);
    }

    await this.dependencies.facts.saveCheckpoint(checkpoint);
    return {
      checkpoint,
      events: await this.dependencies.facts.loadEvents(request.execution.taskId),
      ...(finalVerification ? { verification: finalVerification } : {}),
    };
  }

  private async applyDecision(
    decision: ModelDecisionV1,
    request: KernelRunRequest,
    checkpoint: KernelCheckpointV1,
  ): Promise<VerificationReportV1 | undefined> {
    switch (decision.kind) {
      case "respond":
        await this.append(checkpoint, request.execution, "ResponseProduced", {
          content: decision.content,
        });
        await this.transition(
          checkpoint,
          request.execution,
          "WAITING_INPUT",
          "response awaits user",
        );
        return undefined;
      case "ask_user":
        await this.append(checkpoint, request.execution, "UserInputRequested", {
          questions: decision.questions,
        });
        await this.transition(
          checkpoint,
          request.execution,
          "WAITING_INPUT",
          "model requested input",
        );
        return undefined;
      case "plan_revision":
        checkpoint.publicPlan = decision.steps;
        await this.append(checkpoint, request.execution, "PublicPlanRevised", {
          steps: decision.steps,
          evidence: decision.evidence,
        });
        return undefined;
      case "delegate_intent":
        await this.append(checkpoint, request.execution, "DelegationRejected", {
          reason: "A2A delegation is outside the Alpha write loop",
        });
        await this.block(checkpoint, request.execution, "Delegation requires the P1 A2A gateway");
        return undefined;
      case "tool_intent": {
        if (
          checkpoint.actionCount + decision.intents.length >
          request.execution.budget.maxActions
        ) {
          await this.block(
            checkpoint,
            request.execution,
            "Decision exceeds remaining action budget",
          );
          return undefined;
        }
        await this.append(checkpoint, request.execution, "ActionRequested", {
          intents: decision.intents,
        });
        // ActionStarted is persisted BEFORE dispatching to the effect port
        // (crash window C): if the worker dies between submit and
        // EffectObserved, recovery finds a started-but-unobserved action and
        // marks it UNKNOWN instead of silently re-executing the side effect.
        for (const intent of decision.intents) {
          await this.append(checkpoint, request.execution, "ActionStarted", {
            actionId: intent.actionId,
          });
        }
        const receipts = await this.dependencies.effects.submit(decision.intents, {
          execution: request.execution,
          model: request.model,
          workerId: this.dependencies.workerId,
        });
        checkpoint.actionCount += decision.intents.length;
        checkpoint.recentEffects = [...checkpoint.recentEffects, ...receipts].slice(-32);
        for (const receipt of receipts) {
          if (receipt.grant) {
            await this.append(checkpoint, request.execution, "GrantIssued", {
              grant: receipt.grant,
            });
          }
          await this.append(checkpoint, request.execution, "EffectObserved", { receipt });
        }
        return undefined;
      }
      case "completion_candidate": {
        await this.append(checkpoint, request.execution, "CompletionCandidateProposed", {
          summary: decision.summary,
          evidence: decision.evidence,
          residualRisks: decision.residualRisks,
        });
        await this.transition(
          checkpoint,
          request.execution,
          "VERIFYING",
          "completion requires gate",
        );
        const report = await this.dependencies.verifier.verify({
          taskId: request.execution.taskId,
          phase: "target",
          ...(checkpoint.baseline ? { baseline: checkpoint.baseline } : {}),
        });
        await this.append(checkpoint, request.execution, "VerificationCompleted", { report });
        if (report.conclusion === "PASS") {
          await this.transition(
            checkpoint,
            request.execution,
            "REVIEW_READY",
            "verification passed",
          );
        } else {
          await this.transition(
            checkpoint,
            request.execution,
            "BLOCKED",
            `verification concluded ${report.conclusion}`,
          );
        }
        return report;
      }
    }
  }

  private newCheckpoint(request: KernelRunRequest, eventVersion: number): KernelCheckpointV1 {
    const now = this.now().toISOString();
    return {
      schemaVersion: "kernel-checkpoint.v1",
      taskId: request.execution.taskId,
      state: "CREATED",
      eventVersion,
      turn: 0,
      actionCount: 0,
      startedAt: now,
      updatedAt: now,
      publicPlan: [],
      recentEffects: [],
      model: request.model,
    };
  }

  private async replayAfterCheckpoint(
    checkpoint: KernelCheckpointV1,
    events: DomainEventV1[],
    execution: ExecutionContextV1,
  ): Promise<KernelCheckpointV1> {
    const missing = events.filter((event) => event.seq > checkpoint.eventVersion);
    for (const event of missing) {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      if (event.kind === "TaskStateChanged" && typeof payload.to === "string") {
        checkpoint.state = payload.to as TaskStateV1;
      }
      if (event.kind === "PublicPlanRevised" && Array.isArray(payload.steps)) {
        checkpoint.publicPlan = payload.steps.filter(
          (step): step is string => typeof step === "string",
        );
      }
      if (event.kind === "PreflightCompleted" && payload.baseline) {
        checkpoint.baseline = payload.baseline as VerificationReportV1;
      }
      if (event.kind === "EffectObserved" && payload.receipt) {
        checkpoint.recentEffects = [
          ...checkpoint.recentEffects,
          payload.receipt as KernelCheckpointV1["recentEffects"][number],
        ].slice(-32);
        checkpoint.actionCount += 1;
      }
      checkpoint.eventVersion = event.seq;
    }
    const markedUnknown = await this.markOrphanedActionsUnknown(checkpoint, events, execution);
    if (missing.length > 0 || markedUnknown) {
      checkpoint.updatedAt = this.now().toISOString();
      await this.dependencies.facts.saveCheckpoint(checkpoint);
    }
    return checkpoint;
  }

  /**
   * An ActionStarted without a matching EffectObserved means the worker crashed
   * between dispatching the effect and recording its receipt. The action is
   * marked UNKNOWN — never silently re-executed, because a missing receipt does
   * not prove the side effect never ran (§4.2). The EffectUnknown event makes
   * the mark durable and idempotent: later resumes see it and skip the action.
   */
  private async markOrphanedActionsUnknown(
    checkpoint: KernelCheckpointV1,
    events: DomainEventV1[],
    execution: ExecutionContextV1,
  ): Promise<boolean> {
    const observed = new Set<string>();
    const unknown = new Set<string>();
    for (const event of events) {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      if (event.kind === "EffectObserved") {
        const receipt = payload.receipt as { actionId?: unknown } | undefined;
        if (typeof receipt?.actionId === "string") observed.add(receipt.actionId);
      }
      if (event.kind === "EffectUnknown" && typeof payload.actionId === "string") {
        unknown.add(payload.actionId);
      }
    }
    let marked = false;
    for (const event of events) {
      if (event.kind !== "ActionStarted") continue;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const actionId = typeof payload.actionId === "string" ? payload.actionId : undefined;
      if (!actionId || observed.has(actionId) || unknown.has(actionId)) continue;
      unknown.add(actionId);
      await this.append(checkpoint, execution, "EffectUnknown", {
        actionId,
        reason: "started without receipt",
      });
      marked = true;
    }
    return marked;
  }

  private async transition(
    checkpoint: KernelCheckpointV1,
    execution: ExecutionContextV1,
    to: TaskStateV1,
    reason: string,
  ): Promise<void> {
    assertTransition(checkpoint.state, to);
    const from = checkpoint.state;
    await this.append(checkpoint, execution, "TaskStateChanged", { from, to, reason });
    checkpoint.state = to;
    checkpoint.updatedAt = this.now().toISOString();
  }

  private async block(
    checkpoint: KernelCheckpointV1,
    execution: ExecutionContextV1,
    reason: string,
  ): Promise<void> {
    await this.append(checkpoint, execution, "TaskBlocked", { reason });
    await this.transition(checkpoint, execution, "BLOCKED", reason);
  }

  private async append(
    checkpoint: KernelCheckpointV1,
    execution: ExecutionContextV1,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    const event: NewDomainEventV1 = {
      schemaVersion: "domain-event.v1",
      eventId: newId("evt"),
      taskId: execution.taskId,
      kind,
      at: this.now().toISOString(),
      actor: execution.actor,
      payload,
    };
    const ack = await this.dependencies.facts.append({
      taskId: execution.taskId,
      expectedVersion: checkpoint.eventVersion,
      events: [event],
    });
    checkpoint.eventVersion = ack.lastSeq;
    checkpoint.updatedAt = this.now().toISOString();
  }

  private validateRequest(request: KernelRunRequest): void {
    if (request.execution.taskId.length === 0) throw new Error("taskId is required");
    if (request.task.repoId.length === 0) throw new Error("repoId is required");
    if (request.model.expiresAt !== undefined) {
      const expiresAt = Date.parse(request.model.expiresAt);
      // Fail closed: an unparseable or past expiry means the certificate can
      // no longer be trusted, so the run never starts.
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
        throw new Error(
          `Model certificate ${request.model.certificateId} expired at ${request.model.expiresAt}`,
        );
      }
    }
    const capability = request.task.mode === "change" ? "change" : "explore";
    if (!request.model.certifiedCapabilities.includes(capability)) {
      throw new Error(`Model certificate ${request.model.certificateId} lacks ${capability}`);
    }
  }
}
