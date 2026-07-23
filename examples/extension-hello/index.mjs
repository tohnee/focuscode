export const name = "hello-extension";

export default function activate(api) {
  let completedTurns = 0;
  api.registerCommand({
    name: "hello",
    description: "Greet the current FocusCode session",
    execute(args, context) {
      const target = args.trim() || "coder";
      return `Hello ${target}! Session ${context.sessionId} has completed ${completedTurns} turn(s).`;
    },
  });
  api.registerTool({
    definition: {
      name: "workspace_clock",
      label: "Workspace clock",
      description: "Return the current time and active workspace without changing state",
      parameters: { type: "object", additionalProperties: false },
      effect: "read",
    },
    async execute(_arguments, context) {
      return {
        content: JSON.stringify({ cwd: context.cwd, now: new Date().toISOString() }),
      };
    },
  });
  api.onEvent((event) => {
    if (event.type === "agent_end") completedTurns += 1;
  });
  api.appendSystemPrompt(
    "The workspace_clock tool is read-only and should be used only when time is relevant.",
  );
}
