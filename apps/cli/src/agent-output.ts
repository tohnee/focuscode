import type { AgentEvent, PermissionRequest } from "@focuscode/agent-runtime";
import type { Writable } from "node:stream";

export interface HumanRendererOptions {
  output?: Writable;
  diagnostics?: Writable;
  color?: boolean;
  quietTools?: boolean;
  showReasoning?: boolean;
}

export class HumanEventRenderer {
  private readonly output: Writable;
  private readonly diagnostics: Writable;
  private readonly color: boolean;
  private assistantOpen = false;

  constructor(private readonly options: HumanRendererOptions = {}) {
    this.output = options.output ?? process.stdout;
    this.diagnostics = options.diagnostics ?? process.stderr;
    this.color = options.color ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "text_delta":
        this.output.write(terminalSafe(event.delta));
        this.assistantOpen = true;
        break;
      case "reasoning_delta":
        if (this.options.showReasoning)
          this.diagnostics.write(dim(terminalSafe(event.delta), this.color));
        break;
      case "tool_start":
        this.breakAssistant();
        if (!this.options.quietTools) {
          this.diagnostics.write(
            `${cyan("→", this.color)} ${bold(event.call.name, this.color)} ${dim(summarizeArguments(event.call.arguments), this.color)}\n`,
          );
        }
        break;
      case "tool_end":
        if (!this.options.quietTools) {
          const marker = event.result.isError ? red("✗", this.color) : green("✓", this.color);
          this.diagnostics.write(
            `${marker} ${event.call.name} ${dim(`${event.durationMs}ms · ${firstLine(event.result.content)}`, this.color)}\n`,
          );
        }
        break;
      case "approval_required":
        this.breakAssistant();
        this.diagnostics.write(
          `${yellow("!", this.color)} approval required: ${event.request.tool.name} (${event.request.risk})\n`,
        );
        break;
      case "compaction":
        this.diagnostics.write(
          `${dim(`↺ compacted ${event.droppedMessages} historical messages`, this.color)}\n`,
        );
        break;
      case "usage":
        this.breakAssistant();
        this.diagnostics.write(
          `${dim(`tokens: ${event.turn.inputTokens} in / ${event.turn.outputTokens} out · session ${event.session.inputTokens + event.session.outputTokens}`, this.color)}\n`,
        );
        break;
      case "error":
        this.breakAssistant();
        this.diagnostics.write(`${red(`error: ${terminalSafe(event.message)}`, this.color)}\n`);
        break;
      case "agent_end":
        this.breakAssistant();
        break;
      default:
        break;
    }
  }

  finishLine(): void {
    this.breakAssistant();
  }

  private breakAssistant(): void {
    if (!this.assistantOpen) return;
    this.output.write("\n");
    this.assistantOpen = false;
  }
}

export async function promptApproval(
  request: PermissionRequest,
  question: (prompt: string) => Promise<string>,
): Promise<boolean> {
  const details = summarizeArguments(request.arguments, 500);
  process.stderr.write(
    `\n${terminalSafe(request.tool.label)} requires approval\nRisk: ${request.risk}\nReason: ${terminalSafe(request.reason)}\nArguments: ${details}\n`,
  );
  const answer = (await question("Allow this action once? [y/N] ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export function jsonEventWriter(output: Writable = process.stdout) {
  return (event: AgentEvent): void => {
    output.write(`${JSON.stringify({ schemaVersion: "focuscode-event.v1", ...event })}\n`);
  };
}

export function printBanner(status: {
  model: string;
  provider: string;
  cwd: string;
  sessionId: string;
  approval: string;
  projectTrusted: boolean;
}): void {
  const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  process.stdout.write(
    `${bold("FocusCode", color)} ${dim("CLI Coding Agent 0.5.0", color)}\n` +
      `${dim(`${terminalSafe(status.provider)}/${terminalSafe(status.model)} · ${status.approval} · ${status.projectTrusted ? "project trusted" : "project config ignored"}`, color)}\n` +
      `${dim(`${terminalSafe(status.cwd)} · session ${shortId(status.sessionId)}`, color)}\n` +
      `${dim("Type /help for commands; !command runs a permission-gated shell command.", color)}\n\n`,
  );
}

export function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 16)}…` : id;
}

function summarizeArguments(value: Record<string, unknown>, limit = 180): string {
  const rendered = JSON.stringify(value);
  return rendered.length <= limit ? rendered : `${rendered.slice(0, limit)}…`;
}

function firstLine(value: string): string {
  const line =
    terminalSafe(value)
      .split("\n")
      .find((entry) => entry.trim()) ?? "no output";
  return line.length <= 160 ? line : `${line.slice(0, 160)}…`;
}

export function terminalSafe(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function style(open: string, close: string, value: string, enabled: boolean): string {
  return enabled ? `${open}${value}${close}` : value;
}

function bold(value: string, enabled: boolean): string {
  return style("\u001b[1m", "\u001b[22m", value, enabled);
}

function dim(value: string, enabled: boolean): string {
  return style("\u001b[2m", "\u001b[22m", value, enabled);
}

function cyan(value: string, enabled: boolean): string {
  return style("\u001b[36m", "\u001b[39m", value, enabled);
}

function green(value: string, enabled: boolean): string {
  return style("\u001b[32m", "\u001b[39m", value, enabled);
}

function yellow(value: string, enabled: boolean): string {
  return style("\u001b[33m", "\u001b[39m", value, enabled);
}

function red(value: string, enabled: boolean): string {
  return style("\u001b[31m", "\u001b[39m", value, enabled);
}
