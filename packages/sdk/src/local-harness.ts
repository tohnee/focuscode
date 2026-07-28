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
  type FactPort,
  type KernelCheckpointV1,
  type TaskSpecV1,
  type VerifyPort,
} from "@focuscode/contracts";
import { FocusKernel, type KernelRunResult } from "@focuscode/harness-core";
import {
  GatewayDecisionPort,
  OpenAICompatibleTransport,
  createDevelopmentModelRef,
  loadModelPack,
  type LoadedModelPack,
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

/**
 * Canonical approval modes for the audit-style LocalHarness.
 *
 * The SDK surface historically called this `ApprovalMode`, which collided
 * with the agent-runtime `ApprovalMode` union (`ask | auto-edit | full-auto |
 * deny`) once both were re-exported from composition roots. The
 * disambiguated alias `HarnessApprovalMode` is now the canonical name; the
 * legacy alias is retained for backwards compatibility.
 *
 * `HARNESS_APPROVAL_MODES` is the runtime source of truth — the type is
 * derived from it so external tooling (JSON Schema, runtime validators) can
 * stay in lockstep with the TypeScript union without drift.
 */
export const HARNESS_APPROVAL_MODES = ["deny", "prompt", "auto-safe"] as const;
export type HarnessApprovalMode = (typeof HARNESS_APPROVAL_MODES)[number];
/** @deprecated Use {@link HarnessApprovalMode} to avoid colliding with agent-runtime's ApprovalMode. */
export type ApprovalMode = HarnessApprovalMode;

interface LocalHarnessBaseOptions {
  repoRoot: string;
  stateDirectory: string;
  modelPackPath?: string;
  approvalMode?: ApprovalMode;
  approval?: ApprovalPort;
  trustRepoConfig?: boolean;
  workerId?: string;
  /**
   * Override the default {@link FileFactStore} with a custom {@link FactPort}
   * implementation (e.g., a Postgres-backed fact store). When omitted, the
   * harness constructs a `FileFactStore` rooted at `stateDirectory`.
   */
  factStore?: FactPort;
  /**
   * Override the default {@link RegisteredCommandVerifier} with a custom
   * {@link VerifyPort}. When omitted, the harness wires the registered
   * command verifier using `trustRepoConfig` and the repo profile.
   */
  verifier?: VerifyPort;
  /**
   * Override the decision port entirely, bypassing the `model.kind` switch.
   * Use this when the integrator has a pre-configured `GatewayDecisionPort`,
   * a custom circuit-breaker wrapper, or any other `DecisionPort` that
   * cannot be expressed via the `model` option.
   */
  decision?: DecisionPort;
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
    readonly facts: FactPort,
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
  const facts: FactPort = options.factStore ?? new FileFactStore(options.stateDirectory);
  const memory = new FileMemoryStore(options.stateDirectory);
  const verifier: VerifyPort =
    options.verifier ??
    new RegisteredCommandVerifier(
      runner,
      options.trustRepoConfig ? profile.verificationCommandIds : [],
    );
  const loadedPack = await loadModelPack(options.modelPackPath ?? DEFAULT_PACK_PATH);
  const modelId = options.model.kind === "scripted" ? "scripted-model" : options.model.modelId;
  const model = createDevelopmentModelRef(loadedPack, modelId);
  const decision: DecisionPort =
    options.decision ?? buildDecisionPort(options, loadedPack, profile);
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

/**
 * Build the default {@link DecisionPort} from the `model` option. Called only
 * when the integrator has not supplied a `decision` override; the override
 * short-circuits this branch so custom decision ports (e.g., a
 * circuit-breaker wrapper or a remote gateway) can be wired without going
 * through the scripted/openai-compatible dichotomy.
 */
function buildDecisionPort(
  options: LocalHarnessOptions,
  loadedPack: LoadedModelPack,
  profile: RepoProfileV1,
): DecisionPort {
  if (options.model.kind === "scripted") {
    return new ScriptedDecisionPort(options.model.steps);
  }
  return new GatewayDecisionPort({
    loadedPack,
    contextCompiler: new ContextCompiler(profile),
    transport: new OpenAICompatibleTransport({
      baseUrl: options.model.baseUrl,
      ...(options.model.apiKey ? { apiKey: options.model.apiKey } : {}),
      ...(options.model.extraHeaders ? { extraHeaders: options.model.extraHeaders } : {}),
    }),
  });
}
