/**
 * Pure render helpers for the TUI slash commands that describe agent state
 * (/goal, /task, /agents, /doctor, /config, /permissions). Keeping them
 * outside the onCommand closure makes them unit-testable and keeps the
 * dispatch chain thin. All outputs are plain text lines for the transcript.
 */
import type {
  AgentStatus,
  SessionSnapshot,
  TodoCounts,
  ToolDefinition,
} from "@focuscode/agent-runtime";

const MAX_GOAL_CHARS = 300;

function lastUserMessage(snapshot: SessionSnapshot): string | undefined {
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index];
    if (entry?.message.role === "user") return entry.message.content;
  }
  return undefined;
}

/** /goal — the current objective: latest user request plus in-flight work. */
export function renderGoalCommand(snapshot: SessionSnapshot, counts: TodoCounts): string {
  const goal = lastUserMessage(snapshot);
  const lines: string[] = [];
  lines.push("Session: " + (snapshot.header.name ?? snapshot.header.sessionId));
  lines.push(
    "Goal: " +
      (goal
        ? goal.replace(/\s+/g, " ").slice(0, MAX_GOAL_CHARS) +
          (goal.length > MAX_GOAL_CHARS ? "…" : "")
        : "(no user request yet — start typing to set the goal)"),
  );
  const inProgress = counts.inProgress ?? 0;
  const pending = counts.pending ?? 0;
  lines.push(
    "Work: " +
      inProgress +
      " in progress, " +
      pending +
      " pending, " +
      (counts.completed ?? 0) +
      " completed" +
      (inProgress === 0 && pending === 0
        ? " (no tasks — /task add <content>)"
        : " — /task to list"),
  );
  return lines.join("\n");
}

/** /task — the task list with a summary line on top. */
export function renderTaskCommand(todoListContent: string, counts: TodoCounts): string {
  const lines: string[] = [];
  lines.push(
    "Tasks: " +
      (counts.inProgress ?? 0) +
      " in progress, " +
      (counts.pending ?? 0) +
      " pending, " +
      (counts.completed ?? 0) +
      " completed",
  );
  const list = todoListContent.trim();
  lines.push(list || "(no tasks — /task add <content>, or let the agent plan with the todo tool)");
  return lines.join("\n");
}

/** /agents — subagent activity in this session plus the main agent identity. */
export function renderAgentsCommand(snapshot: SessionSnapshot, status: AgentStatus): string {
  const delegates = snapshot.entries.filter((entry) => entry.message.toolName === "delegate");
  const lines: string[] = [];
  lines.push("Main agent: " + status.provider + "/" + status.model + " · " + status.approval);
  if (delegates.length === 0) {
    lines.push("Subagents: none yet — the model can spawn one via the delegate tool.");
  } else {
    lines.push("Subagents (" + delegates.length + " delegate call(s)):");
    for (const entry of delegates.slice(-5)) {
      const content = entry.message.content.replace(/\s+/g, " ").slice(0, 140);
      lines.push("  · " + (content || "(delegate call)"));
    }
    lines.push("  (see /tree for the session structure)");
  }
  return lines.join("\n");
}

/** /doctor — lightweight environment and session health summary. */
export function renderDoctorCommand(
  status: AgentStatus,
  checkpointCount: number,
  sessionCount: number,
): string {
  const context = status.context;
  return [
    "Environment: node " + process.versions.node + " · " + process.platform + " " + process.arch,
    "Provider: " + status.provider + "/" + status.model + " · " + status.protocol,
    "Approval: " + status.approval + (status.projectTrusted ? " · project trusted" : ""),
    "Session: " +
      status.sessionId +
      " · " +
      status.entries +
      " entries · " +
      (status.activeLeafId ? "leaf " + status.activeLeafId : ""),
    "Context: ~" +
      (context?.estimatedTokens ?? 0) +
      " tokens / " +
      (context?.contextWindow ?? 0) +
      " window" +
      (context?.compacted ? " · compacted" : ""),
    "Steering: " +
      (status.steering?.queued ?? 0) +
      " queued" +
      (status.steering?.running ? " · running" : ""),
    "Checkpoints: " + checkpointCount + " · Sessions on disk: " + sessionCount,
  ].join("\n");
}

/** /config — the resolved configuration summary (no secrets). */
export function renderConfigCommand(
  status: AgentStatus,
  sandboxKind: string | undefined,
  sessionDirectory: string,
): string {
  return [
    "Provider: " + status.provider + "/" + status.model,
    "Protocol: " + status.protocol,
    "Approval: " + status.approval + (status.projectTrusted ? " (project trusted)" : ""),
    "Sandbox: " + (sandboxKind ?? "auto"),
    "Session directory: " + sessionDirectory,
    "Working directory: " + status.cwd,
    "Change with: /model [provider/model] · /approval <ask|auto-edit|full-auto|deny>",
  ].join("\n");
}

/** /permissions — approval mode plus the tool effect profile. */
export function renderPermissionsCommand(approval: string, tools: ToolDefinition[]): string {
  const byEffect = new Map<string, number>();
  for (const tool of tools) {
    const effect = tool.effect || "other";
    byEffect.set(effect, (byEffect.get(effect) ?? 0) + 1);
  }
  const profile = [...byEffect.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([effect, count]) => effect + " × " + count)
    .join(" · ");
  return [
    "Approval mode: " + approval + " (change with /approval)",
    "Tools: " + tools.length + " registered — " + profile,
    "Non-TTY/automated contexts degrade ask → deny.",
  ].join("\n");
}
