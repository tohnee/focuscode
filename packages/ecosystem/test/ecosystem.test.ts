import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExtensionPackageManager,
  SessionShareService,
  validateExtensionPackage,
  type CommandRunner,
  type SessionShareBundle,
} from "../src/index.js";

describe("extension distribution", () => {
  it("validates and packs extension packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "focus-extension-source-"));
    await writeExtension(root, "@fixture/hello");
    expect(await validateExtensionPackage(root)).toMatchObject({
      apiVersion: "focuscode.extension.v1",
      entry: "./index.mjs",
    });
    const runner: CommandRunner = async (_executable, args) => ({
      exitCode: 0,
      stdout: JSON.stringify([{ filename: "fixture-hello-1.0.0.tgz" }]),
      stderr: args.join(" "),
    });
    const manager = new ExtensionPackageManager({
      directory: join(root, "installed"),
      runner,
    });
    expect(await manager.pack(root, join(root, "out"))).toBe(
      join(root, "out", "fixture-hello-1.0.0.tgz"),
    );
  });

  it("installs, signature-checks, locks, lists and removes packages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-extension-install-"));
    const runner: CommandRunner = async (_executable, args, cwd) => {
      if (args[0] === "install") {
        const packageJsonPath = join(cwd, "package.json");
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        packageJson.dependencies = { "@fixture/hello": "1.0.0" };
        await writeFile(packageJsonPath, JSON.stringify(packageJson));
        const packageRoot = join(cwd, "node_modules", "@fixture", "hello");
        await writeExtension(packageRoot, "@fixture/hello");
        await writeFile(
          join(cwd, "package-lock.json"),
          JSON.stringify({
            packages: {
              "node_modules/@fixture/hello": { integrity: "sha512-fixture" },
            },
          }),
        );
      }
      if (args[0] === "uninstall") {
        const path = join(cwd, "package.json");
        const value = JSON.parse(await readFile(path, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        delete value.dependencies?.["@fixture/hello"];
        await writeFile(path, JSON.stringify(value));
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    const manager = new ExtensionPackageManager({ directory, runner });
    const installed = await manager.install("@fixture/hello@1.0.0");
    expect(installed).toMatchObject({
      name: "@fixture/hello",
      version: "1.0.0",
      integrity: "sha512-fixture",
      signed: true,
    });
    expect(await manager.entryPaths()).toEqual([
      join(directory, "node_modules", "@fixture", "hello", "index.mjs"),
    ]);
    expect(await manager.remove("@fixture/hello")).toBe(true);
    expect(await manager.list()).toEqual([]);
  });
});

