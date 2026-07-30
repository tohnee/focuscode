import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EncryptedCredentialStore,
  OAuthClient,
  OAuthProtocolError,
  createOAuthProfile,
  discoverOAuthProfile,
  ensureFreshToken,
  type OAuthProfile,
} from "../src/index.js";

const profile: OAuthProfile = {
  id: "fixture",
  authorizationEndpoint: "https://auth.example/authorize",
  deviceAuthorizationEndpoint: "https://auth.example/device",
  tokenEndpoint: "https://auth.example/token",
  clientId: "client",
  scopes: ["models", "offline_access"],
};

describe("encrypted credential store", () => {
  it("encrypts, lists, updates and deletes token records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-auth-"));
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new EncryptedCredentialStore({
      directory,
      passphrase: "test-passphrase",
      now: () => now,
    });
    await store.set("google", "default", {
      profile: createOAuthProfile("google", { clientId: "id" }),
      token: { accessToken: "secret-token", tokenType: "Bearer", expiresAt: 123 },
    });
    const encrypted = await readFile(join(directory, "credentials.enc.json"), "utf8");
    expect(encrypted).not.toContain("secret-token");
    expect(await store.get("google")).toMatchObject({ provider: "google", account: "default" });
    expect(await store.list()).toMatchObject([{ provider: "google", expiresAt: 123 }]);
    now = new Date("2026-01-02T00:00:00Z");
    const updated = await store.set("google", "default", {
      profile: createOAuthProfile("google", { clientId: "id" }),
      token: { accessToken: "next", tokenType: "Bearer" },
    });
    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(await store.delete("google")).toBe(true);
    expect(await store.delete("google")).toBe(false);
  });

  it("creates and reuses a protected local key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-auth-key-"));
    const first = new EncryptedCredentialStore({ directory });
    await first.set("github", "work", {
      profile: createOAuthProfile("github", { clientId: "id" }),
      token: { accessToken: "abc", tokenType: "bearer" },
    });
    const second = new EncryptedCredentialStore({ directory });
    expect((await second.get("github", "work"))?.token.accessToken).toBe("abc");
  });
});

