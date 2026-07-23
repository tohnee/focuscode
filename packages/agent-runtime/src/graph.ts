/**
 * Task graph (DAG) data structures and topological sort.
 *
 * A `TaskGraph` is a set of nodes (id + executor + dependencies). Nodes are
 * scheduled so that every node runs after all of its declared dependencies.
 * Cycles and missing dependencies are reported as errors before any executor
 * runs. The executor receives a `TaskExecutionContext` with access to upstream
 * results so it can compose outputs.
 */

import { SessionStore } from "./session-store.js";
import { AgentToolRegistry } from "./tools.js";
import type {
  AgentRuntimeOptions,
  AgentTool,
  ModelClient,
  ModelProfile,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

export interface TaskExecutionContext {
  readonly nodeId: string;
  readonly results: ReadonlyMap<string, string>;
  readonly signal: AbortSignal | undefined;
}

export interface TaskNode {
  readonly id: string;
  readonly executor: (context: TaskExecutionContext) => Promise<string>;
  readonly dependencies: readonly string[];
}

export interface TaskGraph {
  readonly nodes: readonly TaskNode[];
  readonly nodeMap: ReadonlyMap<string, TaskNode>;
}

export class GraphCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`Cycle detected in task graph: ${cycle.join(" -> ")}`);
    this.name = "GraphCycleError";
  }
}

/**
 * Build a `TaskGraph` from a list of nodes. Throws if duplicate ids are found.
 * Does not validate dependencies or cycles — use `topologicalSort` for that.
 */
export function createTaskGraph(nodes: readonly TaskNode[]): TaskGraph {
  const nodeMap = new Map<string, TaskNode>();
  for (const node of nodes) {
    if (nodeMap.has(node.id)) {
      throw new Error(`Duplicate task node id: ${node.id}`);
    }
    nodeMap.set(node.id, node);
  }
  return { nodes, nodeMap };
}

/**
 * Kahn's algorithm: returns nodes in an order where every node appears after
 * all of its dependencies. Throws `GraphCycleError` if a cycle exists, or
 * `Error` if a dependency references a non-existent node.
 */
