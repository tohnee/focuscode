import type { OAuthDiscoveryOptions, OAuthProfile } from "./types.js";

export async function discoverOAuthProfile(
  id: string,
  issuer: string,
  input: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    audience?: string;
  },
  options: OAuthDiscoveryOptions = {},
): Promise<OAuthProfile> {
  const normalizedIssuer = validateIssuer(issuer);
  const discovery = new URL(normalizedIssuer);
  discovery.pathname = discovery.pathname.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("OIDC discovery timed out")),
    options.timeoutMs ?? 15_000,
  );
  timer.unref();
  try {
    const response = await (options.fetchImplementation ?? fetch)(discovery, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
    const source = await response.text();
    if (Buffer.byteLength(source) > 1_000_000)
      throw new Error("OIDC discovery document is too large");
    const document = JSON.parse(source) as Record<string, unknown>;
    if (normalizeIssuer(requiredUrl(document.issuer, "issuer")) !== normalizedIssuer) {
      throw new Error("OIDC discovery issuer does not match the requested issuer");
    }
    const methods = Array.isArray(document.token_endpoint_auth_methods_supported)
      ? document.token_endpoint_auth_methods_supported.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const tokenEndpointAuthMethod = selectAuthMethod(methods, Boolean(input.clientSecret));
    return {
      id,
      authorizationEndpoint: requiredUrl(document.authorization_endpoint, "authorization_endpoint"),
      ...(typeof document.device_authorization_endpoint === "string"
        ? {
            deviceAuthorizationEndpoint: requiredUrl(
              document.device_authorization_endpoint,
              "device_authorization_endpoint",
            ),
          }
        : {}),
      tokenEndpoint: requiredUrl(document.token_endpoint, "token_endpoint"),
      ...(typeof document.revocation_endpoint === "string"
        ? { revocationEndpoint: requiredUrl(document.revocation_endpoint, "revocation_endpoint") }
        : {}),
      clientId: input.clientId,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      tokenEndpointAuthMethod,
      scopes: input.scopes?.length ? [...input.scopes] : ["openid", "profile", "offline_access"],
      ...(input.audience ? { audience: input.audience } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

function validateIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("OIDC issuer must be an HTTPS URL without credentials, query, or fragment");
  }
  return normalizeIssuer(url.toString());
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/$/, "");
}

function requiredUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`OIDC discovery omitted ${label}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`OIDC ${label} must use HTTPS without credentials`);
  }
  return url.toString();
}

function selectAuthMethod(
  supported: string[],
  hasSecret: boolean,
): "none" | "client_secret_post" | "client_secret_basic" {
  if (hasSecret && supported.includes("client_secret_basic")) return "client_secret_basic";
  if (hasSecret && (supported.length === 0 || supported.includes("client_secret_post"))) {
    return "client_secret_post";
  }
  if (supported.length === 0 || supported.includes("none")) return "none";
  throw new Error("OIDC provider does not support a compatible token endpoint auth method");
}
