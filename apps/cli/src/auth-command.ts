import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  EncryptedCredentialStore,
  OAuthClient,
  createOAuthProfile,
  discoverOAuthProfile,
  ensureFreshToken,
  type OAuthProfile,
} from "@focuscode/auth";
import type { ModelProfile } from "@focuscode/agent-runtime";

export async function runAuthCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const store = credentialStore();
  const account = parsed.options.get("account") ?? "default";
  if (parsed.action === "list" || parsed.action === "status") {
    const credentials = await store.list();
    if (!credentials.length) {
      process.stdout.write("No OAuth credentials stored.\n");
      return;
    }
    for (const credential of credentials) {
      const expiry = credential.expiresAt
        ? new Date(credential.expiresAt).toISOString()
        : "non-expiring";
      process.stdout.write(
        credential.provider +
          "\t" +
          credential.account +
          "\t" +
          expiry +
          "\t" +
          credential.profile.scopes.join(" ") +
          "\n",
      );
    }
    return;
  }
  if (parsed.action === "logout") {
    const provider = required(parsed.positionals[0], "auth logout requires <provider>");
    if (parsed.flags.has("revoke")) {
      const credential = await store.get(provider, account);
      if (credential) {
        const token = credential.token.refreshToken ?? credential.token.accessToken;
        await new OAuthClient(credential.profile).revoke(
          token,
          credential.token.refreshToken ? "refresh_token" : "access_token",
        );
      }
    }
    process.stdout.write(
      (await store.delete(provider, account))
        ? "Removed OAuth credential.\n"
        : "OAuth credential was not found.\n",
    );
    return;
  }
  if (parsed.action !== "login") throw new Error("Usage: focuscode auth login|list|logout");
  const provider = required(parsed.positionals[0], "auth login requires <provider>");
  const clientId = required(
    parsed.options.get("client-id") ?? process.env[clientIdEnvironment(provider)],
    "OAuth login requires --client-id or provider client-id environment",
  );
  const scopes = (parsed.options.get("scope") ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  // SECURITY (SECURITY.md): the client secret must never be accepted as a CLI
  // argument — it leaks into shell history and `ps` output. Env var only.
  if (parsed.options.has("client-secret")) {
    throw new Error(
      "--client-secret is not accepted (it leaks into shell history and process listings); set " +
        clientSecretEnvironment(provider) +
        " instead",
    );
  }
  const clientSecret = process.env[clientSecretEnvironment(provider)];
  const profile = parsed.options.get("issuer")
    ? await discoverOAuthProfile(provider, parsed.options.get("issuer")!, {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(scopes.length ? { scopes } : {}),
        ...(parsed.options.get("audience") ? { audience: parsed.options.get("audience")! } : {}),
      })
    : provider === "google" || provider === "github"
      ? createOAuthProfile(provider, {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          ...(scopes.length ? { scopes } : {}),
        })
      : customProfile(provider, clientId, scopes, parsed.options);
  const client = new OAuthClient(profile);
  const token = parsed.flags.has("device")
    ? await client.authorizeWithDeviceCode((authorization) => {
        process.stdout.write(
          "Open " +
            (authorization.verificationUriComplete ?? authorization.verificationUri) +
            "\nEnter code: " +
            authorization.userCode +
            "\n",
        );
      })
    : await client.authorizeWithLoopback({
        ...(parsed.flags.has("no-browser")
          ? {
              open: (url: string) => {
                process.stdout.write("Open this URL in a browser:\n" + url + "\n");
              },
            }
          : {}),
      });
  await store.set(provider, account, { profile, token });
  process.stdout.write(
    "OAuth login stored for " + provider + "/" + account + ". Tokens were not printed.\n",
  );
}

export function oauthAccessTokenProvider(
  model: ModelProfile,
): (() => Promise<string | undefined>) | undefined {
  if (!model.oauthAccount) return undefined;
  const account = model.oauthAccount;
  const store = credentialStore();
  return async () => {
    const credential = await store.get(model.provider, account);
    if (!credential) {
      throw new Error(
        "OAuth credential not found for " +
          model.provider +
          "/" +
          account +
          "; run focuscode auth login",
      );
    }
    const client = new OAuthClient(credential.profile);
    const fresh = await ensureFreshToken(credential.token, client);
    if (fresh !== credential.token) {
      await store.set(model.provider, account, {
        profile: credential.profile,
        token: fresh,
      });
    }
    return fresh.accessToken;
  };
}

function credentialStore(): EncryptedCredentialStore {
  return new EncryptedCredentialStore({
    directory: resolve(
      process.env.FOCUSCODE_AUTH_DIRECTORY ?? join(homedir(), ".focuscode", "auth"),
    ),
    ...(process.env.FOCUSCODE_CREDENTIAL_PASSPHRASE
      ? { passphrase: process.env.FOCUSCODE_CREDENTIAL_PASSPHRASE }
      : {}),
  });
}

function customProfile(
  provider: string,
  clientId: string,
  scopes: string[],
  options: Map<string, string>,
): OAuthProfile {
  const deviceUrl = options.get("device-url");
  // The client secret comes only from FOCUSCODE_<PROVIDER>_CLIENT_SECRET;
  // --client-secret is rejected before customProfile is reached.
  const clientSecret = process.env[clientSecretEnvironment(provider)];
  const audience = options.get("audience");
  return {
    id: provider,
    authorizationEndpoint: required(
      options.get("authorization-url"),
      "Custom OAuth requires --authorization-url",
    ),
    ...(deviceUrl ? { deviceAuthorizationEndpoint: deviceUrl } : {}),
    tokenEndpoint: required(options.get("token-url"), "Custom OAuth requires --token-url"),
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes,
    ...(audience ? { audience } : {}),
  };
}

function clientIdEnvironment(provider: string): string {
  return "FOCUSCODE_" + provider.toUpperCase().replaceAll("-", "_") + "_CLIENT_ID";
}

function clientSecretEnvironment(provider: string): string {
  return "FOCUSCODE_" + provider.toUpperCase().replaceAll("-", "_") + "_CLIENT_SECRET";
}

function parse(argv: string[]): {
  action: string;
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
} {
  const [action = "list", ...tokens] = argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const boolean = new Set(["device", "no-browser", "revoke"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=", 2);
    if (!key) throw new Error("Invalid auth option");
    if (boolean.has(key)) {
      flags.add(key);
      continue;
    }
    const value = inline ?? tokens[++index];
    if (!value) throw new Error("--" + key + " requires a value");
    options.set(key, value);
  }
  return { action, positionals, options, flags };
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
