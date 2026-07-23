import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type {
  AgentResources,
  ApprovalMode,
  CodingAgent,
  ExtensionHostLike,
  ModelProfile,
  SessionStore,
} from "@focuscode/agent-runtime";
import { activeBranch, expandPromptTemplate, renderSessionHtml } from "@focuscode/agent-runtime";
import { HumanEventRenderer, printBanner, shortId, terminalSafe } from "./agent-output.js";

export class TerminalPrompter {
  readonly readline = createInterface({ input: process.stdin, output: process.stdout });

  async ask(prompt: string): Promise<string> {
    return this.readline.question(prompt);
  }

  close(): void {
    this.readline.close();
  }
}

export interface InteractiveOptions {
  agent: CodingAgent;
  sessions: SessionStore;
  resources: AgentResources;
  extensions: ExtensionHostLike;
  prompter: TerminalPrompter;
  initialPrompt?: string;
  changeModel(spec: string): Promise<ModelProfile>;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const renderer = new HumanEventRenderer();
  options.agent.setEventSink((event) => renderer.handle(event));
  const status = await options.agent.status();
  printBanner(status);
  let interruptedAt = 0;
  const onSigint = () => {
    if (options.agent.abort()) {
      process.stderr.write("\nAborting current turn…\n");
      return;
    }
    const now = Date.now();
    if (now - interruptedAt < 1_500) {
      options.prompter.close();
      return;
    }
    interruptedAt = now;
    process.stderr.write("\nPress Ctrl+C again to exit, or /exit.\n");
  };
  process.on("SIGINT", onSigint);
  try {
    if (options.initialPrompt) await submit(options.agent, options.initialPrompt, renderer);
    while (true) {
      let line: string;
      try {
        line = await readMultiline(options.prompter);
      } catch {
        break;
      }
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input.startsWith("/")) {
        const handled = await slashCommand(input, options, renderer);
        if (handled) continue;
      }
      if (input.startsWith("!")) {
        const command = input.slice(1).trim();
        if (!command) continue;
        const result = await options.agent.runTool("bash", { command });
        process.stdout.write(`${terminalSafe(result.content)}\n`);
        continue;
      }
      await submit(options.agent, line, renderer);
    }
  } finally {
    process.off("SIGINT", onSigint);
    renderer.finishLine();
  }
}

async function slashCommand(
  input: string,
  options: InteractiveOptions,
  renderer: HumanEventRenderer,
): Promise<boolean> {
  const [rawName, ...parts] = input.slice(1).split(/\s+/);
  const name = rawName?.toLowerCase() ?? "";
  const args = parts.join(" ");
  switch (name) {
    case "help":
      printInteractiveHelp(options);
      return true;
    case "status":
      process.stdout.write(`${JSON.stringify(await options.agent.status(), null, 2)}\n`);
      return true;
    case "tools": {
      for (const tool of options.agent.toolDefinitions()) {
        process.stdout.write(
          `${tool.name.padEnd(16)} ${tool.effect.padEnd(7)} ${terminalSafe(tool.description)}\n`,
        );
      }
      const loaded = options.extensions.list();
      if (loaded.length)
        process.stdout.write(`Extensions: ${loaded.map((item) => item.name).join(", ")}\n`);
      return true;
    }
    case "compact": {
      const result = await options.agent.compact();
      process.stdout.write(`Compacted ${result.droppedMessages} messages.\n`);
      return true;
    }
    case "name":
      if (!args) throw new Error("Usage: /name <session name>");
      await options.agent.nameSession(args);
      process.stdout.write(`Session named ${args}\n`);
      return true;
    case "new": {
      const id = await options.agent.newSession(args || undefined);
      process.stdout.write(`Started session ${id}\n`);
      return true;
    }
    case "sessions":
      printSessions(await options.sessions.list((await options.agent.status()).cwd));
      return true;
    case "resume":
      if (!args) throw new Error("Usage: /resume <session id or prefix>");
      process.stdout.write(`Switched to ${await options.agent.switchSession(args)}\n`);
      return true;
    case "fork": {
      const id = await options.agent.forkSession(args || undefined);
      process.stdout.write(`Forked into session ${id}\n`);
      return true;
    }
    case "tree": {
      const snapshot = options.agent.snapshot();
      const active = new Set(activeBranch(snapshot).map((entry) => entry.entryId));
      for (const entry of snapshot.entries) {
        const marker =
          entry.entryId === snapshot.activeLeafId ? "*" : active.has(entry.entryId) ? "│" : "·";
        process.stdout.write(
          `${marker} ${shortId(entry.entryId)} ${entry.message.role.padEnd(9)} ${terminalSafe(entry.message.content).replace(/\s+/g, " ").slice(0, 90)}\n`,
        );
      }
      return true;
    }
    case "branch":
      if (!args) throw new Error("Usage: /branch <entry id>");
      await options.agent.moveLeaf(args);
      process.stdout.write(`Active leaf moved to ${args}\n`);
      return true;
    case "export": {
      const path = resolve(args || `focuscode-session-${options.agent.sessionId}.html`);
      await writeFile(path, renderSessionHtml(options.agent.snapshot()), "utf8");
      process.stdout.write(`Exported ${path}\n`);
      return true;
    }
    case "approval": {
      if (!isApprovalMode(args)) {
        throw new Error("Usage: /approval ask|auto-edit|full-auto|deny");
      }
      options.agent.changeApproval(args);
      process.stdout.write(`Approval mode: ${args}\n`);
      return true;
    }
    case "model":
      if (!args) {
        const current = await options.agent.status();
        process.stdout.write(`${current.provider}/${current.model} (${current.protocol})\n`);
      } else {
        const model = await options.changeModel(args);
        process.stdout.write(`Model changed to ${model.provider}/${model.model}\n`);
      }
      return true;
    case "skills":
      if (!options.resources.skills.length) process.stdout.write("No skills discovered.\n");
      for (const skill of options.resources.skills) {
        process.stdout.write(`/${skill.name} — ${skill.description} [${skill.scope}]\n`);
      }
      return true;
    case "reload": {
      const loaded = await options.extensions.reload();
      process.stdout.write(`Reloaded ${loaded.length} extension(s).\n`);
      return true;
    }
    case "skill": {
      const [skillName, ...skillArgs] = parts;
      const skill = options.resources.skills.find((item) => item.name === skillName);
      if (!skill) throw new Error(`Unknown skill: ${skillName ?? ""}`);
      await submit(
        options.agent,
        `Apply the following skill to this request.\n\n${skill.content}\n\nRequest: ${skillArgs.join(" ") || "Continue the current task."}`,
        renderer,
      );
      return true;
    }
    case "clear":
      process.stdout.write("\u001b[2J\u001b[H");
      return true;
    default:
      break;
  }
  const prompt = options.resources.prompts.find((item) => item.name === name);
  if (prompt) {
    await submit(options.agent, expandPromptTemplate(prompt, args), renderer);
    return true;
  }
  const extension = options.extensions.getCommand(name);
  if (extension) {
    const status = await options.agent.status();
    const result = await extension.execute(args, {
      sessionId: options.agent.sessionId,
      cwd: status.cwd,
    });
    if (result) process.stdout.write(`${terminalSafe(result)}\n`);
    return true;
  }
  return false;
}