describe("signed session sharing", () => {
  it("redacts secrets, signs, writes, verifies and relocates sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "focus-share-"));
    const service = new SessionShareService({
      identityDirectory: join(root, "identity"),
      now: () => new Date("2026-07-19T00:00:00Z"),
    });
    const bundle = await service.create(
      {
        header: { cwd: "/private/repo", sessionId: "session_old" },
        entries: [
          {
            message: {
              role: "user",
              content: "api_key=super-secret-value",
              providerState: {
                reasoningContent: "private-reasoning-state",
                thinkingBlocks: [{ type: "thinking", thinking: "hidden-chain" }],
              },
              attachments: [
                {
                  type: "image",
                  source: { type: "base64", data: "private-image" },
                },
              ],
            },
          },
          { message: { role: "tool", content: "raw private output" } },
        ],
      },
      { workspace: "/private/repo" },
    );
    expect(service.verify(bundle)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("super-secret-value");
    expect(JSON.stringify(bundle)).not.toContain("raw private output");
    expect(JSON.stringify(bundle)).not.toContain("private-image");
    expect(JSON.stringify(bundle)).not.toContain("private-reasoning-state");
    expect(JSON.stringify(bundle)).not.toContain("hidden-chain");
    expect(bundle.workspaceHint).toBe("repo");
    const path = join(root, "share.focuscode.json");
    await service.write(bundle, path);
    expect((await service.read(path)).shareId).toBe(bundle.shareId);
    const imported = service.import(bundle, join(root, "new-repo"));
    expect((imported.header as Record<string, unknown>).cwd).toBe(join(root, "new-repo"));
    expect((imported.header as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it("publishes and downloads only verified bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "focus-share-http-"));
    let stored: SessionShareBundle | undefined;
    const service = new SessionShareService({
      identityDirectory: join(root, "identity"),
      fetchImplementation: async (input, init) => {
        if (init?.method === "POST") {
          stored = JSON.parse(String(init.body)) as SessionShareBundle;
          return Response.json({ id: "remote_1", url: "https://share.example/s/remote_1" });
        }
        return Response.json(stored);
      },
    });
    const bundle = await service.create({ header: { cwd: "/repo" }, entries: [] });
    expect(await service.publish(bundle, "https://share.example", "token")).toMatchObject({
      id: "remote_1",
    });
    expect((await service.download("remote_1", "https://share.example")).shareId).toBe(
      bundle.shareId,
    );
    const tampered = { ...bundle, workspaceHint: "tampered" };
    expect(service.verify(tampered)).toBe(false);
    await expect(service.publish(tampered, "https://share.example")).rejects.toThrow("invalid");
  });
});

describe("extension signature and permission denials", () => {
  function denyingRunner(options: {
    signaturesExitCode: number;
    permissions?: string[];
  }): CommandRunner {
    return async (_executable, args, cwd) => {
      if (args[0] === "install") {
        const packageJsonPath = join(cwd, "package.json");
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        packageJson.dependencies = { "@fixture/hello": "1.0.0" };
        await writeFile(packageJsonPath, JSON.stringify(packageJson));
        const packageRoot = join(cwd, "node_modules", "@fixture", "hello");
        await writeExtension(
          packageRoot,
          "@fixture/hello",
          options.permissions ?? ["tools", "commands"],
        );
        await writeFile(
          join(cwd, "package-lock.json"),
          JSON.stringify({
            packages: {
              "node_modules/@fixture/hello": { integrity: "sha512-fixture" },
            },
          }),
        );
      }
      if (args[0] === "uninstall") {
        const path = join(cwd, "package.json");
        const value = JSON.parse(await readFile(path, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        delete value.dependencies?.["@fixture/hello"];
        await writeFile(path, JSON.stringify(value));
      }
      if (args[0] === "audit") {
        return { exitCode: options.signaturesExitCode, stdout: "{}", stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
  }

  it("rejects an unsigned remote spec when a signature is required and cleans up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-extension-unsigned-"));
    const manager = new ExtensionPackageManager({
      directory,
      runner: denyingRunner({ signaturesExitCode: 1 }),
    });
    await expect(
      manager.install("@fixture/hello@1.0.0", { requireSignature: true }),
    ).rejects.toThrow(/signature verification failed/);
    expect(await manager.list()).toEqual([]);
  });

  it("rejects a manifest requesting permissions beyond the allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-extension-permissions-"));
    const manager = new ExtensionPackageManager({
      directory,
      runner: denyingRunner({
        signaturesExitCode: 0,
        permissions: ["tools", "network", "shell"],
      }),
    });
    await expect(
      manager.install("@fixture/hello@1.0.0", {
        requireSignature: false,
        allowedPermissions: ["tools", "commands", "events"],
      }),
    ).rejects.toThrow(/unapproved permission\(s\): network, shell/);
    expect(await manager.list()).toEqual([]);
  });

  it("refuses to expose entry paths of unsigned extensions under enterprise policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-extension-enterprise-"));
    const manager = new ExtensionPackageManager({
      directory,
      runner: denyingRunner({ signaturesExitCode: 1 }),
    });
    const installed = await manager.install("@fixture/hello@1.0.0", { requireSignature: false });
    expect(installed.signed).toBe(false);
    await expect(manager.entryPaths({ requireSignature: true })).rejects.toThrow(
      /Unsigned extensions are disabled/,
    );
  });
});

async function writeExtension(
  root: string,
  name: string,
  permissions: string[] = ["tools", "commands"],
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      focuscode: {
        apiVersion: "focuscode.extension.v1",
        entry: "./index.mjs",
        permissions,
      },
    }),
  );
  await writeFile(join(root, "index.mjs"), "export default () => undefined;\n");
}
