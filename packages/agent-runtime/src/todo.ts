import type { AgentTool } from "./types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

const MAX_ITEMS = 50;
const MAX_CONTENT_CHARS = 200;
const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** In-memory task list shared by the todo tool, the system prompt and the CLI status bar. */
export class TodoState {
  private items: TodoItem[] = [];

  set(items: TodoItem[]): void {
    if (!Array.isArray(items) || items.length > MAX_ITEMS) {
      throw new Error(`todo items must be an array of at most ${MAX_ITEMS} entries`);
    }
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (!item || typeof item.id !== "string" || !item.id.trim()) {
        throw new Error(`todo item ${index + 1} requires a non-empty id`);
      }
      if (ids.has(item.id)) throw new Error(`Duplicate todo item id: ${item.id}`);
      ids.add(item.id);
      if (
        typeof item.content !== "string" ||
        !item.content.trim() ||
        item.content.length > MAX_CONTENT_CHARS
      ) {
        throw new Error(`todo item ${item.id} content must be 1-${MAX_CONTENT_CHARS} characters`);
      }
      if (!STATUSES.includes(item.status)) {
        throw new Error(`todo item ${item.id} has invalid status: ${String(item.status)}`);
      }
    }
    this.items = items.map((item) => ({ ...item }));
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  counts(): TodoCounts {
    const counts: TodoCounts = { pending: 0, inProgress: 0, completed: 0 };
    for (const item of this.items) {
      if (item.status === "pending") counts.pending += 1;
      else if (item.status === "in_progress") counts.inProgress += 1;
      else counts.completed += 1;
    }
    return counts;
  }
}

export function renderTodoItems(items: TodoItem[]): string {
  return items
    .map(
      (item) =>
        `- [${item.status === "completed" ? "x" : item.status === "in_progress" ? "~" : " "}] ${item.id}: ${item.content}`,
    )
    .join("\n");
}

export function createTodoTool(state: TodoState): AgentTool {
  return {
    definition: {
      name: "todo",
      label: "Task list",
      description:
        "Track the plan for this session. Use set to replace the whole task list and list to read it back.",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["set", "list"] },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "content", "status"],
              properties: {
                id: { type: "string" },
                content: { type: "string", maxLength: MAX_CONTENT_CHARS },
                status: { type: "string", enum: STATUSES },
              },
              additionalProperties: false,
            },
            maxItems: MAX_ITEMS,
          },
        },
        additionalProperties: false,
      },
      effect: "read",
    },
    async execute(input) {
      const action = input.action;
      if (action === "list") {
        const items = state.list();
        return {
          content: items.length ? renderTodoItems(items) : "Task list is empty",
          metadata: { items: items.length, counts: state.counts() },
        };
      }
      if (action === "set") {
        if (!Array.isArray(input.items)) {
          throw new Error("todo set requires an items array");
        }
        const items = input.items.map((item) => {
          if (!item || typeof item !== "object") {
            throw new Error("todo items must be objects with id, content and status");
          }
          return item as TodoItem;
        });
        state.set(items);
        return {
          content: `Task list updated (${items.length} item(s))${
            items.length ? `\n${renderTodoItems(state.list())}` : ""
          }`,
          metadata: { items: items.length, counts: state.counts() },
        };
      }
      throw new Error(`Unknown todo action: ${String(action)}`);
    },
  };
}
