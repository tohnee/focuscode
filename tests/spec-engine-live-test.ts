/**
 * SpecEngine Live Integration Test — GLM (智谱) or ARK (火山方舟) API
 *
 * Verifies the full 5-stage SpecEngine clarification pipeline
 * (classifier → explorer → drafter → decision-detector → enhancer)
 * against real API calls. Supports two OpenAI-compatible providers:
 *   - ARK (火山方舟, https://ark.cn-beijing.volces.com): glm-5.2, deepseek-v4-pro
 *   - ZAI (智谱 direct, https://open.bigmodel.cn): glm-5.2
 *
 * Usage:
 *   ARK_API_KEY=<key> npx tsx tests/spec-engine-live-test.ts
 *   # or
 *   ZAI_API_KEY=<key> npx tsx tests/spec-engine-live-test.ts
 *
 * The script exits 0 on success, 1 on failure, and 2 (skip) when the API
 * key is missing — so it can be gated in CI.
 *
 * This is a standalone diagnostic script, NOT a vitest test. It lives under
 * tests/ alongside other process-level entrypoint checks.
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  readdir as fsReaddir,
} from "node:fs/promises";
import { mkdir as fsMkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createModelClient,
  createCodingToolRegistry,
  SpecEngine,
  type AgentEvent,
  type AgentMessage,
  type ModelProfile,
  type SpecClarifyInput,
  type SpecEngineDeps,
  type SpecEngineOptions,
  type SpecStageModel,
} from "@focuscode/agent-runtime";

// === Provider configuration ===
// Supports both ZAI (智谱 GLM direct API) and ARK (火山方舟 OpenAI-compatible).
// ARK provides OpenAI-compatible endpoint serving glm-5.2 and deepseek-v4-pro.

const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ARK_API_KEY_ENV = "ARK_API_KEY";
const ARK_MODEL = "glm-5.2";

const ZAI_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_API_KEY_ENV = "ZAI_API_KEY";
const ZAI_MODEL = "glm-5.2";

const GLM_SPEC_DIRECTORY = "docs/specs";

function resolveProvider(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiKeyEnv: string;
  flavor: "ark" | "zai";
} {
  const arkKey = process.env[ARK_API_KEY_ENV];
  if (arkKey) {
    return {
      baseUrl: ARK_BASE_URL,
      apiKey: arkKey,
      model: process.env.ARK_MODEL ?? ARK_MODEL,
      apiKeyEnv: ARK_API_KEY_ENV,
      flavor: "ark",
    };
  }
  const zaiKey = process.env[ZAI_API_KEY_ENV];
  if (zaiKey) {
    return {
      baseUrl: ZAI_BASE_URL,
      apiKey: zaiKey,
      model: ZAI_MODEL,
      apiKeyEnv: ZAI_API_KEY_ENV,
      flavor: "zai",
    };
  }
  return {
    baseUrl: "",
    apiKey: "",
    model: "",
    apiKeyEnv: `${ARK_API_KEY_ENV} or ${ZAI_API_KEY_ENV}`,
    flavor: "ark",
  };
}

// A realistic feature prompt exercising the full pipeline. Adding a sandbox
// backend is a multi-file, design-heavy task that should trigger all stages.
const TEST_PROMPT =
  "/spec Add a Firecracker microVM sandbox backend to packages/sandbox, " +
  "integrating with the existing SandboxExecutor interface and supporting " +
  "the auto fallback chain (gVisor → Docker → Firecracker → Host).";

interface StageTiming {
  name: string;
  model: string;
  durationMs: number;
  fellBack: boolean;
}

interface LiveTestReport {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  prompt: string;
  model: string;
  action: string;
  stages: StageTiming[];
  specId?: string;
  specPath?: string;
  enhancedPromptLength?: number;
  initialTodoCount?: number;
  eventCount: number;
  eventTypes: string[];
  errors: string[];
  warnings: string[];
}

async function main(): Promise<void> {
  const report = await runLiveTest();
  printReport(report);
  const ok = report.errors.length === 0 && report.action === "apply";
  process.exit(ok ? 0 : 1);
}

async function runLiveTest(): Promise<LiveTestReport> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const events: AgentEvent[] = [];

  // === 1. Resolve provider + API key ===
  const provider = resolveProvider();
  if (!provider.apiKey) {
    process.stderr.write(
      `\n[SKIP] No API key found. Set ${provider.apiKeyEnv} to run the live integration test.\n` +
        `        export ${provider.apiKeyEnv}=<your-key>\n` +
        `        npx tsx tests/spec-engine-live-test.ts\n\n`,
    );
    process.exit(2);
  }

  // === 2. Build ModelProfile (ARK uses standard OpenAI compat; ZAI uses zai thinkingFormat) ===
  const cwd = process.cwd();
  const profile = buildProfile(provider);

  // === 3. Build ModelClient (OpenAI-compatible) ===
  const client = createModelClient({
    protocol: "openai-chat",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(profile.compatibility ? { compatibility: profile.compatibility } : {}),
    reliability: profile.reliability,
    timeoutMs: 120_000,
  });

  // === 4. Build tool registry (read-only tools used by explorer) ===
  const toolRegistry = await createCodingToolRegistry(cwd);

  // === 5. Build SpecEngineOptions ===
  // All pipeline stages use the same GLM model; fallback "primary" means
  // if a stage model fails, it retries with the main model (same here).
  const stageModel: SpecStageModel = { profile, client, fallback: "primary" };
  const options: SpecEngineOptions = {
    enabled: true,
    autoTrigger: true,
    specDirectory: GLM_SPEC_DIRECTORY,
    maxExplorationRounds: 3,
    keyDecisionRules: [
      { name: "api-surface", description: "Any change to a public API or export signature" },
      {
        name: "security-boundary",
        description: "Changes touching sandbox isolation or permission model",
      },
      { name: "data-persistence", description: "Schema or format changes to stored data" },
    ],
    pipeline: {
      classifier: stageModel,
      drafter: stageModel,
      decisionDetector: stageModel,
      enhancer: stageModel,
    },
  };

  // === 6. Build SpecEngineDeps (real filesystem) ===
  const deps = buildRealDeps();

  // === 7. Construct SpecEngine ===
  const engine = new SpecEngine(options, deps);

  // === 8. Build clarify input ===
  // Auto-resolve blocking decisions: when the pipeline emits
  // spec_confirmation_required, defer the resolution to a macrotask so the
  // engine's waitForConfirmation() has time to register its resolver first.
  const input: SpecClarifyInput = {
    prompt: TEST_PROMPT,
    cwd,
    sessionBranch: [] as AgentMessage[],
    modelClient: client,
    model: profile,
    toolRegistry,
    eventSink: (event: AgentEvent) => {
      events.push(event);
      logEvent(event);
      if (event.type === "spec_confirmation_required") {
        const specId = event.specId;
        const decisions = event.decisions;
        setTimeout(() => {
          const choices: Record<string, string> = {};
          for (const decision of decisions) {
            if (decision.options.length > 0) {
              choices[decision.id] = decision.options[0]!.label;
              warnings.push(
                `auto-resolved decision "${decision.point}" → ${decision.options[0]!.label}`,
              );
            }
          }
          engine.resolveDecisions(specId, choices);
        }, 100);
      }
    },
  };

  // === 9. Run clarify with a generous timeout ===
  process.stderr.write("\n=== SpecEngine Live Integration Test ===\n");
  process.stderr.write(`Prompt:   ${TEST_PROMPT}\n`);
  process.stderr.write(`Provider: ${profile.provider}/${profile.model} (${provider.flavor})\n`);
  process.stderr.write(`Endpoint: ${provider.baseUrl}\n\n`);
  process.stderr.write("Running 5-stage pipeline...\n\n");

  let action = "error";
  let specId: string | undefined;
  let specPath: string | undefined;
  let enhancedPromptLength: number | undefined;
  let initialTodoCount: number | undefined;

  try {
    const result = await withTimeout(engine.clarify(input), 300_000, "clarify");
    action = result.action;
    if (result.action === "apply") {
      specId = result.specId;
      specPath = result.specPath;
      enhancedPromptLength = result.enhancedPrompt.length;
      initialTodoCount = result.initialTodos.length;
    } else {
      const reason = "reason" in result ? result.reason : "";
      errors.push(`Pipeline returned action="${action}" reason="${reason}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`clarify() threw: ${message}`);
    action = "error";
  }

  // === 10. Extract stage timings from spec_stage events ===
  const stages: StageTiming[] = events
    .filter((e): e is Extract<AgentEvent, { type: "spec_stage" }> => e.type === "spec_stage")
    .map((e) => ({
      name: e.stage,
      model: e.model,
      durationMs: e.durationMs,
      fellBack: e.fellBack,
    }));

  // === 11. Validate stage coverage ===
  // classify is skipped when the prompt is forced (starts with "/spec"),
  // because the user explicitly requested spec mode — no intent classification
  // needed. explore/draft/detect-decisions/enhance are always required.
  const requiredStages = ["explore", "draft", "detect-decisions", "enhance"];
  for (const expected of requiredStages) {
    if (!stages.some((s) => s.name === expected)) {
      errors.push(`missing spec_stage event for stage: ${expected}`);
    }
  }
  if (!TEST_PROMPT.startsWith("/spec") && !stages.some((s) => s.name === "classify")) {
    errors.push("missing spec_stage event for stage: classify (non-forced prompt)");
  }

  // === 12. Validate spec document persistence ===
  if (specPath) {
    try {
      const content = await fsReadFile(specPath, "utf8");
      if (!content.includes("id:")) {
        errors.push(`spec file at ${specPath} missing frontmatter id`);
      }
    } catch (error) {
      errors.push(
        `failed to read spec file ${specPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (action === "apply") {
    errors.push("action was apply but specPath was empty");
  }

  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    totalMs: Date.now() - startTime,
    prompt: TEST_PROMPT,
    model: `${profile.provider}/${profile.model}`,
    action,
    stages,
    ...(specId ? { specId } : {}),
    ...(specPath ? { specPath } : {}),
    ...(enhancedPromptLength !== undefined ? { enhancedPromptLength } : {}),
    ...(initialTodoCount !== undefined ? { initialTodoCount } : {}),
    eventCount: events.length,
    eventTypes: events.map((e) => e.type),
    errors,
    warnings,
  };
}

function buildProfile(provider: {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiKeyEnv: string;
  flavor: "ark" | "zai";
}): ModelProfile {
  const isZai = provider.flavor === "zai";
  return {
    provider: isZai ? "glm-cn" : "ark",
    model: provider.model,
    protocol: "openai-chat",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyEnv: provider.apiKeyEnv,
    authType: "bearer",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    temperature: 0.2,
    toolMode: "native",
    reasoningEffort: "high",
    capabilities: { input: ["text"], reasoning: true, toolCalling: true },
    // ARK exposes a plain OpenAI-compatible surface (no zai thinking format).
    // ZAI (智谱 direct) supports the zai thinking format and reasoning effort.
    ...(isZai
      ? {
          compatibility: {
            thinkingFormat: "zai" as const,
            supportsReasoningEffort: true,
            zaiToolStream: true,
          },
        }
      : {}),
    reliability: {
      timeoutMs: 120_000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
      retryMaximumDelayMs: 10_000,
    },
  };
}

function buildRealDeps(): SpecEngineDeps {
  return {
    detectProjectType: () => "typescript-monorepo",
    instructions: [],
    async writeFile(path, content) {
      // Ensure parent directory exists before writing (SpecStoreImpl.save does
      // not create directories — it relies on the caller or the dep injection
      // to provide a writable directory).
      const lastSlash = path.lastIndexOf("/");
      if (lastSlash > 0) {
        await fsMkdir(path.slice(0, lastSlash), { recursive: true }).catch(() => {});
      }
      await fsWriteFile(path, content, "utf8");
    },
    async readFile(path) {
      try {
        return await fsReadFile(path, "utf8");
      } catch {
        return "";
      }
    },
    async listDir(dir) {
      try {
        return await fsReaddir(dir);
      } catch {
        return [];
      }
    },
  };
}

function logEvent(event: AgentEvent): void {
  switch (event.type) {
    case "spec_start":
      process.stderr.write(`  [stage 0] spec_start (trigger: ${event.trigger})\n`);
      break;
    case "spec_skipped":
      process.stderr.write(`  [skip] ${event.reason}\n`);
      break;
    case "spec_stage":
      process.stderr.write(
        `  [stage] ${event.stage} — model=${event.model} ${event.durationMs}ms` +
          `${event.fellBack ? " (FELL BACK)" : ""}\n`,
      );
      break;
    case "spec_draft_ready":
      process.stderr.write(`  [draft] id=${event.specId} topic="${event.topic}"\n`);
      break;
    case "spec_confirmation_required":
      process.stderr.write(
        `  [confirm] specId=${event.specId} decisions=${event.decisions.length}\n`,
      );
      break;
    case "spec_confirmed":
      process.stderr.write(`  [confirmed] specId=${event.specId}\n`);
      break;
    case "spec_completed":
      process.stderr.write(`  [completed] specId=${event.specId}\n`);
      break;
    default:
      process.stderr.write(`  [event] ${event.type}\n`);
  }
}

function printReport(report: LiveTestReport): void {
  process.stderr.write("\n=== Live Integration Test Report ===\n\n");
  process.stderr.write(`Started:    ${report.startedAt}\n`);
  process.stderr.write(`Finished:   ${report.finishedAt}\n`);
  process.stderr.write(`Total time: ${report.totalMs}ms\n`);
  process.stderr.write(`Model:      ${report.model}\n`);
  process.stderr.write(`Action:     ${report.action}\n\n`);

  process.stderr.write("--- Pipeline Stages ---\n");
  for (const stage of report.stages) {
    process.stderr.write(
      `  ${stage.name.padEnd(20)} ${String(stage.durationMs).padStart(6)}ms  ` +
        `model=${stage.model}${stage.fellBack ? "  (FELL BACK)" : ""}\n`,
    );
  }
  process.stderr.write("\n");

  if (report.specId) process.stderr.write(`Spec ID:    ${report.specId}\n`);
  if (report.specPath) process.stderr.write(`Spec path:  ${report.specPath}\n`);
  if (report.enhancedPromptLength !== undefined)
    process.stderr.write(`Enhanced prompt length: ${report.enhancedPromptLength} chars\n`);
  if (report.initialTodoCount !== undefined)
    process.stderr.write(`Initial todos: ${report.initialTodoCount}\n`);
  process.stderr.write(`Events captured: ${report.eventCount}\n`);
  process.stderr.write(`Event types: ${report.eventTypes.join(", ")}\n\n`);

  if (report.warnings.length > 0) {
    process.stderr.write("--- Warnings ---\n");
    for (const w of report.warnings) process.stderr.write(`  ⚠ ${w}\n`);
    process.stderr.write("\n");
  }

  if (report.errors.length > 0) {
    process.stderr.write("--- Errors ---\n");
    for (const e of report.errors) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write("\n");
    process.stderr.write("Result: FAIL\n\n");
  } else {
    process.stderr.write("Result: PASS\n\n");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Run only when executed directly (not imported)
const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `\nFatal error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

export { runLiveTest, buildProfile, buildRealDeps, type LiveTestReport };
