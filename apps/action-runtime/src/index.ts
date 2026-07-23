#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  SafeCommandRunner,
  WorkspaceGuard,
  createLocalToolRegistry,
} from "@focuscode/action-backends";
import { buildRepoProfile } from "@focuscode/context-compiler";

const repoRoot = resolve(process.env.FOCUSCODE_REPO_ROOT ?? process.cwd());
const host = process.env.FOCUSCODE_ACTION_HOST ?? "127.0.0.1";
const port = Number(process.env.FOCUSCODE_ACTION_PORT ?? "4318");
const workspace = await WorkspaceGuard.create(repoRoot);
const profile = await buildRepoProfile(repoRoot);
const runner = new SafeCommandRunner(profile.commands, { cwd: repoRoot });
const registry = createLocalToolRegistry(workspace, runner);

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`).pathname;
  const body =
    path === "/health"
      ? { status: "ok", component: "focuscode-action-runtime", mode: "manifest-only" }
      : path === "/v1/tools"
        ? { tools: registry.specs() }
        : { error: "not_found" };
  const status = "error" in body ? 404 : 200;
  const json = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  response.end(json);
});

server.listen(port, host, () => {
  process.stdout.write(`FocusCode Action Runtime manifest endpoint: http://${host}:${port}\n`);
  process.stdout.write(
    "Action execution remains in-process until workload auth and signed grants land.\n",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
