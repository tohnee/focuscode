import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LocalActionRuntime,
  SafeCommandRunner,
  WorkspaceGuard,
  createLocalToolRegistry,
} from "@focuscode/action-backends";
import { PolicyEngine, type ApprovalPort, type PolicyConfig } from "@focuscode/action-domain";
import { FileMemoryStore } from "@focuscode/asset-plane";
import { ContextCompiler, buildRepoProfile, type RepoProfileV1 } from "@focuscode/context-compiler";
import {
  TaskSpecSchema,
  assertSchema,
  newId,
  sha256Digest,
  type BudgetV1,
  type CertifiedModelRefV1,
  type DecisionPort,
  type ExecutionContextV1,
  type KernelCheckpointV1,
  type TaskSpecV1,
} from "@focuscode/contracts";
import { FocusKernel, type KernelRunResult } from "@focuscode/harness-core";
import {
  GatewayDecisionPort,
  OpenAICompatibleTransport,
  createDevelopmentModelRef,
  loadModelPack,
} from "@focuscode/model-gateway";
import { FileFactStore } from "@focuscode/persistence";
import { ScriptedDecisionPort, type ScriptedStep } from "@focuscode/testkit";
import { RegisteredCommandVerifier } from "@focuscode/verifier-eval";

// The default pack ships inside the published @focuscode/cli package
// (bundle/focuscode.mjs → ../model-packs) and lives at the repository root
// during development (packages/sdk/{src,dist} → ../../../model-packs).
const DEFAULT_PACK_PATH = resolveDefaultPackPath();

function resolveDefaultPackPath(): string {
  const candidates = [
    new URL("../model-packs/generic-openai/pack.json", import.meta.url),
    new URL("../../../model-packs/generic-openai/pack.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  return fileURLToPath(candidates[candidates.length - 1]!);
}

export type ApprovalMode = "deny" | "prompt" | "auto-safe";

interface LocalHarnessBaseOptions {
  repoRoot: string;
  stateDirectory: string;
  modelPackPath?: string;
  approvalMode?: ApprovalMode;
  approval?: ApprovalPort;
  trustRepoConfig?: boolean;
  workerId?: string;
}

export interface ScriptedHarnessOptions extends LocalHarnessBaseOptions {
  model: { kind: "scripted"; steps: ScriptedStep[] };
}

export interface OpenAIHarnessOptions extends LocalHarnessBaseOptions {
  model: {
    kind: "openai-compatible";
    modelId: string;
    baseUrl: string;
    apiKey?: string;
    extraHeaders?: Record<string, string>;
  };
}

export type LocalHarnessOptions = ScriptedHarnessOptions | OpenAIHarnessOptions;

export interface RunTaskOptions {
  taskId?: string;
  tenantId?: string;
  actorId?: string;
  dataClass?: "standard" | "restricted";
  budget?: Partial<BudgetV1>;
}

export class LocalHarness {
  constructor(
    readonly facts: FileFactStore,
    readonly memory: FileMemoryStore,
    readonly actions: LocalActionRuntime,
    readonly profile: RepoProfileV1,
    readonly model: CertifiedModelRefV1,
    private readonly kernel: FocusKernel,
  ) {}

  async run(task: TaskSpecV1, options: RunTaskOptions = {}): Promise<KernelRunResult> {
    assertSchema(TaskSpecSchema, task, "task spec");
    const taskId = options.taskId ?? newId("task");
    const budget: BudgetV1 = {
      maxTurns: options.budget?.maxTurns ?? 20,
      maxActions: options.budget?.maxActions ?? 40,
      maxWallTimeMs: options.budget?.maxWallTimeMs ?? 20 * 60_000,
      maxChangedFiles: options.budget?.maxChangedFiles ?? task.scope?.maxFiles ?? 20,
      maxChangedLines: options.budget?.maxChangedLines ?? task.scope?.maxChangedLines ?? 1_000,
    };
    const execution: ExecutionContextV1 = {
      schemaVersion: "execution-context.v1",
      taskId,
      tenantId: options.tenantId ?? "local",
      actor: { id: options.actorId ?? "local-user", kind: "user" },
      dataClass: options.dataClass ?? "standard",
      policySnapshot: sha256Digest({
        profile: this.profile.digest,
        budget,
        model: this.model.certificateId,
      }),
      budget,
      traceId: newId("trace"),
      createdAt: new Date().toISOString(),
    };
    return this.kernel.run({ task, execution, model: this.model });
  }

  async inspect(taskId: string): Promise<KernelCheckpointV1 | undefined> {
    return this.facts.loadCheckpoint(taskId);
  }
}

export async function createLocalHarness(options: LocalHarnessOptions): Promise<LocalHarness> {
  const workspace = await WorkspaceGuard.create(options.repoRoot);
  const profile = await buildRepoProfile(workspace.root);
  const runner = new SafeCommandRunner(profile.commands, { cwd: workspace.root });
  const registry = createLocalToolRegistry(workspace, runner);
  const approvalMode = options.approvalMode ?? "deny";
  const policyConfig: PolicyConfig = {
    protectedPaths: profile.protectedPaths,
    maxChangedFiles: 20,
    maxChangedLines: 1_000,
    maxRiskScore: 50,
    allowNetwork: false,
    allowSecrets: false,
    autoGrantRegisteredCommands: approvalMode === "auto-safe",
    autoGrantSafeWrites: approvalMode === "auto-safe",
  };
  const approval = options.approval ?? denyApproval;
  const actions = new LocalActionRuntime(registry, new PolicyEngine(policyConfig), approval);
  const facts = new FileFactStore(options.stateDirectory);
  const memory = new FileMemoryStore(options.stateDirectory);
  const verifier = new RegisteredCommandVerifier(
    runner,
    options.trustRepoConfig ? profile.verificationCommandIds : [],
  );
  const loadedPack = await loadModelPack(options.modelPackPath ?? DEFAULT_PACK_PATH);
  const modelId = options.model.kind === "scripted" ? "scripted-model" : options.model.modelId;
  const model = createDevelopmentModelRef(loadedPack, modelId);
  const decision: DecisionPort =
    options.model.kind === "scripted"
      ? new ScriptedDecisionPort(options.model.steps)
      : new GatewayDecisionPort({
          loadedPack,
          contextCompiler: new ContextCompiler(profile),
          transport: new OpenAICompatibleTransport({
            baseUrl: options.model.baseUrl,
            ...(options.model.apiKey ? { apiKey: options.model.apiKey } : {}),
            ...(options.model.extraHeaders ? { extraHeaders: options.model.extraHeaders } : {}),
          }),
        });
  const kernel = new FocusKernel({
    decision,
    effects: actions,
    facts,
    verifier,
    tools: registry.specs(),
    workerId: options.workerId ?? `local-worker:${process.pid}`,
  });
  return new LocalHarness(facts, memory, actions, profile, model, kernel);
}

const denyApproval: ApprovalPort = {
  async request() {
    return false;
  },
};
