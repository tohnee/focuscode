import type { OAuthProfile } from "./types.js";

export interface OAuthProfileInput {
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}

export function createOAuthProfile(
  id: "google" | "github",
  input: OAuthProfileInput,
): OAuthProfile {
  if (id === "google") {
    return {
      id,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      deviceAuthorizationEndpoint: "https://oauth2.googleapis.com/device/code",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId: input.clientId,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      scopes: input.scopes ?? ["https://www.googleapis.com/auth/generative-language"],
      extraAuthorizationParams: { access_type: "offline", prompt: "consent" },
    };
  }
  return {
    id,
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    deviceAuthorizationEndpoint: "https://github.com/login/device/code",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    scopes: input.scopes ?? ["read:user"],
  };
}

export function customOAuthProfile(profile: OAuthProfile): OAuthProfile {
  return structuredClone(profile);
}
