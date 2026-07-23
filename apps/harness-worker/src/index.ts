#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TaskSpecSchema, assertSchema, type TaskSpecV1 } from "@focuscode/contracts";
import {
  createLocalHarness,
  type ApprovalMode,
  type OpenAIHarnessOptions,
  type ScriptedStep,
} from "@focuscode/sdk";

interface WorkerJob {
  schemaVersion: "worker-job.v1";
  repoRoot: string;
  stateDirectory: string;
  taskId: string;
  task: TaskSpecV1;
  approvalMode: ApprovalMode;
  trustRepoConfig?: boolean;
  model:
    | { kind: "scripted"; steps: ScriptedStep[] }
    // Secrets never travel inside the job document: apiKeyEnv names the
    // environment variable the worker reads the real key from.
    | { kind: "openai-compatible"; modelId: string; baseUrl: string; apiKeyEnv?: string };
}

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error("Usage: harness-worker <worker-job.json>");
  const value: unknown = JSON.parse(await readFile(resolve(jobPath), "utf8"));
  if (!value || typeof value !== "object") throw new Error("Worker job must be an object");
  const job = value as WorkerJob;
  if (job.schemaVersion !== "worker-job.v1") throw new Error("Unsupported worker job version");
  assertSchema(TaskSpecSchema, job.task, "worker task");
  const common = {
    repoRoot: resolve(job.repoRoot),
    stateDirectory: resolve(job.stateDirectory),
    approvalMode: job.approvalMode,
    trustRepoConfig: job.trustRepoConfig ?? false,
  };
  const harness =
    job.model.kind === "scripted"
      ? await createLocalHarness({ ...common, model: job.model })
      : await createLocalHarness({ ...common, model: openAIModel(job.model) });
  const result = await harness.run(job.task, { taskId: job.taskId });
  process.stdout.write(
    `${JSON.stringify(
      {
        taskId: result.checkpoint.taskId,
        state: result.checkpoint.state,
        eventVersion: result.checkpoint.eventVersion,
        verification: result.verification?.conclusion,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = result.checkpoint.state === "REVIEW_READY" ? 0 : 2;
}

type OpenAIJobModel = Extract<WorkerJob["model"], { kind: "openai-compatible" }>;

/**
 * Resolve the model credential from the worker environment. A plaintext apiKey in
 * the job document is rejected outright so worker-job.json can be logged/archived
 * without becoming a secret store.
 */
function openAIModel(model: OpenAIJobModel): OpenAIHarnessOptions["model"] {
  if ("apiKey" in model && (model as { apiKey?: unknown }).apiKey !== undefined) {
    throw new Error(
      "Worker job contains a plaintext apiKey; use apiKeyEnv to name an environment variable instead",
    );
  }
  let apiKey: string | undefined;
  if (model.apiKeyEnv) {
    apiKey = process.env[model.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Worker job apiKeyEnv ${model.apiKeyEnv} is not set in the environment`);
    }
  }
  return {
    kind: "openai-compatible",
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    ...(apiKey ? { apiKey } : {}),
  };
}

main().catch((error) => {
  process.stderr.write(
    `harness-worker: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
