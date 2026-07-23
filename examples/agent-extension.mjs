// Load with: focuscode --extension ./examples/agent-extension.mjs
export const name = "focuscode-example-extension";

export default function setup(api) {
  api.appendSystemPrompt(
    "Before the final response, inspect git status and state which verification actually ran.",
  );

  api.registerCommand({
    name: "release-checklist",
    description: "Print a small release checklist",
    execute() {
      return [
        "1. Inspect git diff and unintended files",
        "2. Run focused tests, then the repository gate",
        "3. Record residual risks and rollback",
      ].join("\n");
    },
  });

  api.registerTool({
    definition: {
      name: "project_conventions",
      label: "Project conventions",
      description: "Return owner-supplied conventions for this example extension.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
    },
    async execute() {
      return {
        content: "Prefer focused changes, explicit verification, and no unrelated formatting.",
      };
    },
  });
}
