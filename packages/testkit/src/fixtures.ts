import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  sha256Digest,
  type CertifiedModelRefV1,
  type ExecutionContextV1,
  type TaskSpecV1,
  type ToolSpecV1,
} from "@focuscode/contracts";

export async function createTestDirectory(prefix: string): Promise<string> {
  const root = join(process.cwd(), ".tmp", "tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${prefix}-`));
}

export function fixtureTask(overrides: Partial<TaskSpecV1> = {}): TaskSpecV1 {
  return {
    schemaVersion: "task-spec.v1",
    repoId: "fixture-repo",
    baseRef: "HEAD",
    mode: "change",
    objective: "Make the deterministic fixture pass",
    acceptanceCriteria: [{ id: "tests", description: "Tests pass" }],
    ...overrides,
  };
}

export function fixtureExecution(
  taskId = "fixture-task",
  overrides: Partial<ExecutionContextV1> = {},
): ExecutionContextV1 {
  return {
    schemaVersion: "execution-context.v1",
    taskId,
    tenantId: "fixture",
    actor: { id: "tester", kind: "user" },
    dataClass: "standard",
    policySnapshot: sha256Digest("fixture-policy"),
    budget: {
      maxTurns: 10,
      maxActions: 10,
      maxWallTimeMs: 60_000,
      maxChangedFiles: 10,
      maxChangedLines: 100,
    },
    traceId: "fixture-trace",
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

export function fixtureModel(): CertifiedModelRefV1 {
  const digest = sha256Digest("fixture");
  return {
    modelId: "scripted-model",
    modelRevision: digest,
    tokenizer: digest,
    chatTemplate: digest,
    modelPack: digest,
    deploymentProfile: digest,
    certificateId: "fixture-certificate",
    certifiedCapabilities: ["explore", "change"],
    riskLevel: "sandbox-only",
  };
}

export function fixtureTool(id = "fixture_read"): ToolSpecV1 {
  const inputSchema = { type: "object" };
  const outputSchema = { type: "object" };
  return {
    id,
    version: "1.0.0",
    description: "Fixture tool",
    inputSchema,
    outputSchema,
    schemaDigest: sha256Digest({ id, version: "1.0.0", inputSchema, outputSchema }),
    effectClasses: ["read"],
    idempotency: "read",
    requiredCapabilities: ["repo.read"],
  };
}
