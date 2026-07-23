import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SessionStore,
  resolveAgentConfig,
  type ModelProfile,
  type SessionSnapshot,
} from "@focuscode/agent-runtime";
import { ExtensionPackageManager, SessionShareService } from "@focuscode/ecosystem";
import { createSandbox, type SandboxKind } from "@focuscode/sandbox";
import {
  BUILTIN_SKINS,
  COMPANION_VERSION,
  TUI_MASCOTS,
  TUI_THEMES,
  listBuiltinSkins,
  levelName,
  mascotFrame,
  parseCompanion,
  parseSkinPack,
  progressToNext,
  serializeCompanion,
  serializeSkinPack,
  initialCompanion,
  type CompanionState,
  type SkinPack,
} from "@focuscode/tui";

export async function runExtensionCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const manager = new ExtensionPackageManager({
    directory: resolve(
      parsed.options.get("directory") ??
        process.env.FOCUSCODE_EXTENSION_DIRECTORY ??
        join(homedir(), ".focuscode", "extensions"),
    ),
  });
  if (parsed.action === "list") {
    const extensions = await manager.list();
    if (!extensions.length) process.stdout.write("No installed extensions.\n");
    for (const extension of extensions) {
      process.stdout.write(
        extension.name +
          "@" +
          extension.version +
          "\t" +
          (extension.signed ? "signed" : "unsigned") +
          "\t" +
          extension.entryPath +
          "\n",
      );
    }
    return;
  }
  if (parsed.action === "install") {
    const spec = required(parsed.positionals[0], "extension install requires <package-spec>");
    const extension = await manager.install(spec, {
      requireSignature: !parsed.flags.has("allow-unsigned"),
      allowedPermissions: [
        "tools",
        "commands",
        "events",
        ...(parsed.flags.has("allow-network") ? (["network"] as const) : []),
        ...(parsed.flags.has("allow-shell") ? (["shell"] as const) : []),
      ],
    });
    process.stdout.write(
      "Installed " +
        extension.name +
        "@" +
        extension.version +
        " (" +
        (extension.signed ? "signature verified" : "unsigned local package") +
        ")\n",
    );
    return;
  }
  if (parsed.action === "remove") {
    const name = required(parsed.positionals[0], "extension remove requires <package>");
    process.stdout.write(
      (await manager.remove(name)) ? "Extension removed.\n" : "Extension not found.\n",
    );
    return;
  }
  if (parsed.action === "pack") {
    const directory = required(parsed.positionals[0], "extension pack requires <directory>");
    const path = await manager.pack(directory, parsed.options.get("out"));
    process.stdout.write("Packed " + path + "\n");
    return;
  }
  throw new Error("Usage: focuscode extension install|list|remove|pack");
}

export async function runShareCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const repo = resolve(parsed.options.get("repo") ?? process.cwd());
  const sessions = new SessionStore(
    resolve(parsed.options.get("session-dir") ?? defaultSessionDirectory(repo)),
  );
  const service = new SessionShareService({
    identityDirectory: join(homedir(), ".focuscode", "identity"),
  });
  if (parsed.action === "export") {
    const sessionId = required(
      parsed.options.get("session") ?? parsed.positionals[0],
      "share export requires --session <id>",
    );
    const snapshot = await sessions.load(sessionId);
    const bundle = await service.create(snapshot as unknown as Record<string, unknown>, {
      workspace: repo,
      includeToolOutput: parsed.flags.has("include-tool-output"),
      includeImages: parsed.flags.has("include-images"),
    });
    const output = resolve(
      parsed.options.get("out") ?? "focuscode-" + bundle.shareId + ".focuscode-share.json",
    );
    await service.write(bundle, output);
    process.stdout.write(
      "Exported signed share " + output + " (" + bundle.redactions + " redaction(s))\n",
    );
    return;
  }
  if (parsed.action === "import") {
    const path = required(
      parsed.options.get("file") ?? parsed.positionals[0],
      "share import requires <file>",
    );
    const bundle = await service.read(path);
    const portable = service.import(bundle, repo) as unknown as SessionSnapshot;
    const profile = portableModel(portable);
    const imported = await sessions.importSnapshot(portable, {
      cwd: repo,
      model: profile,
      name: "Shared " + bundle.shareId,
    });
    process.stdout.write("Imported as session " + imported.header.sessionId + "\n");
    return;
  }
  if (parsed.action === "publish") {
    const file = required(
      parsed.options.get("file") ?? parsed.positionals[0],
      "share publish requires <file>",
    );
    const endpoint = required(
      parsed.options.get("endpoint") ?? process.env.FOCUSCODE_SHARE_ENDPOINT,
      "share publish requires --endpoint",
    );
    const result = await service.publish(
      await service.read(file),
      endpoint,
      parsed.options.get("token") ?? process.env.FOCUSCODE_SHARE_TOKEN,
    );
    process.stdout.write("Published " + result.id + (result.url ? " " + result.url : "") + "\n");
    return;
  }
  if (parsed.action === "download") {
    const id = required(parsed.positionals[0], "share download requires <id>");
    const endpoint = required(
      parsed.options.get("endpoint") ?? process.env.FOCUSCODE_SHARE_ENDPOINT,
      "share download requires --endpoint",
    );
    const bundle = await service.download(
      id,
      endpoint,
      parsed.options.get("token") ?? process.env.FOCUSCODE_SHARE_TOKEN,
    );
    const output = resolve(parsed.options.get("out") ?? id + ".focuscode-share.json");
    await service.write(bundle, output);
    process.stdout.write("Downloaded and verified " + output + "\n");
    return;
  }
  throw new Error("Usage: focuscode share export|import|publish|download");
}

