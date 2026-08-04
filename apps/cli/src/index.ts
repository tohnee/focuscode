#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { exportTaskAssets, FileMemoryStore } from "@focuscode/asset-plane";
import { TaskSpecSchema, assertSchema, type TaskSpecV1 } from "@focuscode/contracts";
import { FileFactStore } from "@focuscode/persistence";
import { createLocalHarness, type HarnessApprovalMode, type ScriptedStep } from "@focuscode/sdk";
import type { ApprovalPort } from "@focuscode/action-domain";
import { isAgentInvocation, runAgentCommand } from "./agent-command.js";
import { runAuthCommand } from "./auth-command.js";
import {
  printMascots,
  printThemes,
  runCharacterCommand,
  runCompanionCommand,
  runDoctorCommand,
  runExtensionCommand,
  runSandboxCommand,
  runShareCommand,
  runSkinsCommand,
} from "./platform-command.js";

interface ParsedArgs {
  command: string;
  options: Map<string, string | true>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) throw new Error(`Invalid option: ${token}`);
    if (inlineValue !== undefined) options.set(rawKey, inlineValue);
    else if (rest[index + 1] && !rest[index + 1]!.startsWith("--")) {
      options.set(rawKey, rest[index + 1]!);
      index += 1;
    } else options.set(rawKey, true);
  }
  return { command, options, positionals };
}

function option(args: ParsedArgs, key: string, fallback?: string): string | undefined {
  const value = args.options.get(key);
  if (value === true) return "true";
  return value ?? fallback;
}

/**
 * Boolean flag check that honors `--flag=false`: the parser stores the inline
 * value, so `.has()` alone would treat `--trust-repo-config=false` as SET and
 * invert the trust boundary. An explicit "false" disables the flag.
 */
function flag(args: ParsedArgs, key: string): boolean {
  const value = args.options.get(key);
  return value !== undefined && value !== "false";
}

