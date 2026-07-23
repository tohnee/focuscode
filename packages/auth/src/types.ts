export interface OAuthProfile {
  id: string;
  authorizationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
  scopes: string[];
  audience?: string;
  extraAuthorizationParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: number;
  idToken?: string;
}

export interface StoredCredential {
  provider: string;
  account: string;
  token: OAuthTokenSet;
  profile: OAuthProfile;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export interface OAuthFetchOptions {
  fetchImplementation?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface OAuthDiscoveryOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}
