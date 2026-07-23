import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type {
  AuthorizationRequest,
  DeviceAuthorization,
  OAuthFetchOptions,
  OAuthProfile,
  OAuthTokenSet,
} from "./types.js";

export class OAuthProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

export class OAuthClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    readonly profile: OAuthProfile,
    options: OAuthFetchOptions = {},
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    validateProfile(profile);
  }

  createAuthorizationRequest(redirectUri: string): AuthorizationRequest {
    if (!this.profile.authorizationEndpoint) {
      throw new Error(`OAuth profile ${this.profile.id} has no authorization endpoint`);
    }
    const state = randomUrlSafe(24);
    const verifier = randomUrlSafe(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(this.profile.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.profile.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", this.profile.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (this.profile.audience) url.searchParams.set("audience", this.profile.audience);
    for (const [key, value] of Object.entries(this.profile.extraAuthorizationParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return { url: url.toString(), state, verifier, redirectUri };
  }

  async authorizeWithLoopback(
    options: {
      open?: (url: string) => Promise<void> | void;
      timeoutMs?: number;
      port?: number;
    } = {},
  ): Promise<OAuthTokenSet> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const callback = await listenForCode(options.port ?? 0, timeoutMs);
    const request = this.createAuthorizationRequest(callback.redirectUri);
    callback.expectState(request.state);
    try {
      await (options.open ?? openExternal)(request.url);
      const code = await callback.code;
      return this.exchangeAuthorizationCode(code, request);
    } finally {
      callback.close();
    }
  }

  async exchangeAuthorizationCode(
    code: string,
    request: Pick<AuthorizationRequest, "verifier" | "redirectUri">,
  ): Promise<OAuthTokenSet> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: request.redirectUri,
      code_verifier: request.verifier,
    });
  }

  async requestDeviceAuthorization(): Promise<DeviceAuthorization> {
    const endpoint = this.profile.deviceAuthorizationEndpoint;
    if (!endpoint) throw new Error(`OAuth profile ${this.profile.id} has no device endpoint`);
    const value = await this.formRequest(endpoint, {
      client_id: this.profile.clientId,
      scope: this.profile.scopes.join(" "),
      ...(this.profile.audience ? { audience: this.profile.audience } : {}),
    });
    return {
      deviceCode: requiredString(value.device_code, "device_code"),
      userCode: requiredString(value.user_code, "user_code"),
      verificationUri: requiredString(
        value.verification_uri ?? value.verification_url,
        "verification_uri",
      ),
      ...(typeof value.verification_uri_complete === "string"
        ? { verificationUriComplete: value.verification_uri_complete }
        : {}),
      expiresIn: positiveNumber(value.expires_in, 900),
      interval: positiveNumber(value.interval, 5),
    };
  }

  async authorizeWithDeviceCode(
    onCode: (authorization: DeviceAuthorization) => Promise<void> | void = () => undefined,
  ): Promise<OAuthTokenSet> {
    const authorization = await this.requestDeviceAuthorization();
    await onCode(authorization);
    const deadline = this.now() + authorization.expiresIn * 1_000;
    let interval = authorization.interval * 1_000;
    while (this.now() < deadline) {
      await this.sleep(interval);
      try {
        return await this.tokenRequest({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.deviceCode,
        });
      } catch (error) {
        if (!(error instanceof OAuthProtocolError)) throw error;
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") {
          interval += 5_000;
          continue;
        }
        throw error;
      }
    }
    throw new OAuthProtocolError("Device authorization expired", "expired_token");
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    const refreshed = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
  }

  async revoke(token: string, tokenTypeHint?: "access_token" | "refresh_token"): Promise<void> {
    if (!this.profile.revocationEndpoint) {
      throw new Error(`OAuth profile ${this.profile.id} has no revocation endpoint`);
    }
    await this.formRequest(
      this.profile.revocationEndpoint,
      {
        token,
        ...(tokenTypeHint ? { token_type_hint: tokenTypeHint } : {}),
        ...this.clientAuthentication().parameters,
      },
      this.clientAuthentication().headers,
    );
  }

  private async tokenRequest(parameters: Record<string, string>): Promise<OAuthTokenSet> {
    const authentication = this.clientAuthentication();
    const value = await this.formRequest(
      this.profile.tokenEndpoint,
      {
        ...authentication.parameters,
        ...this.profile.extraTokenParams,
        ...parameters,
      },
      authentication.headers,
    );
    const accessToken = requiredString(value.access_token, "access_token");
    const expiresIn = positiveNumber(value.expires_in, 0);
    return {
      accessToken,
      tokenType: typeof value.token_type === "string" ? value.token_type : "Bearer",
      ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
      ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
      ...(expiresIn > 0 ? { expiresAt: this.now() + expiresIn * 1_000 } : {}),
      ...(typeof value.id_token === "string" ? { idToken: value.id_token } : {}),
    };
  }

  private async formRequest(
    url: string,
    parameters: Record<string, string>,
    additionalHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...additionalHeaders,
      },
      body: new URLSearchParams(parameters),
    });
    const body = await response.text();
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(body) as Record<string, unknown>;
    } catch {
      value = Object.fromEntries(new URLSearchParams(body));
    }
    const code = typeof value.error === "string" ? value.error : undefined;
    if (!response.ok || code) {
      const description =
        typeof value.error_description === "string" ? value.error_description : body.slice(0, 500);
      throw new OAuthProtocolError(
        description || `OAuth HTTP ${response.status}`,
        code ?? "http_error",
        response.status,
      );
    }
    return value;
  }

  private clientAuthentication(): {
    parameters: Record<string, string>;
    headers: Record<string, string>;
  } {
    const method =
      this.profile.tokenEndpointAuthMethod ??
      (this.profile.clientSecret ? "client_secret_post" : "none");
    if (method === "client_secret_basic") {
      if (!this.profile.clientSecret)
        throw new Error("OAuth client_secret_basic requires a secret");
      return {
        parameters: {},
        headers: {
          authorization:
            "Basic " +
            Buffer.from(`${this.profile.clientId}:${this.profile.clientSecret}`).toString("base64"),
        },
      };
    }
    return {
      parameters: {
        client_id: this.profile.clientId,
        ...(method === "client_secret_post" && this.profile.clientSecret
          ? { client_secret: this.profile.clientSecret }
          : {}),
      },
      headers: {},
    };
  }
}

