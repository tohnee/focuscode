import type { ApprovalMode, ModelProfile } from "@focuscode/agent-runtime";

export type CliMode = "tui" | "interactive" | "print" | "json" | "rpc";

export interface AgentCliArgs {
  mode: CliMode;
  modeExplicit: boolean;
  cwd: string;
  promptParts: string[];
  provider?: string;
  model?: string;
  protocol?: ModelProfile["protocol"];
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  authType?: ModelProfile["authType"];
  oauthAccount?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  toolMode?: ModelProfile["toolMode"];
  approval?: ApprovalMode;
  maxRounds?: number;
  tools?: string[];
  excludeTools: string[];
  trustProject: boolean;
  continueSession: boolean;
  resume: boolean;
  session?: string;
  fork?: string;
  sessionDirectory?: string;
  noSession: boolean;
  name?: string;
  extensionPaths: string[];
  imagePaths: string[];
  theme?: string;
  mascot?: string;
  keymapPath?: string;
  sandbox?: "host" | "docker" | "gvisor" | "vm" | "auto";
  sandboxImage?: string;
  sandboxNetwork?: "none" | "bridge";
  vmHost?: string;
  vmWorkspace?: string;
  vmIdentity?: string;
  allowHostFallback: boolean;
  listProviders: boolean;
  listModels: boolean;
  listSessions: boolean;
  cost: boolean;
  exportSession?: string;
  help: boolean;
  version: boolean;
}

const VALUE_OPTIONS = new Set([
  "cwd",
  "repo",
  "provider",
  "model",
  "protocol",
  "base-url",
  "api-key",
  "api-key-env",
  "auth-type",
  "oauth-account",
  "context-window",
  "max-output-tokens",
  "temperature",
  "tool-mode",
  "approval",
  "max-rounds",
  "tools",
  "exclude-tools",
  "session",
  "fork",
  "session-dir",
  "name",
  "extension",
  "image",
  "theme",
  "mascot",
  "keymap",
  "sandbox",
  "sandbox-image",
  "sandbox-network",
  "vm-host",
  "vm-workspace",
  "vm-identity",
  "mode",
  "export-session",
]);

const BOOLEAN_OPTIONS = new Set([
  "print",
  "json",
  "continue",
  "resume",
  "no-session",
  "trust-project",
  "no-project",
  "list-providers",
  "list-models",
  "list-sessions",
  "cost",
  "help",
  "version",
  "allow-host-fallback",
]);

