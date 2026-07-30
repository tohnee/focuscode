import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "focuscode-npm-verify-"));
const packed = join(work, "packed");
const installed = join(work, "installed");
await mkdir(packed, { recursive: true });

const packResult = await command(
  "npm",
  ["pack", resolve(root, "apps", "cli"), "--json", "--pack-destination", packed],
  root,
);
const metadataStart = packResult.stdout.indexOf("[");
if (metadataStart < 0) throw new Error("npm pack did not return JSON metadata");
const metadata = JSON.parse(packResult.stdout.slice(metadataStart));
const filename = metadata[0]?.filename;
if (typeof filename !== "string") throw new Error("npm pack did not report a filename");
const tarball = join(packed, filename);

await command(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, tarball],
  root,
);
const entrypoint = join(installed, "node_modules", "@focuscode", "cli", "bundle", "focuscode.mjs");
const version = (await command(process.execPath, [entrypoint, "--version"], root)).stdout.trim();
const expectedVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
if (version !== expectedVersion)
  throw new Error(
    `Installed CLI version ${version} does not match package.json ${expectedVersion}`,
  );
const mascots = (await command(process.execPath, [entrypoint, "mascots"], root)).stdout;
if (!mascots.includes("mochi") || !mascots.includes("kumo")) {
  throw new Error("Installed CLI did not expose the bundled TUI mascots");
}
const agentDemo = await command(
  process.execPath,
  [join(root, "scripts", "run-agent-demo.mjs")],
  root,
  {
    ...process.env,
    FOCUSCODE_CLI_ENTRY: entrypoint,
  },
);
if (!agentDemo.stdout.includes('"demo": "PASS"')) {
  throw new Error("Clean-installed CLI coding-agent demo did not pass");
}
// The audited-kernel path (`focuscode run`) loads its default Model Pack from
// the installed package; smoke it end to end so a missing asset cannot ship.
const kernelRepo = join(work, "kernel-repo");
await cp(resolve(root, "examples", "demo-repo"), kernelRepo, { recursive: true });
await command("git", ["init", "--quiet"], kernelRepo);
await command("git", ["config", "user.email", "demo@focuscode.local"], kernelRepo);
await command("git", ["config", "user.name", "FocusCode Demo"], kernelRepo);
await command("git", ["add", "."], kernelRepo);
await command("git", ["commit", "--quiet", "-m", "demo baseline"], kernelRepo);
await command(
  process.execPath,
  [
    entrypoint,
    "run",
    "--repo",
    kernelRepo,
    "--state-dir",
    join(work, "kernel-state"),
    "--task-id",
    "npm-kernel-smoke",
    "--task",
    "Fix add() so the registered test passes",
    "--script",
    resolve(root, "examples", "demo-script.json"),
    "--approval",
    "auto-safe",
    "--trust-repo-config",
  ],
  root,
);
const kernelEdit = await readFile(join(kernelRepo, "src", "math.js"), "utf8");
if (!kernelEdit.includes("left + right")) {
  throw new Error("Clean-installed CLI kernel run did not apply the scripted edit");
}
const packageRoot = join(installed, "node_modules", "@focuscode", "cli");
const files = (await walk(packageRoot)).map((path) => path.slice(packageRoot.length + 1)).sort();
const expected = [
  "LICENSE",
  "README.md",
  "bundle/focuscode.mjs",
  "model-packs/generic-openai/README.md",
  "model-packs/generic-openai/pack.json",
  "package.json",
];
if (JSON.stringify(files) !== JSON.stringify(expected)) {
  throw new Error("Published package contains unexpected files: " + files.join(", "));
}
const bytes = await readFile(tarball);
const outputDirectory = resolve(root, "reports", "npm");
await mkdir(outputDirectory, { recursive: true });
const output = join(outputDirectory, basename(tarball));
await copyFile(tarball, output);
const report = {
  status: "PASS",
  package: "@focuscode/cli",
  version,
  tarball: output,
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  installedFiles: files,
  checks: [
    "npm pack",
    "clean npm install with lifecycle scripts disabled",
    "installed --version",
    "installed mascot command",
    "clean-installed streaming tool-loop demo",
    "clean-installed audited-kernel run with bundled Model Pack",
    "published file allowlist",
  ],
};
await writeFile(join(outputDirectory, "verification.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

async function command(executable, argumentsValue, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, argumentsValue, {
      cwd,
      shell: false,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(executable + " exited " + exitCode + "\n" + stderr));
    });
  });
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