export async function ensureFreshToken(
  token: OAuthTokenSet,
  client: OAuthClient,
  now = Date.now(),
): Promise<OAuthTokenSet> {
  if (!token.expiresAt || token.expiresAt - now > 60_000) return token;
  if (!token.refreshToken) throw new Error("OAuth access token expired and has no refresh token");
  return client.refresh(token.refreshToken);
}

function validateProfile(profile: OAuthProfile): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(profile.id)) throw new Error("Invalid OAuth profile id");
  for (const endpoint of [
    profile.authorizationEndpoint,
    profile.deviceAuthorizationEndpoint,
    profile.tokenEndpoint,
    profile.revocationEndpoint,
  ]) {
    if (
      endpoint &&
      new URL(endpoint).protocol !== "https:" &&
      !endpoint.startsWith("http://127.0.0.1")
    ) {
      throw new Error(`OAuth endpoint must use HTTPS: ${endpoint}`);
    }
  }
  if (!profile.clientId) throw new Error("OAuth clientId is required");
  if (
    profile.tokenEndpointAuthMethod !== undefined &&
    !["none", "client_secret_post", "client_secret_basic"].includes(profile.tokenEndpointAuthMethod)
  ) {
    throw new Error("Unsupported OAuth token endpoint auth method");
  }
}

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`OAuth response omitted ${label}`);
  return value;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function openExternal(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function listenForCode(
  port: number,
  timeoutMs: number,
): Promise<{
  redirectUri: string;
  code: Promise<string>;
  expectState(state: string): void;
  close(): void;
}> {
  let expectedState = "";
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const authorizationCode = url.searchParams.get("code");
    if (error) rejectCode(new OAuthProtocolError(error, error));
    else if (!expectedState || state !== expectedState)
      rejectCode(new Error("OAuth state mismatch"));
    else if (!authorizationCode) rejectCode(new Error("OAuth callback omitted code"));
    else resolveCode(authorizationCode);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>FocusCode</title><p>Authorization received. You may close this window.</p>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind OAuth callback");
  const timer = setTimeout(() => rejectCode(new Error("OAuth authorization timed out")), timeoutMs);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    code: code.finally(() => clearTimeout(timer)),
    expectState: (state) => {
      expectedState = state;
    },
    close: () => server.close(),
  };
}
