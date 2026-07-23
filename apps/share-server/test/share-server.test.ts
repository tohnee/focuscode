import { mkdtemp } from "node:fs/promises";
import { createHash, createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { SessionShareService } from "@focuscode/ecosystem";
import { createShareServer } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("share server", () => {
  it("stores immutable signed bundles and serves them with auth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-share-server-"));
    const server = createShareServer({ directory, token: "test-token" });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const base = "http://127.0.0.1:" + address.port;
    expect((await fetch(base + "/health")).status).toBe(200);
    expect((await fetch(base + "/v1/shares/share_missing")).status).toBe(401);
    const bundle = await new SessionShareService({
      identityDirectory: join(directory, "identity"),
    }).create({ header: { cwd: "/repo" }, entries: [] });
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const invalid = await fetch(base + "/v1/shares", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...bundle, workspaceHint: "tampered" }),
    });
    expect(invalid.status).toBe(400);
    const created = await fetch(base + "/v1/shares", {
      method: "POST",
      headers,
      body: JSON.stringify(bundle),
    });
    expect(created.status).toBe(201);
    expect((await created.json()) as object).toMatchObject({ id: bundle.shareId });
    const duplicate = await fetch(base + "/v1/shares", {
      method: "POST",
      headers,
      body: JSON.stringify(bundle),
    });
    expect(duplicate.status).toBe(409);
    const downloaded = await fetch(base + "/v1/shares/" + bundle.shareId, { headers });
    expect(await downloaded.json()).toMatchObject(bundle);
  });

  it("fails closed on identity, signer trust, expiry and request rate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-share-policy-"));
    const trustedService = new SessionShareService({
      identityDirectory: join(directory, "trusted-identity"),
    });
    const trusted = await trustedService.create({ header: { cwd: "/repo" }, entries: [] });
    const fingerprint =
      "sha256:" +
      createHash("sha256")
        .update(createPublicKey(trusted.signer.publicKey).export({ type: "spki", format: "der" }))
        .digest("hex");
    const untrusted = await new SessionShareService({
      identityDirectory: join(directory, "untrusted-identity"),
    }).create({ header: { cwd: "/repo" }, entries: [] });
    const expired = await new SessionShareService({
      identityDirectory: join(directory, "trusted-identity"),
      now: () => new Date("2020-01-01T00:00:00Z"),
    }).create({ header: { cwd: "/repo" }, entries: [] });
    const server = createShareServer({
      directory: join(directory, "storage"),
      token: "enterprise-token",
      requireAuthentication: true,
      trustedSignerFingerprints: [fingerprint],
      maxShareAgeMs: 86_400_000,
      rateLimit: { maximum: 3, windowMs: 60_000 },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const base = "http://127.0.0.1:" + address.port;
    expect((await fetch(base + "/v1/shares")).status).toBe(401);
    const headers = {
      authorization: "Bearer enterprise-token",
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(base + "/v1/shares", {
          method: "POST",
          headers,
          body: JSON.stringify(untrusted),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + "/v1/shares", {
          method: "POST",
          headers,
          body: JSON.stringify(expired),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + "/v1/shares", {
          method: "POST",
          headers,
          body: JSON.stringify(trusted),
        })
      ).status,
    ).toBe(201);
    expect((await fetch(base + "/v1/shares/" + trusted.shareId, { headers })).status).toBe(429);
  });
});
