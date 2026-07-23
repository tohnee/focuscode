import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const repo = resolve(".tmp", "agent-demo");
await mkdir(repo, { recursive: true });
await writeFile(resolve(repo, "package.json"), '{"name":"focuscode-agent-demo","private":true}\n');

let round = 0;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) void _chunk;
  round += 1;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (round === 1) {
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "demo_write", function: { name: "write", arguments: JSON.stringify({ path: "hello.js", content: 'export const hello = "FocusCode";\n' }) } }] } }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls", delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`,
    );
  } else {
    response.write(
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop", delta: { content: "Created hello.js and confirmed the write result." } }], usage: { prompt_tokens: 140, completion_tokens: 12 } })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const { stdout, stderr } = await runCli([
    resolve(process.env.FOCUSCODE_CLI_ENTRY ?? "apps/cli/dist/index.js"),
    "-p",
    "--provider",
    "custom",
    "--model",
    "deterministic-demo",
    "--base-url",
    `http://127.0.0.1:${address.port}/v1`,
    "--approval",
    "auto-edit",
    "--sandbox",
    "host",
    "--no-session",
    "--repo",
    repo,
    "Create hello.js exporting a greeting",
  ]);
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(
    `${JSON.stringify(
      {
        demo: "PASS",
        modelRounds: round,
        repository: repo,
        file: await readFile(resolve(repo, "hello.js"), "utf8"),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function runCli(args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`CLI demo exited ${String(code)}:\n${stderr}`);
  return { stdout, stderr };
}