export async function runSandboxCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (parsed.action !== "doctor")
    throw new Error("Usage: focuscode sandbox doctor --kind docker|gvisor|vm");
  const kind = (parsed.options.get("kind") ?? parsed.positionals[0] ?? "auto") as SandboxKind;
  if (!["host", "docker", "gvisor", "vm", "auto"].includes(kind))
    throw new Error("Invalid sandbox kind");
  const workspaceRoot = resolve(parsed.options.get("repo") ?? process.cwd());
  const image = parsed.options.get("image");
  const vmIdentity = parsed.options.get("vm-identity");
  try {
    const sandbox = await createSandbox({
      kind,
      workspaceRoot,
      ...(image ? { image } : {}),
      ...(parsed.flags.has("allow-host-fallback") ? { allowHostFallback: true } : {}),
      ...(parsed.options.get("vm-host") && parsed.options.get("vm-workspace")
        ? {
            vm: {
              host: parsed.options.get("vm-host")!,
              remoteWorkspace: parsed.options.get("vm-workspace")!,
              ...(vmIdentity ? { identityFile: vmIdentity } : {}),
            },
          }
        : {}),
    });
    const health = await sandbox.health();
    process.stdout.write(JSON.stringify({ requested: kind, ...health }, null, 2) + "\n");
    if (!health.available) process.exitCode = 2;
  } catch (error) {
    process.stdout.write(
      JSON.stringify(
        {
          requested: kind,
          available: false,
          detail: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 2;
  }
}

export async function runDoctorCommand(argv: string[]): Promise<void> {
  const parsed = parse(["doctor", ...argv]);
  const repo = resolve(parsed.options.get("repo") ?? process.cwd());
  const checks: Array<{
    id: string;
    status: "pass" | "fail" | "warning";
    detail: string;
  }> = [];
  let config: Awaited<ReturnType<typeof resolveAgentConfig>>;
  try {
    config = await resolveAgentConfig(repo, { projectTrusted: true });
    checks.push({
      id: "configuration",
      status: "pass",
      detail: `${config.model.provider}/${config.model.model}`,
    });
  } catch (error) {
    checks.push({
      id: "configuration",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
    process.stdout.write(JSON.stringify({ ready: false, repo, checks }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }
  checks.push({
    id: "enterprise-policy",
    status: config.enterprise.enabled ? "pass" : "warning",
    detail: config.enterprise.enabled
      ? "fail-closed enterprise policy enabled"
      : "enterprise mode is disabled",
  });
  if (config.enterprise.enabled) {
    const keyName = config.enterprise.auditHmacKeyEnv ?? "FOCUSCODE_AUDIT_HMAC_KEY";
    const key = process.env[keyName];
    checks.push({
      id: "audit-key",
      status: key && Buffer.byteLength(key) >= 32 ? "pass" : "fail",
      detail:
        key && Buffer.byteLength(key) >= 32
          ? `${keyName} is configured`
          : `${keyName} is missing or shorter than 32 bytes`,
    });
  }
  try {
    const sandbox = await createSandbox({
      kind: config.sandbox.kind ?? "auto",
      workspaceRoot: repo,
      ...(config.sandbox.image ? { image: config.sandbox.image } : {}),
      ...(config.sandbox.network ? { network: config.sandbox.network } : {}),
      ...(config.sandbox.requireImageDigest ? { requireImageDigest: true } : {}),
      ...(config.sandbox.vmHost && config.sandbox.vmWorkspace
        ? {
            vm: {
              host: config.sandbox.vmHost,
              remoteWorkspace: config.sandbox.vmWorkspace,
              ...(config.sandbox.vmIdentityFile
                ? { identityFile: config.sandbox.vmIdentityFile }
                : {}),
            },
          }
        : {}),
    });
    const health = await sandbox.health();
    checks.push({
      id: "sandbox",
      status:
        health.available &&
        (!config.enterprise.enabled || ["docker", "gvisor", "vm"].includes(health.backend))
          ? "pass"
          : "fail",
      detail: `${health.backend}/${health.isolation ?? "unknown"}: ${health.detail}`,
    });
  } catch (error) {
    checks.push({
      id: "sandbox",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const extensions = await new ExtensionPackageManager({
      directory: resolve(config.extensionDirectory ?? defaultExtensionDirectory()),
    }).list();
    const allowed = new Set(config.enterprise.allowedExtensions ?? []);
    const active = config.enterprise.enabled
      ? extensions.filter((extension) => allowed.has(extension.name))
      : extensions;
    const unsafe = active.filter(
      (extension) =>
        !extension.signed ||
        (extension.manifest.permissions ?? []).some((permission) =>
          ["network", "shell"].includes(permission),
        ),
    );
    checks.push({
      id: "extensions",
      status: unsafe.length === 0 ? "pass" : "fail",
      detail:
        unsafe.length === 0
          ? `${active.length} active extension(s); signature and privilege checks passed`
          : `unsafe active extensions: ${unsafe.map((item) => item.name).join(", ")}`,
    });
  } catch (error) {
    checks.push({
      id: "extensions",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  checks.push({
    id: "remote-media",
    status:
      !config.enterprise.enabled || config.media.allowRemoteImages === false ? "pass" : "fail",
    detail: config.media.allowRemoteImages ? "remote image URLs enabled" : "local images only",
  });
  // First-wave additions: MCP server reachability, checkpoint directory
  // writability, and companion state file health.
  const activeMcpServers = config.mcp.servers.filter((server) => !server.disabled);
  if (activeMcpServers.length === 0) {
    checks.push({
      id: "mcp-servers",
      status: "pass",
      detail: "no MCP servers configured",
    });
  } else {
    const results = activeMcpServers.map((server) => {
      try {
        const probe = spawnSync(server.command, server.args ?? [], {
          timeout: 2_000,
          stdio: "ignore",
          ...(server.env ? { env: { ...process.env, ...server.env } } : {}),
        });
        const found =
          probe.error === undefined || (probe.error as NodeJS.ErrnoException).code !== "ENOENT";
        return { id: server.id, ok: found };
      } catch (error) {
        return {
          id: server.id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const reachable = results.filter((result) => result.ok);
    checks.push({
      id: "mcp-servers",
      status: reachable.length === results.length ? "pass" : "warning",
      detail:
        `${reachable.length}/${results.length} MCP servers reachable (` +
        results.map((result) => `${result.id}:${result.ok ? "ok" : "missing"}`).join(", ") +
        `)`,
    });
  }
  const checkpointDir = resolve(join(homedir(), ".focuscode", "checkpoints"));
  try {
    await mkdir(checkpointDir, { recursive: true });
    const probeFile = join(checkpointDir, ".doctor-probe");
    await writeFile(probeFile, "ok", "utf8");
    await rm(probeFile);
    checks.push({
      id: "checkpoint-directory",
      status: "pass",
      detail: `${checkpointDir} is writable`,
    });
  } catch (error) {
    checks.push({
      id: "checkpoint-directory",
      status: "fail",
      detail: `${checkpointDir}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    const path = companionPath();
    try {
      const text = await readFile(path, "utf8");
      const state = parseCompanion(text);
      checks.push({
        id: "companion-state",
        status: "pass",
        detail: `${path}: level ${state.level} (${levelName(state.level)}), ${state.xp} xp`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      checks.push({
        id: "companion-state",
        status: "pass",
        detail: `${path} not yet created (will initialize on first run)`,
      });
    }
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    checks.push({
      id: "companion-state",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const ready = checks.every((check) => check.status !== "fail");
  process.stdout.write(JSON.stringify({ ready, repo, checks }, null, 2) + "\n");
  if (!ready) process.exitCode = 2;
}

export function printMascots(): void {
  for (const mascot of TUI_MASCOTS) {
    process.stdout.write(
      "\n" +
        mascot.id.padEnd(10) +
        mascot.name.padEnd(10) +
        mascot.species +
        "\t" +
        mascot.catchphrase +
        "\n" +
        mascotFrame(mascot, "idle", 0)
          .map((line) => "  " + line)
          .join("\n") +
        "\n",
    );
  }
}

export function printThemes(): void {
  for (const theme of TUI_THEMES) process.stdout.write(theme.id + "\t" + theme.name + "\n");
}

// --- First-wave CLI subcommands: skins / character / companion -------------
//
// These commands manage TUI personalization through the global user config at
// `~/.focuscode/config.json` and a dedicated skin pack directory at
// `~/.focuscode/skins/<id>.json`. They do not modify project-level config.

function globalConfigPath(): string {
  return resolve(join(homedir(), ".focuscode", "config.json"));
}

function skinsDirectory(): string {
  return resolve(join(homedir(), ".focuscode", "skins"));
}

function companionPath(): string {
  return resolve(join(homedir(), ".focuscode", "companion.json"));
}

async function readGlobalConfig(): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(globalConfigPath(), "utf8");
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeGlobalConfig(config: Record<string, unknown>): Promise<void> {
  const path = globalConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

async function listInstalledSkins(): Promise<SkinPack[]> {
  const directory = skinsDirectory();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skins: SkinPack[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(directory, entry);
    try {
      skins.push(parseSkinPack(await readFile(path, "utf8")));
    } catch {
      // Skip malformed entries; doctor surfaces them separately.
    }
  }
  return skins;
}

export async function runSkinsCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const action = parsed.action;
  if (action === "list") {
    const installed = await listInstalledSkins();
    process.stdout.write("Built-in skins:\n");
    for (const skin of listBuiltinSkins()) {
      process.stdout.write(`  ${skin.id}\t${skin.name}\t${skin.author ?? "-"}\n`);
    }
    if (installed.length > 0) {
      process.stdout.write("Imported skins:\n");
      for (const skin of installed) {
        process.stdout.write(`  ${skin.id}\t${skin.name}\t${skin.author ?? "-"}\n`);
      }
    } else {
      process.stdout.write("Imported skins: (none)\n");
    }
    return;
  }
  if (action === "apply") {
    const target = required(parsed.positionals[0], "skins apply requires <id|path>");
    const skin = await resolveSkin(target);
    const config = await readGlobalConfig();
    const tui = (config.tui as Record<string, unknown> | undefined) ?? {};
    const nextTui: Record<string, unknown> = { ...tui, skin: skin.id };
    if (skin.theme) nextTui.theme = skin.theme.id;
    if (skin.mascot) nextTui.mascot = skin.mascot.id;
    config.tui = nextTui;
    await writeGlobalConfig(config);
    process.stdout.write(`Applied skin ${skin.id} (${skin.name}).\n`);
    return;
  }
  if (action === "import") {
    const path = required(parsed.positionals[0], "skins import requires <path>");
    const skin = parseSkinPack(await readFile(resolve(path), "utf8"));
    const directory = skinsDirectory();
    await mkdir(directory, { recursive: true });
    const out = join(directory, `${skin.id}.json`);
    await writeFile(out, serializeSkinPack(skin) + "\n", "utf8");
    process.stdout.write(`Imported skin ${skin.id} -> ${out}\n`);
    return;
  }
  if (action === "export") {
    const id = required(parsed.positionals[0], "skins export requires <id> <path>");
    const out = required(parsed.positionals[1], "skins export requires <id> <path>");
    const skin = await resolveSkin(id);
    const output = resolve(out);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serializeSkinPack(skin) + "\n", "utf8");
    process.stdout.write(`Exported skin ${skin.id} -> ${output}\n`);
    return;
  }
  if (action === "remove") {
    const id = required(parsed.positionals[0], "skins remove requires <id>");
    if (BUILTIN_SKINS.some((skin) => skin.id === id)) {
      throw new Error(`Cannot remove built-in skin: ${id}`);
    }
    const path = join(skinsDirectory(), `${id}.json`);
    let removed = false;
    try {
      await rm(path);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    process.stdout.write(removed ? `Removed skin ${id}.\n` : `Skin ${id} is not installed.\n`);
    return;
  }
  throw new Error(
    "Usage: focuscode skins list|apply <id|path>|import <path>|export <id> <path>|remove <id>",
  );
}

async function resolveSkin(idOrPath: string): Promise<SkinPack> {
  // Path: read + validate
  try {
    await access(resolve(idOrPath), fsConstants.F_OK);
    return parseSkinPack(await readFile(resolve(idOrPath), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Builtin
  const builtin = listBuiltinSkins().find((skin) => skin.id === idOrPath);
  if (builtin) return builtin;
  // Imported
  const installed = await listInstalledSkins();
  const imported = installed.find((skin) => skin.id === idOrPath);
  if (imported) return imported;
  throw new Error(`Skin not found: ${idOrPath}`);
}

export async function runCharacterCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (parsed.action === "list" || parsed.action === "") {
    for (const mascot of TUI_MASCOTS) {
      process.stdout.write(
        `${mascot.id}\t${mascot.name}\t${mascot.species}\t${mascot.catchphrase}\n`,
      );
    }
    return;
  }
  const id = parsed.action;
  const match = TUI_MASCOTS.find((mascot) => mascot.id === id);
  if (!match) throw new Error(`Unknown character: ${id}`);
  const config = await readGlobalConfig();
  const tui = (config.tui as Record<string, unknown> | undefined) ?? {};
  config.tui = { ...tui, mascot: id };
  await writeGlobalConfig(config);
  process.stdout.write(`Set TUI character to ${match.id} (${match.name}).\n`);
}

export async function runCompanionCommand(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (parsed.action === "reset") {
    if (!parsed.flags.has("yes")) {
      const confirmed = await confirm("Reset companion state? This cannot be undone. [y/N] ");
      if (!confirmed) {
        process.stdout.write("Cancelled.\n");
        return;
      }
    }
    const fresh = initialCompanion();
    await mkdir(dirname(companionPath()), { recursive: true });
    await writeFile(companionPath(), serializeCompanion(fresh) + "\n", "utf8");
    process.stdout.write("Companion state reset.\n");
    return;
  }
  if (parsed.action !== "list" && parsed.action !== "" && parsed.action !== "show") {
    throw new Error("Usage: focuscode companion [list|reset]");
  }
  const state = await readCompanionState();
  const progress = progressToNext(state);
  process.stdout.write(
    `Companion state (${COMPANION_VERSION}):\n` +
      `  level: ${state.level} — ${levelName(state.level)}\n` +
      `  xp: ${state.xp}\n` +
      `  progress: ${progress.current}/${progress.needed} (${Math.round(progress.ratio * 100)}%)\n` +
      `  totalTurns: ${state.totalTurns}\n` +
      `  totalToolSuccesses: ${state.totalToolSuccesses}\n`,
  );
}

async function readCompanionState(): Promise<CompanionState> {
  try {
    return parseCompanion(await readFile(companionPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialCompanion();
    throw error;
  }
}

async function confirm(question: string): Promise<boolean> {
  // Read a single line from stdin. Non-TTY defaults to "no" so the reset
  // path stays safe in scripts and CI.
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  return new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (buffer.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        const answer = buffer.split("\n")[0] ?? "";
        resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
      }
    };
    process.stdin.once("data", onData);
  });
}

export function defaultExtensionDirectory(): string {
  return resolve(
    process.env.FOCUSCODE_EXTENSION_DIRECTORY ?? join(homedir(), ".focuscode", "extensions"),
  );
}

function portableModel(snapshot: SessionSnapshot): ModelProfile {
  return {
    provider: snapshot.header.model.provider,
    model: snapshot.header.model.model,
    protocol: snapshot.header.model.protocol,
    baseUrl: "",
    authType: "none",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    temperature: 0,
    toolMode: "auto",
    reasoningEffort: "off",
    capabilities: { input: ["text"], reasoning: false, toolCalling: true },
    compatibility: {},
    reliability: {
      timeoutMs: 300_000,
      maxRetries: 0,
      retryBaseDelayMs: 500,
      retryMaximumDelayMs: 10_000,
      // Portable profiles bypass config validation; pin conservative breaker
      // and bulkhead limits so any client later built from this profile
      // inherits bounded behavior.
      circuitThreshold: 5,
      circuitCooldownMs: 30_000,
      maxConcurrency: 8,
    },
  };
}

function defaultSessionDirectory(cwd: string): string {
  const digest = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(homedir(), ".focuscode", "sessions", digest);
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
  const boolean = new Set([
    "allow-unsigned",
    "allow-network",
    "allow-shell",
    "include-tool-output",
    "include-images",
    "allow-host-fallback",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=", 2);
    if (!key) throw new Error("Invalid option");
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
