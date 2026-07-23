import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";

describe("built process entrypoints", () => {
  it("exposes an actionable CLI help surface", () => {
    const result = spawnSync(process.execPath, [resolve("apps/cli/dist/index.js"), "help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FocusCode CLI Coding Agent");
    expect(result.stdout).toContain("interactive | print | json | rpc");
    expect(result.stdout).toContain("focuscode init | run | inspect | export");
  });

  it("executes a complete print-mode coding turn through an OpenAI-compatible stream", async () => {
    const repo = await createTestDirectory("process-cli-agent");
    let requests = 0;
    const server = createHttpServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString("utf8");
      const payload = JSON.parse(body) as { messages: Array<{ role: string }> };
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests === 1) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: JSON.stringify({ path: "hello.txt", content: "hello from cli\n" }) } }] } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`,
        );
      } else {
        expect(payload.messages.map((message) => message.role)).toContain("tool");
        response.write(
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: { content: "Created and verified hello.txt." } }], usage: { prompt_tokens: 30, completion_tokens: 6 } })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const result = await runProcess(resolve("apps/cli/dist/index.js"), [
        "-p",
        "--provider",
        "custom",
        "--model",
        "fixture",
        "--base-url",
        `http://127.0.0.1:${address.port}/v1`,
        "--approval",
        "auto-edit",
        "--sandbox",
        "host",
        "--no-session",
        "--repo",
        repo,
        "create hello.txt",
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Created and verified hello.txt.");
      expect(await readFile(join(repo, "hello.txt"), "utf8")).toBe("hello from cli\n");
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("serves Control API health and canonical TaskSpec validation", async () => {
    const port = await freePort();
    await withProcess(
      resolve("apps/control-api/dist/index.js"),
      {
        FOCUSCODE_CONTROL_PORT: String(port),
        FOCUSCODE_STATE_DIR: resolve(".tmp", "process-control-state"),
      },
      `http://127.0.0.1:${port}/health`,
      async () => {
        const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        expect(health).toMatchObject({ status: "ok", component: "focuscode-control-api" });
        const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/validate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: "task-spec.v1",
            repoId: "repo",
            baseRef: "HEAD",
            mode: "explore",
            objective: "Inspect",
            acceptanceCriteria: [],
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ valid: true });
      },
    );
  });

  it("publishes the Action Runtime tool manifest without exposing execution", async () => {
    const port = await freePort();
    await withProcess(
      resolve("apps/action-runtime/dist/index.js"),
      {
        FOCUSCODE_ACTION_PORT: String(port),
        FOCUSCODE_REPO_ROOT: resolve("examples/demo-repo"),
      },
      `http://127.0.0.1:${port}/health`,
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/tools`);
        const body = (await response.json()) as { tools: Array<{ id: string }> };
        expect(body.tools.map((tool) => tool.id)).toContain("apply_edit_ir");
        const execute = await fetch(`http://127.0.0.1:${port}/v1/actions`, { method: "POST" });
        expect(execute.status).toBe(404);
      },
    );
  });
});

describe("harness-worker job secrets", () => {
  it("rejects a worker job carrying a plaintext apiKey", async () => {
    const directory = await createTestDirectory("process-worker-plain");
    const secret = "sk-plaintext-do-not-leak-0123456789";
    const jobPath = await writeWorkerJob(directory, { apiKey: secret });
    const result = await runProcess(resolve("apps/harness-worker/dist/index.js"), [jobPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("apiKeyEnv");
    expect(result.stderr + result.stdout).not.toContain(secret);
  });

  it("fails closed when apiKeyEnv names an unset environment variable", async () => {
    const directory = await createTestDirectory("process-worker-unset");
    const jobPath = await writeWorkerJob(directory, {
      apiKeyEnv: "FOCUSCODE_WORKER_TEST_UNSET_KEY",
    });
    const result = await runProcess(resolve("apps/harness-worker/dist/index.js"), [jobPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FOCUSCODE_WORKER_TEST_UNSET_KEY");
  });

  it("resolves the model key from apiKeyEnv and keeps it out of the summary", async () => {
    const directory = await createTestDirectory("process-worker-env");
    const secret = "sk-worker-env-secret-0123456789abcdef";
    let authorization: string | undefined;
    const server = createHttpServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  kind: "completion_candidate",
                  summary: "Task is complete.",
                  evidence: [],
                  residualRisks: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const jobPath = await writeWorkerJob(directory, {
        apiKeyEnv: "FOCUSCODE_WORKER_TEST_KEY",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const result = await runProcess(resolve("apps/harness-worker/dist/index.js"), [jobPath], {
        FOCUSCODE_WORKER_TEST_KEY: secret,
      });
      expect(result.code).toBe(0);
      expect(authorization).toBe(`Bearer ${secret}`);
      expect(JSON.parse(result.stdout)).toMatchObject({
        taskId: "worker-test-task",
        state: "REVIEW_READY",
      });
      expect(result.stdout + result.stderr).not.toContain(secret);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

async function writeWorkerJob(directory: string, model: Record<string, unknown>): Promise<string> {
  await mkdir(join(directory, ".focuscode"), { recursive: true });
  await writeFile(
    join(directory, ".focuscode", "config.json"),
    JSON.stringify({
      schemaVersion: "focuscode-repo.v1",
      protectedPaths: [],
      commands: [{ id: "verify", argv: ["/usr/bin/true"] }],
      verificationCommandIds: ["verify"],
    }),
  );
  const jobPath = join(directory, "worker-job.json");
  await writeFile(
    jobPath,
    JSON.stringify({
      schemaVersion: "worker-job.v1",
      repoRoot: directory,
      stateDirectory: join(directory, "state"),
      taskId: "worker-test-task",
      task: {
        schemaVersion: "task-spec.v1",
        repoId: "repo",
        baseRef: "HEAD",
        mode: "explore",
        objective: "Inspect the repository",
        acceptanceCriteria: [],
      },
      approvalMode: "deny",
      trustRepoConfig: true,
      model: {
        kind: "openai-compatible",
        modelId: "fixture",
        baseUrl: "http://127.0.0.1:9/v1",
        ...model,
      },
    }),
  );
  return jobPath;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function runProcess(
  entrypoint: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { code, stdout, stderr };
}

async function withProcess(
  entrypoint: string,
  environment: Record<string, string>,
  healthUrl: string,
  operation: () => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => (diagnostics += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (diagnostics += chunk.toString("utf8")));
  try {
    await waitForHealth(child, healthUrl, () => diagnostics);
    await operation();
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", () => resolveExit());
    });
  }
}

async function waitForHealth(
  child: ChildProcess,
  healthUrl: string,
  diagnostics: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Process exited early:\n${diagnostics()}`);
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // Retry while the local process binds its loopback socket.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${healthUrl}:\n${diagnostics()}`);
}
