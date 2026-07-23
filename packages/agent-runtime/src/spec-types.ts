import type {
  AgentAttachment,
  AgentEvent,
  AgentMessage,
  ModelClient,
  ModelProfile,
} from "./types.js";
import type { AgentToolRegistry } from "./tools.js";

// === Lifecycle types ===

export type SpecStatus =
  "draft" | "confirming" | "confirmed" | "executing" | "completed" | "superseded" | "aborted";

export type SpecTrigger = "auto" | "explicit";

// === Core document ===

export interface SpecDocument {
  id: string;
  createdAt: string;
  updatedAt: string;
  topic: string;
  trigger: SpecTrigger;
  originalInput: string;
  understanding: SpecUnderstanding;
  taskBreakdown: SpecTaskNode[];
  keyDecisions: SpecKeyDecision[];
  enhancedPrompt: string;
  initialTodos: SpecInitialTodo[];
  status: SpecStatus;
  pipelineTrace: SpecPipelineTrace;
}

export interface SpecUnderstanding {
  goal: string;
  constraints: SpecConstraint[];
  acceptanceCriteria: SpecAcceptanceCriterion[];
  affectedAreas: SpecAffectedArea[];
  ambiguities: SpecAmbiguity[];
}

export interface SpecConstraint {
  source: "user" | "codebase" | "convention";
  description: string;
  severity: "hard" | "soft";
}

export interface SpecAcceptanceCriterion {
  description: string;
  verification: "test" | "lint" | "build" | "manual";
  verificationTarget?: string;
}

export interface SpecAffectedArea {
  path: string;
  impact: "modify" | "create" | "delete" | "review";
  reason: string;
}

export interface SpecAmbiguity {
  description: string;
  resolvedBy: "auto" | "user";
  resolution: string;
}

export interface SpecTaskNode {
  id: string;
  description: string;
  dependsOn: string[];
  files: string[];
  kind: "design" | "implement" | "test" | "refactor" | "doc";
}

export interface SpecKeyDecision {
  id: string;
  point: string;
  options: { label: string; description: string; tradeoffs: string }[];
  chosen?: string;
  rationale?: string;
  severity: "critical" | "major" | "minor";
}

export interface SpecInitialTodo {
  taskId: string;
  content: string;
  priority: "high" | "medium" | "low";
}

// === Pipeline trace ===

export interface SpecPipelineTrace {
  stages: SpecStageTrace[];
  totalMs: number;
  hadFallback: boolean;
}

export interface SpecStageTrace {
  name: "classify" | "explore" | "draft" | "detect-decisions" | "enhance" | "persist";
  model: string;
  durationMs: number;
  fellBack: boolean;
  fallbackReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

// === Pipeline I/O types ===

export interface SpecClarifyInput {
  prompt: string;
  attachments?: AgentAttachment[];
  cwd: string;
  sessionBranch: AgentMessage[];
  modelClient: ModelClient;
  model: ModelProfile;
  toolRegistry: AgentToolRegistry;
  eventSink?: (event: AgentEvent) => void | Promise<void>;
  externalSignal?: AbortSignal;
}

export type SpecClarifyResult =
  | { action: "skip"; reason: string }
  | { action: "abort"; reason: string }
  | {
      action: "apply";
      specId: string;
      enhancedPrompt: string;
      initialTodos: SpecInitialTodo[];
      specPath: string;
    };

export interface SpecDraft {
  id: string;
  topic: string;
  understanding: SpecUnderstanding;
  taskBreakdown: SpecTaskNode[];
  keyDecisions: SpecKeyDecision[];
}

export interface ExplorerResult {
  entryPoints: string[];
  patterns: string[];
  testConventions: string;
  constraints: string[];
  relevantFiles: string[];
}

// === Configuration types ===

export interface SpecEngineOptions {
  enabled: boolean;
  autoTrigger: boolean;
  specDirectory: string;
  maxExplorationRounds: number;
  keyDecisionRules: KeyDecisionRule[];
  pipeline: SpecPipeline;
}

export interface SpecPipeline {
  classifier?: SpecStageModel;
  decisionDetector?: SpecStageModel;
  drafter?: SpecStageModel;
  enhancer?: SpecStageModel;
}

export interface SpecStageModel {
  profile: ModelProfile;
  client: ModelClient;
  fallback: "primary" | "strict" | "skip";
}

export interface KeyDecisionRule {
  name: string;
  description: string;
}

// === Dependency injection ===

export interface SpecEngineDeps {
  detectProjectType: (cwd: string) => string;
  instructions: string[];
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  listDir: (dir: string) => Promise<string[]>;
}

// === Store ===

export interface SpecStore {
  save(doc: SpecDocument): Promise<string>;
  load(specId: string): Promise<SpecDocument | undefined>;
  list(limit?: number): Promise<SpecSummary[]>;
  updateStatus(specId: string, status: SpecStatus): Promise<void>;
}

export interface SpecSummary {
  id: string;
  topic: string;
  createdAt: string;
  status: SpecStatus;
  trigger: SpecTrigger;
}