export function topologicalSort(graph: TaskGraph): TaskNode[] {
  const { nodeMap } = graph;
  // Validate dependencies reference real nodes.
  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      if (!nodeMap.has(dep)) {
        throw new Error(`Task '${node.id}' depends on non-existent task '${dep}'`);
      }
    }
  }
  // Compute in-degrees.
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.id, node.dependencies.length);
  }
  // Initialize the queue with zero-in-degree nodes, preserving input order so
  // the resulting order is deterministic for graphs without a strict total.
  const queue: string[] = graph.nodes.filter((n) => n.dependencies.length === 0).map((n) => n.id);
  const sorted: TaskNode[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodeMap.get(id)!;
    sorted.push(node);
    visited.add(id);
    // Decrement in-degree of every node that depends on this one.
    for (const candidate of graph.nodes) {
      if (candidate.dependencies.includes(id)) {
        const newDegree = (inDegree.get(candidate.id) ?? 0) - 1;
        inDegree.set(candidate.id, newDegree);
        if (newDegree === 0 && !visited.has(candidate.id)) {
          queue.push(candidate.id);
        }
      }
    }
  }
  if (sorted.length !== graph.nodes.length) {
    // Remaining nodes are part of one or more cycles.
    const cycleNodes = graph.nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
    throw new GraphCycleError(cycleNodes);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Parallel executor: walk a TaskGraph level by level, running independent
// nodes concurrently up to `maxConcurrency`, honouring fail-fast vs
// continue-on-error and abort signals.
// ---------------------------------------------------------------------------

export interface NodeResult {
  readonly nodeId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

export interface GraphExecutionOptions {
  /** Continue executing independent nodes after a failure; default false (fail-fast). */
  readonly continueOnError?: boolean;
  /** Maximum number of nodes executing concurrently; default 4. */
  readonly maxConcurrency?: number;
  /** Abort signal; when triggered, pending nodes are skipped. */
  readonly signal?: AbortSignal;
}

export interface GraphExecutionResult {
  /** True if every node succeeded. */
  readonly completed: boolean;
  /** Why execution stopped: all_succeeded | node_failed | aborted. */
  readonly reason: "all_succeeded" | "node_failed" | "aborted";
  /** Successful node outputs keyed by node id. */
  readonly results: Map<string, string>;
  /** Failed node errors keyed by node id. */
  readonly errors: Map<string, Error>;
  /** Nodes that were skipped (dependents of failed nodes or aborted). */
  readonly skipped: string[];
}

/**
 * Run a `TaskGraph` honouring dependency order. Independent ready nodes are
 * dispatched in parallel up to `maxConcurrency`; dependent nodes wait for all
 * their dependencies to resolve (succeed or fail). The default policy is
 * fail-fast: the first failure halts the remaining schedule. With
 * `continueOnError: true`, independent nodes still run; only the dependents
 * of failed nodes are skipped.
 */
export async function runTaskGraph(
  graph: TaskGraph,
  options: GraphExecutionOptions,
): Promise<GraphExecutionResult> {
  const { continueOnError = false, maxConcurrency = 4, signal } = options;
  const sorted = topologicalSort(graph);
  const results = new Map<string, string>();
  const errors = new Map<string, Error>();
  const skipped: string[] = [];
  const failed = new Set<string>();
  let aborted = false;
  let hadFailure = false;

  // Pending nodes — we remove each id as it gets resolved (succeeded, failed,
  // or skipped). At each iteration we collect "ready" nodes whose dependencies
  // all have a known outcome.
  const pending = new Set(sorted.map((n) => n.id));

  while (pending.size > 0) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    const ready: TaskNode[] = [];
    for (const id of pending) {
      const node = graph.nodeMap.get(id)!;
      const deps = node.dependencies;
      const allResolved = deps.every((dep) => results.has(dep) || failed.has(dep));
      if (!allResolved) continue;
      // If any dependency failed, this node is skipped and propagates the
      // failure downstream.
      const depFailed = deps.some((dep) => failed.has(dep));
      if (depFailed) {
        pending.delete(id);
        skipped.push(id);
        failed.add(id);
        continue;
      }
      ready.push(node);
    }
    for (const node of ready) pending.delete(node.id);

    if (ready.length === 0) {
      // No ready nodes but pending remain. After a successful topological
      // sort this only happens when every remaining pending node had a failed
      // dependency; the loop above will have moved them to `skipped`. Bail
      // out defensively to avoid an infinite loop.
      break;
    }

    // Execute ready nodes in batches of at most `maxConcurrency`. We dispatch
    // each batch concurrently and wait for the whole batch to settle before
    // moving to the next; this gives us a deterministic concurrency ceiling.
    for (let i = 0; i < ready.length; i += maxConcurrency) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      const batch = ready.slice(i, i + maxConcurrency);
      const settled = await Promise.allSettled(
        batch.map(async (node) => {
          const ctx: TaskExecutionContext = {
            nodeId: node.id,
            results,
            signal,
          };
          return node.executor(ctx);
        }),
      );
      for (let j = 0; j < batch.length; j++) {
        const node = batch[j]!;
        const r = settled[j]!;
        if (r.status === "fulfilled") {
          results.set(node.id, r.value);
        } else {
          const error = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
          errors.set(node.id, error);
          failed.add(node.id);
          hadFailure = true;
        }
      }
      if (hadFailure && !continueOnError) break;
    }

    if (signal?.aborted) {
      aborted = true;
      break;
    }
    if (aborted) break;
    if (hadFailure && !continueOnError) break;
  }

  // Any pending ids left over were cut short by abort or fail-fast.
  for (const id of pending) skipped.push(id);

  let reason: GraphExecutionResult["reason"];
  if (aborted) reason = "aborted";
  else if (errors.size > 0) reason = "node_failed";
  else reason = "all_succeeded";
  const completed = errors.size === 0 && !aborted && skipped.length === 0;
  return { completed, reason, results, errors, skipped };
}

// ---------------------------------------------------------------------------
// graph tool: lets the model declare a DAG of sub-tasks and execute them in
// dependency order. Each node runs in a child agent created via the same
// DelegateContext.createAgent mechanism as the delegate tool.
// ---------------------------------------------------------------------------

const GRAPH_MAX_NODES = 20;
const GRAPH_NODE_TASK_MAX = 4_000;
const GRAPH_RESULT_EXCERPT = 500;
const GRAPH_CHILD_MAX_ROUNDS = 8;
/**
 * Tools never handed to a graph child agent: no nested graph, no delegate, no
 * shell. (todo is always re-registered by the CodingAgent constructor, so
 * excluding it here would be misleading — it is harmless for child agents.)
 */
const GRAPH_EXCLUDED_TOOLS = new Set(["graph", "delegate", "bash"]);

/** The surface the graph tool needs from its host agent. */
export interface GraphToolContext {
  readonly cwd: string;
  readonly model: ModelProfile;
  readonly modelClient: ModelClient;
  readonly registry: AgentToolRegistry;
  readonly permission: AgentRuntimeOptions["permission"];
  readonly instructions?: string[];
  /**
   * Config-level defaults for graph execution. The model may override
   * `continueOnError` per-call via the tool argument; `maxConcurrency` is
   * always capped by this value.
   */
  readonly graphDefaults?: {
    maxConcurrency: number;
    continueOnError: boolean;
  };
  createAgent(options: AgentRuntimeOptions): Promise<{
    submit(input: string, signal?: AbortSignal): Promise<{ content: string }>;
  }>;
}