export function parseAgentArgs(argv: string[]): AgentCliArgs {
  const tokens = ["agent", "chat"].includes(argv[0] ?? "") ? argv.slice(1) : [...argv];
  if (tokens[0] === "help") tokens.splice(0, 1, "--help");
  if (tokens[0] === "version") tokens.splice(0, 1, "--version");
  if (tokens[0] === "providers") tokens.splice(0, 1, "--list-providers");
  if (tokens[0] === "sessions") tokens.splice(0, 1, "--list-sessions");
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (positionalOnly) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      if (!rawKey || (!VALUE_OPTIONS.has(rawKey) && !BOOLEAN_OPTIONS.has(rawKey))) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (BOOLEAN_OPTIONS.has(rawKey)) {
        if (inlineValue !== undefined) throw new Error(`${token} does not accept a value`);
        booleans.add(rawKey);
        continue;
      }
      const value = inlineValue ?? tokens[++index];
      if (value === undefined) throw new Error(`--${rawKey} requires a value`);
      const entries = values.get(rawKey) ?? [];
      entries.push(value);
      values.set(rawKey, entries);
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1);
      if (short === "p") booleans.add("print");
      else if (short === "c") booleans.add("continue");
      else if (short === "r") booleans.add("resume");
      else if (short === "h") booleans.add("help");
      else if (["n", "t", "e", "i"].includes(short)) {
        const value = tokens[++index];
        if (value === undefined) throw new Error(`-${short} requires a value`);
        const key =
          short === "n" ? "name" : short === "t" ? "tools" : short === "i" ? "image" : "extension";
        const entries = values.get(key) ?? [];
        entries.push(value);
        values.set(key, entries);
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      continue;
    }
    positionals.push(token);
  }

  const requestedMode = last(values, "mode");
  const mode: CliMode = booleans.has("json")
    ? "json"
    : booleans.has("print")
      ? "print"
      : requestedMode
        ? parseMode(requestedMode)
        : "tui";
  const protocol = last(values, "protocol");
  if (
    protocol &&
    !["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"].includes(protocol)
  ) {
    throw new Error(`Unsupported protocol: ${protocol}`);
  }
  const toolMode = last(values, "tool-mode");
  if (toolMode && !["native", "prompt-json", "auto"].includes(toolMode)) {
    throw new Error(`Unsupported tool mode: ${toolMode}`);
  }
  const approval = last(values, "approval");
  if (approval && !["ask", "auto-edit", "full-auto", "deny"].includes(approval)) {
    throw new Error(`Unsupported approval mode: ${approval}`);
  }
  const authType = last(values, "auth-type");
  if (authType && !["api-key", "bearer", "none"].includes(authType)) {
    throw new Error("Unsupported auth type: " + authType);
  }
  const sandbox = last(values, "sandbox");
  if (sandbox && !["host", "docker", "gvisor", "vm", "auto"].includes(sandbox)) {
    throw new Error("Unsupported sandbox: " + sandbox);
  }
  const sandboxNetwork = last(values, "sandbox-network");
  if (sandboxNetwork && !["none", "bridge"].includes(sandboxNetwork)) {
    throw new Error("Unsupported sandbox network: " + sandboxNetwork);
  }
  return {
    mode,
    modeExplicit: requestedMode !== undefined || booleans.has("json") || booleans.has("print"),
    cwd: last(values, "cwd") ?? last(values, "repo") ?? process.cwd(),
    promptParts: positionals,
    ...optional("provider", values),
    ...optional("model", values),
    ...(protocol ? { protocol: protocol as ModelProfile["protocol"] } : {}),
    ...(last(values, "base-url") ? { baseUrl: last(values, "base-url")! } : {}),
    ...(last(values, "api-key") ? { apiKey: last(values, "api-key")! } : {}),
    ...(last(values, "api-key-env") ? { apiKeyEnv: last(values, "api-key-env")! } : {}),
    ...(authType ? { authType: authType as ModelProfile["authType"] } : {}),
    ...(last(values, "oauth-account") ? { oauthAccount: last(values, "oauth-account")! } : {}),
    ...(numberOption(values, "context-window") !== undefined
      ? { contextWindow: numberOption(values, "context-window")! }
      : {}),
    ...(numberOption(values, "max-output-tokens") !== undefined
      ? { maxOutputTokens: numberOption(values, "max-output-tokens")! }
      : {}),
    ...(numberOption(values, "temperature") !== undefined
      ? { temperature: numberOption(values, "temperature")! }
      : {}),
    ...(toolMode ? { toolMode: toolMode as ModelProfile["toolMode"] } : {}),
    ...(approval ? { approval: approval as ApprovalMode } : {}),
    ...(numberOption(values, "max-rounds") !== undefined
      ? { maxRounds: numberOption(values, "max-rounds")! }
      : {}),
    ...(csvOption(values, "tools") ? { tools: csvOption(values, "tools")! } : {}),
    excludeTools: csvOption(values, "exclude-tools") ?? [],
    trustProject: booleans.has("trust-project") && !booleans.has("no-project"),
    continueSession: booleans.has("continue"),
    resume: booleans.has("resume"),
    ...(last(values, "session") ? { session: last(values, "session")! } : {}),
    ...(last(values, "fork") ? { fork: last(values, "fork")! } : {}),
    ...(last(values, "session-dir") ? { sessionDirectory: last(values, "session-dir")! } : {}),
    noSession: booleans.has("no-session"),
    ...(last(values, "name") ? { name: last(values, "name")! } : {}),
    extensionPaths: values.get("extension") ?? [],
    imagePaths: values.get("image") ?? [],
    ...(last(values, "theme") ? { theme: last(values, "theme")! } : {}),
    ...(last(values, "mascot") ? { mascot: last(values, "mascot")! } : {}),
    ...(last(values, "keymap") ? { keymapPath: last(values, "keymap")! } : {}),
    ...(sandbox ? { sandbox: sandbox as NonNullable<AgentCliArgs["sandbox"]> } : {}),
    ...(last(values, "sandbox-image") ? { sandboxImage: last(values, "sandbox-image")! } : {}),
    ...(sandboxNetwork ? { sandboxNetwork: sandboxNetwork as "none" | "bridge" } : {}),
    ...(last(values, "vm-host") ? { vmHost: last(values, "vm-host")! } : {}),
    ...(last(values, "vm-workspace") ? { vmWorkspace: last(values, "vm-workspace")! } : {}),
    ...(last(values, "vm-identity") ? { vmIdentity: last(values, "vm-identity")! } : {}),
    allowHostFallback: booleans.has("allow-host-fallback"),
    listProviders: booleans.has("list-providers"),
    listModels: booleans.has("list-models"),
    listSessions: booleans.has("list-sessions"),
    cost: booleans.has("cost"),
    ...(last(values, "export-session") ? { exportSession: last(values, "export-session")! } : {}),
    help: booleans.has("help"),
    version: booleans.has("version"),
  };
}

function parseMode(value: string): CliMode {
  if (["tui", "interactive", "print", "json", "rpc"].includes(value)) {
    return value as CliMode;
  }
  throw new Error(`Unsupported mode: ${value}`);
}

function last(values: Map<string, string[]>, key: string): string | undefined {
  return values.get(key)?.at(-1);
}

function optional(key: "provider" | "model", values: Map<string, string[]>) {
  const value = last(values, key);
  return value ? { [key]: value } : {};
}

function csvOption(values: Map<string, string[]>, key: string): string[] | undefined {
  const entries = values.get(key);
  if (!entries) return undefined;
  return entries
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function numberOption(values: Map<string, string[]>, key: string): number | undefined {
  const value = last(values, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${key} requires a number`);
  return number;
}
