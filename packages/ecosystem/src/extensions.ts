import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FocusCodeExtensionManifest {
  apiVersion: "focuscode.extension.v1";
  entry: string;
  displayName?: string;
  description?: string;
  permissions?: Array<"tools" | "commands" | "events" | "network" | "shell">;
  focuscode?: string;
}

export interface InstalledExtension {
  name: string;
  version: string;
  path: string;
  entryPath: string;
  integrity?: string;
  signed: boolean;
  manifest: FocusCodeExtensionManifest;
}

export interface ExtensionManagerOptions {
  directory: string;
  npmBinary?: string;
  runner?: CommandRunner;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  argumentsValue: string[],
  cwd: string,
) => Promise<CommandResult>;

interface ExtensionLock {
  schemaVersion: "focuscode-extension-lock.v1";
  extensions: Record<string, InstalledExtension>;
}

export class ExtensionPackageManager {
  private readonly directory: string;
  private readonly npm: string;
  private readonly runner: CommandRunner;

  constructor(options: ExtensionManagerOptions) {
    this.directory = resolve(options.directory);
    this.npm = options.npmBinary ?? "npm";
    this.runner = options.runner ?? runCommand;
  }

  async install(
    spec: string,
    options: {
      requireSignature?: boolean;
      allowedPermissions?: FocusCodeExtensionManifest["permissions"];
    } = {},
  ): Promise<InstalledExtension> {
    validateSpec(spec);
    await this.ensurePackage();
    const before = new Set(Object.keys(await this.installedDependencies()));
    const install = await this.runner(
      this.npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--save-exact",
        "--prefix",
        this.directory,
        spec,
      ],
      this.directory,
    );
    if (install.exitCode !== 0) throw new Error("Extension install failed: " + install.stderr);
    const dependencies = await this.installedDependencies();
    const candidates = Object.keys(dependencies).filter((name) => !before.has(name));
    const requestedName = packageNameFromSpec(spec);
    const name = requestedName && dependencies[requestedName] ? requestedName : candidates.at(-1);
    if (!name) throw new Error("Unable to identify installed extension package");
    try {
      const remoteSpec = !spec.startsWith(".") && !isAbsolute(spec) && !spec.startsWith("file:");
      const signed = remoteSpec ? await this.verifyRegistrySignatures() : false;
      if ((options.requireSignature ?? remoteSpec) && !signed) {
        throw new Error("Extension registry signature verification failed");
      }
      const installed = await this.inspect(name, signed);
      const allowed = new Set(options.allowedPermissions ?? ["tools", "commands", "events"]);
      const denied = (installed.manifest.permissions ?? []).filter(
        (permission) => !allowed.has(permission),
      );
      if (denied.length) {
        throw new Error("Extension requires unapproved permission(s): " + denied.join(", "));
      }
      const lock = await this.readLock();
      lock.extensions[name] = installed;
      await this.writeLock(lock);
      return installed;
    } catch (error) {
      await this.remove(name).catch(() => undefined);
      throw error;
    }
  }

  async remove(name: string): Promise<boolean> {
    validatePackageName(name);
    const lock = await this.readLock();
    const existed =
      Boolean(lock.extensions[name]) || Boolean((await this.installedDependencies())[name]);
    if (!existed) return false;
    const result = await this.runner(
      this.npm,
      ["uninstall", "--ignore-scripts", "--prefix", this.directory, name],
      this.directory,
    );
    if (result.exitCode !== 0) throw new Error("Extension removal failed: " + result.stderr);
    delete lock.extensions[name];
    await this.writeLock(lock);
    return true;
  }

  async list(): Promise<InstalledExtension[]> {
    const lock = await this.readLock();
    const result: InstalledExtension[] = [];
    for (const extension of Object.values(lock.extensions)) {
      if (await exists(extension.entryPath)) result.push(structuredClone(extension));
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async entryPaths(options: { requireSignature?: boolean } = {}): Promise<string[]> {
    const extensions = await this.list();
    if (options.requireSignature) {
      const unsigned = extensions.filter((extension) => !extension.signed);
      if (unsigned.length) {
        throw new Error(
          "Unsigned extensions are disabled: " +
            unsigned.map((extension) => extension.name).join(", "),
        );
      }
    }
    return extensions.map((extension) => extension.entryPath);
  }

  async pack(directory: string, destination?: string): Promise<string> {
    const source = resolve(directory);
    await validateExtensionPackage(source);
    const result = await this.runner(
      this.npm,
      ["pack", "--json", ...(destination ? ["--pack-destination", resolve(destination)] : [])],
      source,
    );
    if (result.exitCode !== 0) throw new Error("Extension pack failed: " + result.stderr);
    const parsed = JSON.parse(result.stdout) as Array<{ filename?: string }>;
    const filename = parsed[0]?.filename;
    if (!filename) throw new Error("npm pack did not return a filename");
    return resolve(destination ?? source, filename);
  }

  private async inspect(name: string, signed: boolean): Promise<InstalledExtension> {
    validatePackageName(name);
    const path = resolve(this.directory, "node_modules", name);
    assertInside(this.directory, path);
    const packageJson = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      focuscode?: FocusCodeExtensionManifest;
    };
    if (packageJson.name !== name || !packageJson.version)
      throw new Error("Invalid installed package metadata");
    const manifest = validateManifest(packageJson.focuscode);
    const entryPath = resolve(path, manifest.entry);
    assertInside(path, entryPath);
    if (!(await exists(entryPath))) throw new Error("Extension entry does not exist: " + entryPath);
    const lock = JSON.parse(await readFile(join(this.directory, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { integrity?: string }>;
    };
    const integrity = lock.packages?.["node_modules/" + name]?.integrity;
    return {
      name,
      version: packageJson.version,
      path,
      entryPath,
      ...(integrity ? { integrity } : {}),
      signed,
      manifest,
    };
  }

  private async verifyRegistrySignatures(): Promise<boolean> {
    const result = await this.runner(
      this.npm,
      ["audit", "signatures", "--json", "--prefix", this.directory],
      this.directory,
    );
    return result.exitCode === 0;
  }

  private async ensurePackage(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "package.json");
    if (!(await exists(path))) {
      await writeFile(
        path,
        JSON.stringify({
          name: "focuscode-installed-extensions",
          private: true,
          version: "1.0.0",
        }) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }

  private async installedDependencies(): Promise<Record<string, string>> {
    const path = join(this.directory, "package.json");
    if (!(await exists(path))) return {};
    const value = JSON.parse(await readFile(path, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return value.dependencies ?? {};
  }

  private async readLock(): Promise<ExtensionLock> {
    const path = join(this.directory, "focuscode-lock.json");
    if (!(await exists(path))) {
      return { schemaVersion: "focuscode-extension-lock.v1", extensions: {} };
    }
    const value = JSON.parse(await readFile(path, "utf8")) as ExtensionLock;
    if (value.schemaVersion !== "focuscode-extension-lock.v1" || !value.extensions) {
      throw new Error("Invalid FocusCode extension lock");
    }
    return value;
  }

  private async writeLock(lock: ExtensionLock): Promise<void> {
    await mkdir(dirname(join(this.directory, "focuscode-lock.json")), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(this.directory, "focuscode-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
  }
}

export async function validateExtensionPackage(
  directory: string,
): Promise<FocusCodeExtensionManifest> {
  const value = JSON.parse(await readFile(join(resolve(directory), "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    focuscode?: FocusCodeExtensionManifest;
  };
  if (!value.name || !value.version) throw new Error("Extension package needs name and version");
  const manifest = validateManifest(value.focuscode);
  const entry = resolve(directory, manifest.entry);
  assertInside(resolve(directory), entry);
  if (!(await exists(entry))) throw new Error("Extension entry does not exist: " + entry);
  return manifest;
}

function validateManifest(value: unknown): FocusCodeExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Package must declare package.json focuscode manifest");
  }
  const manifest = value as FocusCodeExtensionManifest;
  if (manifest.apiVersion !== "focuscode.extension.v1")
    throw new Error("Unsupported extension API");
  if (typeof manifest.entry !== "string" || !manifest.entry || isAbsolute(manifest.entry)) {
    throw new Error("Extension entry must be package-relative");
  }
  const allowed = new Set(["tools", "commands", "events", "network", "shell"]);
  if (manifest.permissions?.some((permission) => !allowed.has(permission))) {
    throw new Error("Extension requests an unknown permission");
  }
  return structuredClone(manifest);
}

function packageNameFromSpec(spec: string): string | undefined {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const version = spec.indexOf("@", slash);
    return version > slash ? spec.slice(0, version) : spec;
  }
  if (/^[a-z0-9][a-z0-9._-]*(?:@[^/]+)?$/.test(spec)) return spec.split("@")[0];
  return undefined;
}

function validateSpec(spec: string): void {
  if (!spec || spec.startsWith("-") || /[\n\r\0]/.test(spec))
    throw new Error("Invalid extension spec");
}

function validatePackageName(name: string): void {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error("Invalid extension package name");
  }
}

function assertInside(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("Extension path escapes its package");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const runCommand: CommandRunner = async (executable, argumentsValue, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(executable, argumentsValue, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        npm_config_ignore_scripts: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-200_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-200_000);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
