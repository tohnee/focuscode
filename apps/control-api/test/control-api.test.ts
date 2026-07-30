import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createControlApi } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Missing address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("Control API (P1-J)", () => {
  it("fail-closed: refuses to bind non-loopback without a token", () => {
    expect(() => createControlApi({ host: "0.0.0.0", port: 0 })).toThrow(
      /non-loopback.*without a token/,
    );
  });

  it("fail-closed: refuses to bind non-loopback with empty allowInsecure", () => {
    expect(() =>
      createControlApi({ host: "0.0.0.0", port: 0, allowInsecureNonLoopback: false }),
    ).toThrow(/non-loopback.*without a token/);
  });

  it("starts on non-loopback when a token is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focus-control-api-"));
    const server = createControlApi({
      host: "0.0.0.0",
      port: 0,
      stateDirectory: dir,
      token: "secret-token",
    });
    servers.push(server);
    // We can't actually bind 0.0.0.0 in all CI envs, but the constructor
    // must NOT throw. The listen call may fail; that's OK — we only need
    // to verify the fail-closed check passed.
    expect(server).toBeDefined();
    server.close();
  });

  it("loopback bind without token: /health is open, endpoints require no auth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focus-control-api-"));
    const server = createControlApi({ stateDirectory: dir });
    servers.push(server);
    const base = await listen(server);

    const health = await fetch(base + "/health");
    expect(health.status).toBe(200);
    const tasks = await fetch(base + "/v1/tasks");
    expect(tasks.status).toBe(200);
  });

  it("token configured: /health stays open, all other endpoints require Bearer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focus-control-api-"));
    const server = createControlApi({ stateDirectory: dir, token: "secret-token" });
    servers.push(server);
    const base = await listen(server);

    // Health is always open
    const health = await fetch(base + "/health");
    expect(health.status).toBe(200);

    // Without auth → 401
    const unauthed = await fetch(base + "/v1/tasks");
    expect(unauthed.status).toBe(401);

    // With wrong token → 401
    const wrongToken = await fetch(base + "/v1/tasks", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrongToken.status).toBe(401);

    // With correct token → 200
    const authed = await fetch(base + "/v1/tasks", {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(authed.status).toBe(200);
  });

  it("token configured: /v1/contracts/task-spec requires auth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "focus-control-api-"));
    const server = createControlApi({ stateDirectory: dir, token: "t" });
    servers.push(server);
    const base = await listen(server);

    const unauthed = await fetch(base + "/v1/contracts/task-spec");
    expect(unauthed.status).toBe(401);

    const authed = await fetch(base + "/v1/contracts/task-spec", {
      headers: { authorization: "Bearer t" },
    });
    expect(authed.status).toBe(200);
  });
});
