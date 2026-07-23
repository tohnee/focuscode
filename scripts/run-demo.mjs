import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runRoot = join(root, ".tmp", "demo-run");
const stateDirectory = join(root, ".tmp", "demo-state");

await rm(runRoot, { recursive: true, force: true });
await rm(stateDirectory, { recursive: true, force: true });
await mkdir(dirname(runRoot), { recursive: true });
await cp(join(root, "examples", "demo-repo"), runRoot, { recursive: true });

await command("git", ["init", "--quiet"], runRoot);
await command("git", ["config", "user.email", "demo@focuscode.local"], runRoot);
await command("git", ["config", "user.name", "FocusCode Demo"], runRoot);
await command("git", ["add", "."], runRoot);
await command("git", ["commit", "--quiet", "-m", "demo baseline"], runRoot);

const result = await command(
  "node",
  [
    join(root, "apps", "cli", "dist", "index.js"),
    "run",
    "--repo",
    runRoot,
    "--state-dir",
    stateDirectory,
    "--task-id",
    "demo-fix-add",
    "--task",
    "Fix add() so the registered test passes",
    "--script",
    join(root, "examples", "demo-script.json"),
    "--approval",
    "auto-safe",
    "--trust-repo-config",
  ],
  root,
  new Set([0]),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

const changed = await readFile(join(runRoot, "src", "math.js"), "utf8");
if (!changed.includes("left + right")) throw new Error("Demo edit was not applied");
await command("node", ["--test"], runRoot);
process.stdout.write(`Demo passed. Inspect the working copy at ${runRoot}\n`);

function command(program, argv, cwd, acceptedCodes = new Set([0])) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      if (acceptedCodes.has(code)) resolve({ code, stdout, stderr });
      else reject(new Error(`${program} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}