describe("OAuth protocol", () => {
  it("completes a loopback PKCE callback and ignores unrelated local requests", async () => {
    let exchanged = "";
    const client = new OAuthClient(profile, {
      fetchImplementation: async (_url, init) => {
        exchanged = String(init?.body);
        return Response.json({ access_token: "loopback-access" });
      },
    });
    const token = await client.authorizeWithLoopback({
      timeoutMs: 2_000,
      open: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl);
        const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
        expect((await fetch(new URL("/favicon.ico", redirect))).status).toBe(404);
        redirect.searchParams.set("state", authorization.searchParams.get("state")!);
        redirect.searchParams.set("code", "loopback-code");
        expect((await fetch(redirect)).status).toBe(200);
      },
    });
    expect(token.accessToken).toBe("loopback-access");
    expect(exchanged).toContain("code=loopback-code");
  });

  it("builds PKCE authorization and exchanges codes", async () => {
    let body = "";
    const client = new OAuthClient(profile, {
      now: () => 1_000,
      fetchImplementation: async (_url, init) => {
        body = String(init?.body);
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 });
      },
    });
    const request = client.createAuthorizationRequest("http://127.0.0.1:123/callback");
    expect(new URL(request.url).searchParams.get("code_challenge_method")).toBe("S256");
    const token = await client.exchangeAuthorizationCode("code", request);
    expect(body).toContain("code_verifier=");
    expect(token).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 61_000,
    });
  });

  it("polls device flow, handles pending and slow_down, then refreshes", async () => {
    let requests = 0;
    let now = 0;
    const client = new OAuthClient(profile, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      fetchImplementation: async (url) => {
        if (String(url).endsWith("/device")) {
          return Response.json({
            device_code: "device",
            user_code: "ABCD",
            verification_uri: "https://auth.example/activate",
            expires_in: 120,
            interval: 1,
          });
        }
        requests += 1;
        if (requests === 1)
          return Response.json({ error: "authorization_pending" }, { status: 400 });
        if (requests === 2) return Response.json({ error: "slow_down" }, { status: 400 });
        return Response.json({ access_token: requests === 3 ? "ready" : "fresh", expires_in: 60 });
      },
    });
    const codes: string[] = [];
    const token = await client.authorizeWithDeviceCode((authorization) =>
      codes.push(authorization.userCode),
    );
    expect(codes).toEqual(["ABCD"]);
    expect(token.accessToken).toBe("ready");
    const refreshed = await ensureFreshToken(
      { accessToken: "old", refreshToken: "refresh", tokenType: "Bearer", expiresAt: now },
      client,
      now,
    );
    expect(refreshed).toMatchObject({ accessToken: "fresh", refreshToken: "refresh" });
  });

  it("reports OAuth errors and validates profiles", async () => {
    const client = new OAuthClient(profile, {
      fetchImplementation: async () =>
        Response.json({ error: "access_denied", error_description: "No" }, { status: 400 }),
    });
    await expect(client.refresh("x")).rejects.toMatchObject<Partial<OAuthProtocolError>>({
      code: "access_denied",
      status: 400,
    });
    expect(
      () => new OAuthClient({ ...profile, tokenEndpoint: "http://bad.example/token" }),
    ).toThrow("must use HTTPS");
  });

  it("P1-I: rejects loopback HTTP with userinfo (bypass attempt)", () => {
    // `http://127.0.0.1@evil.com/token` — the old startsWith check would
    // pass this because the string starts with "http://127.0.0.1", but
    // the actual host is evil.com (userinfo = "127.0.0.1").
    expect(
      () => new OAuthClient({ ...profile, tokenEndpoint: "http://127.0.0.1@evil.com/token" }),
    ).toThrow("must use HTTPS");
    expect(
      () =>
        new OAuthClient({ ...profile, authorizationEndpoint: "http://user:pass@127.0.0.1/auth" }),
    ).toThrow("must use HTTPS");
  });

  it("P1-I: accepts loopback HTTP with port (no userinfo)", () => {
    expect(
      () => new OAuthClient({ ...profile, tokenEndpoint: "http://127.0.0.1:8765/token" }),
    ).not.toThrow();
    expect(
      () => new OAuthClient({ ...profile, tokenEndpoint: "http://localhost:8765/token" }),
    ).not.toThrow();
  });

  it("P1-I: aborts token request after 15s timeout", async () => {
    const client = new OAuthClient(profile, {
      fetchImplementation: async (_url, init) => {
        // Never resolves; the AbortController should fire after 15s.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    });
    // Note: the timeout is 15s in production code. To keep the test fast,
    // we verify the signal is wired by checking that the fetch receives a
    // signal (the abort event fires). The production timeout is tested
    // by the 15s constant in oauth.ts.
    await expect(client.refresh("x")).rejects.toThrow();
  }, 20_000);

  it("P1-I: rejects token responses exceeding 1MB", async () => {
    const huge = "x".repeat(1_100_000);
    const client = new OAuthClient(profile, {
      fetchImplementation: async () =>
        new Response(huge, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.refresh("x")).rejects.toThrow("exceeds the size ceiling");
  });

  it("discovers OIDC endpoints and supports native basic auth and revocation", async () => {
    const requests: Array<{ url: string; authorization?: string; body: string }> = [];
    const discovered = await discoverOAuthProfile(
      "enterprise",
      "https://identity.example",
      { clientId: "client", clientSecret: "secret", scopes: ["models", "offline_access"] },
      {
        fetchImplementation: async () =>
          Response.json({
            issuer: "https://identity.example",
            authorization_endpoint: "https://identity.example/authorize",
            device_authorization_endpoint: "https://identity.example/device",
            token_endpoint: "https://identity.example/token",
            revocation_endpoint: "https://identity.example/revoke",
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
          }),
      },
    );
    expect(discovered).toMatchObject({
      tokenEndpointAuthMethod: "client_secret_basic",
      revocationEndpoint: "https://identity.example/revoke",
    });
    const client = new OAuthClient(discovered, {
      fetchImplementation: async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(url),
          ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
          body: String(init?.body),
        });
        return String(url).endsWith("/revoke")
          ? new Response("", { status: 200 })
          : Response.json({ access_token: "access" });
      },
    });
    await client.refresh("refresh");
    await client.revoke("refresh", "refresh_token");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toMatch(/^Basic /);
    expect(requests[0]?.body).not.toContain("client_secret");
    expect(requests[1]?.url).toBe("https://identity.example/revoke");
  });
});
