import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Digest } from "@focuscode/contracts";

export interface RepoCommandConfig {
  id: string;
  argv: [string, ...string[]];
  timeoutMs?: number;
}

export interface FocusRepoConfig {
  schemaVersion: "focuscode-repo.v1";
  protectedPaths: string[];
  commands: RepoCommandConfig[];
  verificationCommandIds: string[];
}

export interface RepoProfileV1 {
  schemaVersion: "repo-profile.v1";
  root: string;
  languages: string[];
  manifests: string[];
  protectedPaths: string[];
  commands: RepoCommandConfig[];
  verificationCommandIds: string[];
  digest: `sha256:${string}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG: FocusRepoConfig = {
  schemaVersion: "focuscode-repo.v1",
  protectedPaths: [
    ".git",
    ".env",
    ".env.local",
    ".npmrc",
    ".pypirc",
    ".ssh",
    ".focuscode",
    "node_modules",
  ],
  commands: [],
  verificationCommandIds: [],
};

export async function loadRepoConfig(root: string): Promise<FocusRepoConfig> {
  const path = join(resolve(root), ".focuscode", "config.json");
  if (!(await exists(path))) return structuredClone(DEFAULT_CONFIG);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object")
    throw new Error(".focuscode/config.json must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "focuscode-repo.v1") {
    throw new Error("Unsupported FocusCode repository config version");
  }
  if (!Array.isArray(candidate.protectedPaths) || !candidate.protectedPaths.every(isString)) {
    throw new Error("protectedPaths must be a string array");
  }
  if (
    !Array.isArray(candidate.verificationCommandIds) ||
    !candidate.verificationCommandIds.every(isString)
  ) {
    throw new Error("verificationCommandIds must be a string array");
  }
  if (!Array.isArray(candidate.commands)) throw new Error("commands must be an array");
  const commands = candidate.commands.map((raw, index): RepoCommandConfig => {
    if (!raw || typeof raw !== "object") throw new Error(`commands[${index}] must be an object`);
    const command = raw as Record<string, unknown>;
    if (!isString(command.id) || !Array.isArray(command.argv) || !command.argv.every(isString)) {
      throw new Error(`commands[${index}] requires id and string argv`);
    }
    if (command.argv.length === 0) throw new Error(`commands[${index}].argv must not be empty`);
    const argv = command.argv as [string, ...string[]];
    return {
      id: command.id,
      argv,
      ...(typeof command.timeoutMs === "number" ? { timeoutMs: command.timeoutMs } : {}),
    };
  });
  return {
    schemaVersion: "focuscode-repo.v1",
    protectedPaths: [...new Set([...DEFAULT_CONFIG.protectedPaths, ...candidate.protectedPaths])],
    commands,
    verificationCommandIds: candidate.verificationCommandIds,
  };
}

export async function buildRepoProfile(root: string): Promise<RepoProfileV1> {
  const resolvedRoot = resolve(root);
  const config = await loadRepoConfig(resolvedRoot);
  const probes: Array<[string, string]> = [
    ["package.json", "JavaScript/TypeScript"],
    ["tsconfig.json", "TypeScript"],
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Cargo.toml", "Rust"],
    ["pom.xml", "Java"],
  ];
  const manifests: string[] = [];
  const languages = new Set<string>();
  for (const [manifest, language] of probes) {
    if (await exists(join(resolvedRoot, manifest))) {
      manifests.push(manifest);
      languages.add(language);
    }
  }
  const withoutDigest = {
    schemaVersion: "repo-profile.v1" as const,
    root: resolvedRoot,
    languages: [...languages].sort(),
    manifests: manifests.sort(),
    protectedPaths: [...config.protectedPaths].sort(),
    commands: config.commands,
    verificationCommandIds: config.verificationCommandIds,
  };
  return { ...withoutDigest, digest: sha256Digest(withoutDigest) };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