export { parseArgs, flag };
export type { ParsedArgs };

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function initCommand(args: ParsedArgs): Promise<void> {
  const repoRoot = resolve(option(args, "repo", args.positionals[0] ?? process.cwd())!);
  const info = await stat(repoRoot).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Repository directory does not exist: ${repoRoot}`);
  const directory = join(repoRoot, ".focuscode");
  const path = join(directory, "config.json");
  const agentPath = join(directory, "agent.json");
  if (((await pathExists(path)) || (await pathExists(agentPath))) && !flag(args, "force")) {
    throw new Error(`${directory} already contains FocusCode config; use --force to replace it`);
  }
  const verification = await detectVerification(repoRoot);
  const enterprise = flag(args, "enterprise");
  const sandboxImage = option(args, "sandbox-image", "node:22-bookworm")!;
  if (enterprise && !/@sha256:[a-f0-9]{64}$/i.test(sandboxImage)) {
    throw new Error("Enterprise init requires --sandbox-image <image>@sha256:<digest>");
  }
  const config = {
    schemaVersion: "focuscode-repo.v1",
    protectedPaths: [".git", ".env", ".npmrc", ".focuscode"],
    commands: verification ? [{ id: "test", ...verification, timeoutMs: 120_000 }] : [],
    verificationCommandIds: verification ? ["test"] : [],
  };
  const agentConfig = {
    schemaVersion: "focuscode-agent.v1",
    ...(option(args, "provider") ? { provider: option(args, "provider") } : {}),
    ...(option(args, "model") ? { model: option(args, "model") } : {}),
    ...(option(args, "base-url") ? { baseUrl: option(args, "base-url") } : {}),
    approval: "ask",
    agent: {
      effectSpine: true,
      checkpoints: true,
      diagnostics: true,
      enableDelegate: true,
    },
    sandbox: {
      kind: "auto",
      image: sandboxImage,
      network: "none",
      allowHostFallback: false,
      requireImageDigest: enterprise,
    },
    tui: { enabled: true, theme: "foxglow", mascot: "foxy", keymap: {} },
    protectedPaths: [".git", ".env", ".npmrc", ".focuscode"],
    disabledTools: [],
    media: { allowRemoteImages: !enterprise },
    ...(enterprise
      ? {
          enterprise: {
            enabled: true,
            allowedProviders: option(args, "provider") ? [option(args, "provider")!] : [],
            allowedModels:
              option(args, "provider") && option(args, "model")
                ? [option(args, "provider")! + "/" + option(args, "model")!]
                : [],
            requireIsolatedSandbox: true,
            auditHmacKeyEnv: "FOCUSCODE_AUDIT_HMAC_KEY",
            allowProjectExtensions: false,
            allowedExtensions: [],
          },
          extensions: { host: "process" },
          requireExtensionSignatures: true,
          mcp: { servers: [] },
          pricing: {},
        }
      : {}),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(agentPath, `${JSON.stringify(agentConfig, null, 2)}\n`, "utf8");
  stdout.write(
    `Created ${path}\nCreated ${agentPath}\nReview model, command argv and protected paths, then run with --trust-project.\n`,
  );
}

async function detectVerification(
  repoRoot: string,
): Promise<{ argv: [string, ...string[]] } | undefined> {
  if (await pathExists(join(repoRoot, "pnpm-lock.yaml"))) return { argv: ["pnpm", "test"] };
  if (await pathExists(join(repoRoot, "yarn.lock"))) return { argv: ["yarn", "test"] };
  if (await pathExists(join(repoRoot, "bun.lockb"))) return { argv: ["bun", "test"] };
  if (await pathExists(join(repoRoot, "package.json"))) return { argv: ["npm", "test"] };
  if (await pathExists(join(repoRoot, "pyproject.toml")))
    return { argv: ["python", "-m", "pytest"] };
  if (await pathExists(join(repoRoot, "go.mod"))) return { argv: ["go", "test", "./..."] };
  if (await pathExists(join(repoRoot, "Cargo.toml"))) return { argv: ["cargo", "test"] };
  return undefined;
}

async function runCommand(args: ParsedArgs): Promise<void> {
  const repoRoot = resolve(option(args, "repo", process.cwd())!);
  const stateDirectory = resolve(option(args, "state-dir", join(repoRoot, ".focuscode-state"))!);
  const objective = option(args, "task", args.positionals.join(" "));
  if (!objective) throw new Error("run requires --task <objective>");
  const mode = option(args, "mode", "change");
  if (!mode || !["explore", "change", "review", "verify"].includes(mode)) {
    throw new Error(`Unsupported task mode: ${mode}`);
  }
  const requestedProfile = option(args, "profile", "balanced") ?? "balanced";
  if (!(["balanced", "quality", "local", "fast"] as const).includes(requestedProfile as never)) {
    throw new Error(`Unsupported execution profile: ${requestedProfile}`);
  }
  const task: TaskSpecV1 = {
    schemaVersion: "task-spec.v1",
    repoId: repoRoot,
    baseRef: option(args, "base-ref", "WORKTREE")!,
    mode: mode as TaskSpecV1["mode"],
    objective,
    acceptanceCriteria: [
      { id: "owner-objective", description: objective },
      { id: "registered-verification", description: "Repository verification commands pass" },
    ],
    requestedProfile: requestedProfile as Exclude<TaskSpecV1["requestedProfile"], undefined>,
  };
  assertSchema(TaskSpecSchema, task, "CLI task");
  const approvalMode = (option(args, "approval", stdin.isTTY ? "prompt" : "deny") ??
    "deny") as HarnessApprovalMode;
  if (!(["deny", "prompt", "auto-safe"] as const).includes(approvalMode)) {
    throw new Error(`Unsupported approval mode: ${approvalMode}`);
  }
  if (approvalMode === "prompt" && !stdin.isTTY) {
    throw new Error(
      "Interactive approval requires a TTY; use deny or an explicitly isolated auto-safe run",
    );
  }
  const prompt = approvalMode === "prompt" ? interactiveApproval() : undefined;
  const scriptPath = option(args, "script");
  try {
    const common = {
      repoRoot,
      stateDirectory,
      approvalMode,
      trustRepoConfig: flag(args, "trust-repo-config"),
      ...(prompt ? { approval: prompt.port } : {}),
    };
    const harness = scriptPath
      ? await createLocalHarness({
          ...common,
          model: { kind: "scripted", steps: await readScript(scriptPath) },
        })
      : await createOpenAIHarness(args, common);
    const result = await harness.run(task, {
      ...(option(args, "task-id") ? { taskId: option(args, "task-id")! } : {}),
    });
    stdout.write(
      `${JSON.stringify(
        {
          taskId: result.checkpoint.taskId,
          state: result.checkpoint.state,
          turns: result.checkpoint.turn,
          actions: result.checkpoint.actionCount,
          verification: result.verification?.conclusion,
          stateDirectory,
          ledger: harness.actions.ledgerSnapshot(),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = result.checkpoint.state === "REVIEW_READY" ? 0 : 2;
  } finally {
    prompt?.close();
  }
}

async function createOpenAIHarness(
  args: ParsedArgs,
  common: {
    repoRoot: string;
    stateDirectory: string;
    approvalMode: HarnessApprovalMode;
    trustRepoConfig: boolean;
    approval?: ApprovalPort;
  },
) {
  const modelId = option(args, "model", process.env.FOCUSCODE_MODEL) ?? "";
  const baseUrl = option(args, "base-url", process.env.FOCUSCODE_MODEL_BASE_URL) ?? "";
  const apiKey = option(args, "api-key", process.env.FOCUSCODE_MODEL_API_KEY);
  if (!modelId || !baseUrl) {
    throw new Error(
      "Real model mode requires --model and --base-url (or FOCUSCODE_MODEL and FOCUSCODE_MODEL_BASE_URL).",
    );
  }
  return createLocalHarness({
    ...common,
    model: {
      kind: "openai-compatible",
      modelId,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
    },
  });
}

async function inspectCommand(args: ParsedArgs): Promise<void> {
  const taskId = option(args, "task-id", args.positionals[0]);
  if (!taskId) throw new Error("inspect requires --task-id");
  const stateDirectory = resolve(
    option(args, "state-dir", join(process.cwd(), ".focuscode-state"))!,
  );
  const store = new FileFactStore(stateDirectory);
  const checkpoint = await store.loadCheckpoint(taskId);
  const events = await store.loadEvents(taskId);
  stdout.write(`${JSON.stringify({ checkpoint, events }, null, 2)}\n`);
}

async function exportCommand(args: ParsedArgs): Promise<void> {
  const taskId = option(args, "task-id", args.positionals[0]);
  if (!taskId) throw new Error("export requires --task-id");
  const stateDirectory = resolve(
    option(args, "state-dir", join(process.cwd(), ".focuscode-state"))!,
  );
  const outputDirectory = resolve(
    option(args, "out", join(process.cwd(), `focuscode-export-${taskId}`))!,
  );
  const facts = new FileFactStore(stateDirectory);
  const manifest = await exportTaskAssets({
    taskId,
    facts,
    memory: new FileMemoryStore(stateDirectory),
    outputDirectory,
  });
  stdout.write(`${JSON.stringify({ outputDirectory, manifest }, null, 2)}\n`);
}

function interactiveApproval(): { port: ApprovalPort; close: () => void } {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    port: {
      async request(request) {
        stdout.write(
          `\nApproval required\nTool: ${request.tool.id}\nReason: ${request.reason}\n` +
            `Arguments: ${JSON.stringify(request.intent.arguments)}\n` +
            `Current effects: ${JSON.stringify(request.currentLedger)}\n` +
            `Projected risk: ${request.projectedRiskScore}\n`,
        );
        const answer = await readline.question("Approve this action only? [y/N] ");
        return answer.trim().toLowerCase() === "y";
      },
    },
    close: () => readline.close(),
  };
}

async function readScript(path: string): Promise<ScriptedStep[]> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!Array.isArray(value)) throw new Error("Scripted model file must contain an array");
  return value as ScriptedStep[];
}