/**
 * Build the `graph` tool. The tool lets the model declare a DAG of sub-tasks
 * and execute them in dependency order. Each node runs in a fresh child agent
 * (same model, workspace, permission handler) with a trimmed tool registry.
 * The tool returns a textual summary of per-node outcomes; full child outputs
 * are truncated to keep the parent's context window manageable.
 */
export function createGraphTool(getContext: () => GraphToolContext): AgentTool {
  return {
    definition: {
      name: "graph",
      label: "Task graph",
      description:
        "Declare a DAG of sub-tasks and execute them in dependency order. " +
        "Each node runs in a child agent with the same workspace and model. " +
        "Returns a summary of per-node outcomes (succeeded/failed/skipped).",
      parameters: {
        type: "object",
        required: ["nodes"],
        properties: {
          nodes: {
            type: "array",
            minItems: 1,
            maxItems: GRAPH_MAX_NODES,
            items: {
              type: "object",
              required: ["id", "task"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                task: { type: "string", minLength: 1, maxLength: GRAPH_NODE_TASK_MAX },
                dependencies: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              additionalProperties: false,
            },
          },
          continueOnError: { type: "boolean" },
        },
        additionalProperties: false,
      },
      effect: "write",
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const rawNodes = Array.isArray(args.nodes) ? (args.nodes as unknown[]) : [];
      if (rawNodes.length === 0) {
        return { content: "graph: no nodes provided", isError: true };
      }
      if (rawNodes.length > GRAPH_MAX_NODES) {
        return { content: `graph: too many nodes (max ${GRAPH_MAX_NODES})`, isError: true };
      }
      const host = getContext();
      const continueOnError =
        typeof args.continueOnError === "boolean"
          ? args.continueOnError
          : (host.graphDefaults?.continueOnError ?? false);
      const maxConcurrency = host.graphDefaults?.maxConcurrency ?? 4;
      const childRegistry = new AgentToolRegistry(
        host.registry.values().filter((t) => !GRAPH_EXCLUDED_TOOLS.has(t.definition.name)),
      );
      const taskNodes: TaskNode[] = rawNodes.map((raw) => {
        const r = raw as { id: string; task: string; dependencies?: string[] };
        return {
          id: r.id,
          dependencies: r.dependencies ?? [],
          executor: async (execCtx) => {
            const child = await host.createAgent({
              cwd: host.cwd,
              model: host.model,
              modelClient: host.modelClient,
              tools: childRegistry.values(),
              toolRegistry: childRegistry,
              permission: host.permission,
              sessionStore: new SessionStore("graph", false),
              maxRounds: GRAPH_CHILD_MAX_ROUNDS,
              ...(host.instructions?.length ? { instructions: host.instructions } : {}),
            });
            const childResult = await child.submit(r.task, execCtx.signal);
            return childResult.content.length > GRAPH_NODE_TASK_MAX
              ? `${childResult.content.slice(0, GRAPH_NODE_TASK_MAX)}...`
              : childResult.content;
          },
        };
      });
      let graph: TaskGraph;
      try {
        graph = createTaskGraph(taskNodes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `graph: invalid task graph — ${message}`, isError: true };
      }
      let result: GraphExecutionResult;
      try {
        result = await runTaskGraph(graph, {
          continueOnError,
          maxConcurrency,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (err) {
        if (err instanceof GraphCycleError) {
          return { content: `graph: cycle detected — ${err.cycle.join(" -> ")}`, isError: true };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { content: `graph: execution failed — ${message}`, isError: true };
      }
      const lines: string[] = [
        `graph: ${result.completed ? "completed" : "incomplete"} (${result.reason})`,
        `succeeded: ${result.results.size}, failed: ${result.errors.size}, skipped: ${result.skipped.length}`,
      ];
      for (const [id, output] of result.results) {
        const trimmed =
          output.length > GRAPH_RESULT_EXCERPT
            ? `${output.slice(0, GRAPH_RESULT_EXCERPT)}...`
            : output;
        lines.push(`  ok ${id}: ${trimmed}`);
      }
      for (const [id, error] of result.errors) {
        lines.push(`  fail ${id}: ${error.message}`);
      }
      for (const id of result.skipped) {
        lines.push(`  skip ${id}: skipped`);
      }
      return {
        content: lines.join("\n"),
        metadata: {
          completed: result.completed,
          reason: result.reason,
          succeeded: result.results.size,
          failed: result.errors.size,
          skipped: result.skipped.length,
        },
      };
    },
  };
}
