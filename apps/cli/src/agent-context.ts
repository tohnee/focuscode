/**
 * Shared agent creation context extracted from agent-command.ts and acp-server.ts.
 * Creates the sandbox, tool registry, agent resources, model client, and config
 * needed to construct a CodingAgent. Both the CLI entry point and the ACP server
 * use this to avoid duplicating the setup logic.
 */
import type { AgentCliArgs } from "./agent-args.js";
import { buildModelClientChain } from "./model-client-wiring.js";
import { oauthAccessTokenProvider } from "./auth-command.js";
import { createSandbox } from "@focuscode/sandbox";
import {
  createCodingToolRegistry,
  createModelClient,
  loadAgentResources,
  resolveAgentConfig,
  type AgentConfigOverrides,
  type ModelClient,
  type ResolvedAgentConfig,
  type AgentToolRegistry,
} from "@focuscode/agent-runtime";

export interface AgentContext {
  cwd: string;
  sandbox: Awaited<ReturnType<typeof createSandbox>>;
  registry: AgentToolRegistry;
  resources: Awaited<ReturnType<typeof loadAgentResources>>;
  client: ModelClient;
  config: ResolvedAgentConfig;
}

export async function createAgentContext(options: {
  cwd: string;
  args?: AgentCliArgs;
  configOverrides: AgentConfigOverrides;
  onFallback?: (event: { from: string; to: string; reason: string }) => void;
}): Promise<AgentContext> {
  const cwd = options.cwd;
  const config = await resolveAgentConfig(cwd, options.configOverrides);
  const sandbox = await createSandbox({
    kind: config.sandbox.kind ?? "auto",
    workspaceRoot: cwd,
    ...(config.sandbox.image ? { image: config.sandbox.image } : {}),
    ...(config.sandbox.network ? { network: config.sandbox.network } : {}),
    ...(config.sandbox.requireImageDigest ? { requireImageDigest: true } : {}),
    ...(config.sandbox.allowHostFallback ? { allowHostFallback: true } : {}),
  });
  const registry = await createCodingToolRegistry(cwd, {
    shellExecutor: sandbox,
    ...(config.agent.searchEndpoint ? { searchEndpoint: config.agent.searchEndpoint } : {}),
  });
  const resources = await loadAgentResources({
    cwd,
    projectTrusted: config.projectTrusted,
    configuredInstructions: config.instructions,
  });
  const client = buildModelClientChain(config.model, config.fallbackModels, {
    factory: (model) => {
      const accessTokenProvider = oauthAccessTokenProvider(model);
      return createModelClient({
        ...model,
        ...(accessTokenProvider ? { accessTokenProvider } : {}),
      });
    },
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  });
  return { cwd, sandbox, registry, resources, client, config };
}