function printHelp(): void {
  stdout.write(`FocusCode Harness Alpha\n\n`);
  stdout.write(`  focuscode init [--repo PATH]\n`);
  stdout.write(
    `  focuscode run --repo PATH --task TEXT [--script FILE | --model ID --base-url URL]\n`,
  );
  stdout.write(`                [--approval deny|prompt|auto-safe] [--task-id ID]\n`);
  stdout.write(`                [--trust-repo-config after reviewing registered command argv]\n`);
  stdout.write(`  focuscode inspect --task-id ID [--state-dir PATH]\n`);
  stdout.write(`  focuscode export --task-id ID --out PATH [--state-dir PATH]\n`);
  stdout.write(`  focuscode auth login|list|logout\n`);
  stdout.write(`  focuscode extension install|list|remove|pack\n`);
  stdout.write(`  focuscode share export|import|publish|download\n`);
  stdout.write(`  focuscode sandbox doctor --kind docker|gvisor|vm\n`);
  stdout.write(`  focuscode doctor [--repo PATH] (enterprise readiness)\n`);
  stdout.write(`  focuscode mascots | themes\n`);
  stdout.write(
    `  focuscode skins list|apply <id|path>|import <path>|export <id> <path>|remove <id>\n`,
  );
  stdout.write(`  focuscode character [list|<id>]\n`);
  stdout.write(`  focuscode companion [list|reset]\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isAgentInvocation(argv)) {
    await runAgentCommand(argv);
    return;
  }
  const args = parseArgs(argv);
  switch (args.command) {
    case "init":
      await initCommand(args);
      break;
    case "run":
      await runCommand(args);
      break;
    case "inspect":
      await inspectCommand(args);
      break;
    case "export":
      await exportCommand(args);
      break;
    case "auth":
      await runAuthCommand(argv.slice(1));
      break;
    case "extension":
      await runExtensionCommand(argv.slice(1));
      break;
    case "share":
      await runShareCommand(argv.slice(1));
      break;
    case "sandbox":
      await runSandboxCommand(argv.slice(1));
      break;
    case "doctor":
      await runDoctorCommand(argv.slice(1));
      break;
    case "mascots":
      printMascots();
      break;
    case "themes":
      printThemes();
      break;
    case "skins":
      await runSkinsCommand(argv.slice(1));
      break;
    case "character":
      await runCharacterCommand(argv.slice(1));
      break;
    case "companion":
      await runCompanionCommand(argv.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

// Run only when invoked as the CLI entry point, so tests (and library
// imports) do not execute the command loop. Compare against the realpath:
// globally installed bins are symlinks, while import.meta.url is the
// resolved entry path.
const isMainEntry =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMainEntry) {
  main().catch((error) => {
    process.stderr.write(`focuscode: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