async function submit(
  agent: CodingAgent,
  prompt: string,
  renderer: HumanEventRenderer,
): Promise<void> {
  try {
    await agent.submit(prompt);
  } catch (error) {
    renderer.finishLine();
    process.stderr.write(
      `${terminalSafe(error instanceof Error ? error.message : String(error))}\n`,
    );
  }
}

async function readMultiline(prompter: TerminalPrompter): Promise<string> {
  const lines: string[] = [];
  while (true) {
    const line = await prompter.ask(lines.length === 0 ? "focus> " : "....> ");
    if (line.endsWith("\\") && !line.endsWith("\\\\")) {
      lines.push(line.slice(0, -1));
      continue;
    }
    lines.push(line);
    return lines.join("\n");
  }
}

function printInteractiveHelp(options: InteractiveOptions): void {
  process.stdout.write(`
/help                 Show this help
/status               Model, session, token and context status
/tools                List coding tools and extensions
/compact              Compact older session context
/sessions             List sessions for this workspace
/resume <id>           Switch to a saved session
/new [name]            Start a new session
/tree                  Show the current session tree
/branch <entry-id>     Continue from an earlier entry
/fork [entry-id]       Fork the current session
/name <name>           Name the current session
/model [provider/id]   Show or change model
/approval <mode>       ask | auto-edit | full-auto | deny
/skills                List discovered skills
/skill <name> [task]   Invoke a skill explicitly
/reload                Hot-reload JavaScript extensions
/export [file.html]    Export the active branch
/clear                 Clear the terminal
/exit                  Exit
!command               Run a permission-gated shell command
\ at line end          Continue multiline input
`);
  const dynamic = [
    ...options.resources.prompts.map((prompt) => `/${prompt.name} — ${prompt.description}`),
    ...options.extensions
      .commandList()
      .map((command) => `/${command.name} — ${command.description}`),
  ];
  if (dynamic.length) process.stdout.write(`\nCustom commands:\n${dynamic.join("\n")}\n`);
}

function printSessions(sessions: Awaited<ReturnType<SessionStore["list"]>>): void {
  if (!sessions.length) {
    process.stdout.write("No sessions found.\n");
    return;
  }
  for (const session of sessions) {
    process.stdout.write(
      `${shortId(session.sessionId)} ${session.name ?? "(unnamed)"} · ${session.model} · ${session.entries} entries\n  ${session.preview}\n`,
    );
  }
}

function isApprovalMode(value: string): value is ApprovalMode {
  return ["ask", "auto-edit", "full-auto", "deny"].includes(value);
}
