# Gap Closure Plan — 2026-07-22

Systematically closing the P0–P4 capability gaps identified in the deep
comparison against Pi / Claude Code / OpenCode / Codex / OMP. Each phase
follows strict TDD: write a failing test → verify RED → minimal
implementation → verify GREEN → refactor.

## Context (code facts confirmed before writing this plan)

- `packages/agent-runtime/src/index.ts` — barrel missing `export * from "./mcp.js"`
- `packages/agent-runtime/src/mcp.ts` (502 lines) — `McpStdioClient`,
  `McpToolPinV1`, `computeToolPin`, `verifyPins`, `registerMcpServers`,
  `closeAll` all implemented; not exported from the package barrel.
- `packages/agent-runtime/src/config.ts` — `AgentConfigFile.mcp` has
  `servers` only, no `pins`; `ResolvedAgentConfig.mcp` mirrors that.
- `apps/cli/src/agent-command.ts` L178–202 — explicit fail-open stderr
  warning in place of real `registerMcpServers` wiring.
- `packages/agent-runtime/src/circuit-breaker.ts` (187 lines) —
  `CircuitBreakingModelClient` does circuit + bulkhead, **no model
  fallback chain** (no `ModelProfile[]`, no automatic switch on 429/5xx).
- `packages/agent-runtime/src/diagnostic-providers.ts` (218 lines) —
  spawns `tsc` / `ruff` / `go vet` / `cargo check` directly; not LSP.
- `packages/agent-runtime/src/skills.ts` (48 lines) — keyword-only
  trigger, inline manifest only, no `SKILL.md` file loading, `toolNames`
  field declared but unused in `selectSkills`.
- `packages/sandbox/src/factory.ts` (32 lines) — `host | docker | gvisor |
vm | auto` only; no macOS seatbelt executor.

## Architecture boundary reminders (do not violate)

- `agent-runtime` must NOT depend on `harness-core`, `model-gateway`,
  `persistence`, `sdk`, `auth`, `ecosystem`, `sandbox`, `tui`, or apps.
- `contracts` must NOT depend on any `@focuscode/*` package or SDK.
- `sandbox` is a leaf adapter — must NOT depend on any `@focuscode/*`.
- Only `apps/*` and `packages/sdk` may compose across layers.
- `exactOptionalPropertyTypes: true` — optional fields need `| undefined`
  when explicitly passed.
- Prettier: printWidth 100, double quotes, trailing comma `"all"`.

## Phase A (P0) — MCP wired into the main path

**Goal**: configured MCP servers actually register tools before
`CodingAgent.create`, with pin verification enforced when `mcp.pins` is
declared.

### A1 — Barrel export (RED → GREEN)

- **Test** `packages/agent-runtime/test/mcp-barrel.test.ts`:
  imports `registerMcpServers`, `closeAll`, `McpStdioClient`,
  `McpToolPinV1`, `computeToolPin`, `verifyPins`,
  `McpPinMismatchError` from `@focuscode/agent-runtime` and asserts they
  are functions/classes. **RED**: currently fails to resolve.
- **Impl**: add `export * from "./mcp.js";` to
  `packages/agent-runtime/src/index.ts`. **GREEN**.
- **Note**: `McpServerSpec` is declared in both `config.ts` and `mcp.ts`.
  Resolve by removing the `mcp.ts` local declaration and re-exporting
  from `config.ts` (config already owns the canonical type). Verify no
  duplicate-export errors.

### A2 — Config `mcp.pins` field (RED → GREEN)

- **Test** `packages/agent-runtime/test/mcp-pin-config.test.ts`:
  - Loads a fixture config with `mcp.pins` and asserts
    `ResolvedAgentConfig.mcp.pins` is parsed and array-copied.
  - Loads a config without `mcp.pins` and asserts
    `ResolvedAgentConfig.mcp.pins` defaults to `[]`.
- **Impl**: add `pins?: McpToolPinV1[]` to `AgentConfigFile.mcp` and
  `ResolvedAgentConfig.mcp`; parse in `resolveAgentConfig`. Import
  `McpToolPinV1` type from `./mcp.js` (structurally; no runtime dep).

### A3 — CLI composition root wiring (RED → GREEN)

- **Test** `apps/cli/test/agent-command-mcp.test.ts`:
  - Spawns a fake MCP server (Node script echoing JSON-RPC responses)
    and asserts its tool is registered into the agent tool registry.
  - Asserts pin mismatch throws and the CLI exits non-zero (fail closed).
  - Asserts `disabled: true` servers are skipped.
- **Impl**: replace the L178–202 warning block in `agent-command.ts`
  with a real call to `registerMcpServers(registry, config.mcp.servers, {
pins: config.mcp.pins, onWarning: (m) => process.stderr.write(`MCP: ${m}\n`)
})`; track clients and `await closeAll(clients)` in the `finally` block
  alongside `extensions.dispose?.()`.

### A4 — Full MCP integration smoke (manual)

- Run `pnpm build && npx vitest run packages/agent-runtime/test/mcp-barrel.test.ts packages/agent-runtime/test/mcp-pin-config.test.ts apps/cli/test/agent-command-mcp.test.ts`.
- All three must be GREEN.

## Phase B (P1) — Model fallback chain

**Goal**: when the primary model returns 429 / 5xx / circuit opens,
automatically retry on the next declared `ModelProfile` in the chain
without losing the in-flight request.

### B1 — Type & config (RED → GREEN)

- **Test** `packages/agent-runtime/test/fallback-config.test.ts`:
  - Config with `fallbackModels: [{ provider: "openrouter", model: "x" }]`
    resolves to `ResolvedAgentConfig.fallbackModels: ModelProfile[]`.
  - Default: `fallbackModels` is `[]`.
- **Impl**:
  - `types.ts`: no new type needed — reuse `ModelProfile`.
  - `config.ts`: add `fallbackModels?: ModelProfilePreset[]` to
    `AgentConfigFile`; add `fallbackModels: ModelProfile[]` to
    `ResolvedAgentConfig`; resolve each preset into a `ModelProfile`
    using the same `resolveModelProfile` path as the primary.

### B2 — `FallbackModelClient` decorator (RED → GREEN)

- **Test** `packages/agent-runtime/test/fallback-model-client.test.ts`:
  - Primary `QueueModelClient` returns `{ stopReason: "error" }` once →
    `FallbackModelClient` switches to secondary and returns its response.
  - Primary throws a synthetic 429-tagged error → secondary is tried.
  - Primary succeeds → secondary never invoked.
  - All secondaries fail → last error propagates.
  - `onFallback` callback fires with `{ from, to, reason }`.
- **Impl**: new file `packages/agent-runtime/src/fallback-model-client.ts`.
  - Constructor: `clients: Array<{ profile: ModelProfile; client: ModelClient }>`,
    `options: { onFallback?: (info) => void }`.
  - `complete()`: iterate primary → fallbacks; retry when
    `response.stopReason === "error"` OR error is retryable
    (`isRetryableError(error)` — 429, 5xx, `CircuitOpenError`,
    timeout). Track the last response/error; if a fallback succeeds,
    return its response; if all fail, return the last error response
    or rethrow.
  - `protocol` property: primary's protocol.

### B3 — CLI wiring (RED → GREEN)

- **Test**: extend `apps/cli/test/agent-command-mcp.test.ts` sibling
  `agent-command-fallback.test.ts`:
  - Config with `fallbackModels` builds a `FallbackModelClient` wrapping
    the primary `CircuitBreakingModelClient` and secondary clients.
- **Impl** in `agent-command.ts`:
  - Build primary `client = modelClientFor(config.model)`.
  - For each `fallbackProfile` in `config.fallbackModels`, build
    `modelClientFor(fallbackProfile)` and collect into the chain.
  - If chain non-empty, wrap: `client = new FallbackModelClient(chain,
{ onFallback: (info) => process.stderr.write(...)) })`.

### B4 — Barrel export & verify

- Add `export * from "./fallback-model-client.js";` to `index.ts`.
- `pnpm build && npx vitest run packages/agent-runtime/test/fallback-*.test.ts`.

## Phase C (P2) — Real LSP integration

**Goal**: a real LSP client speaking JSON-RPC 2.0 over stdio
(`initialize` → `textDocument/didOpen` → `textDocument/publishDiagnostics`),
adapting into the existing `DiagnosticProvider` interface so the agent
runtime keeps the same `diagnostics.ts` orchestration.

### C1 — `LspClient` (RED → GREEN)

- **Test** `packages/agent-runtime/test/lsp-client.test.ts`:
  - Fake LSP server (Node script) responds to `initialize` with
    `{ capabilities: { diagnosticProvider: {} } }`.
  - `LspClient.connect()` exchanges handshake and exposes
    `serverCapabilities`.
  - `didOpen({ uri, languageId, text })` sends the notification.
  - `diagnostics(uri)` resolves with the array published via
    `textDocument/publishDiagnostics`.
  - `close()` shuts down cleanly (`shutdown` → `exit`).
- **Impl**: new file `packages/agent-runtime/src/lsp-client.ts`.
  - JSON-RPC 2.0 over stdio (Content-Length header framing, matching
    the LSP spec — **not** the newline-delimited framing used by MCP).
  - Methods: `connect`, `didOpen`, `didChange`, `diagnostics(uri)`,
    `close`.
  - Timeout + fail-quiet semantics: any handshake failure resolves to
    `undefined` so the diagnostic provider can fall back to the
    spawn-based provider.

### C2 — `createLspDiagnosticProvider` (RED → GREEN)

- **Test** `packages/agent-runtime/test/lsp-diagnostic-provider.test.ts`:
  - Provider `detect` returns true when `tsconfig.json` exists AND a
    TypeScript LSP server binary is configured.
  - Provider `run` opens the project files, collects diagnostics, and
    returns `{ ran: true, output }`.
  - When LSP server unavailable, `run` returns `{ ran: false }` (fall
    back to spawn-based provider upstream).
- **Impl**: new file `packages/agent-runtime/src/lsp-diagnostic-provider.ts`.
  - `createLspTypeScriptProvider(serverCommand, args?)` returns a
    `DiagnosticProvider` whose `run` uses `LspClient`.
  - Register into `BUILTIN_DIAGNOSTIC_PROVIDERS` behind a feature
    flag (env `FOCUSCODE_LSP=1`) so the spawn-based providers remain
    the default until LSP is battle-tested.

### C3 — Barrel & verify

- Add `export * from "./lsp-client.js";` and
  `export * from "./lsp-diagnostic-provider.js";` to `index.ts`.
- `pnpm build && npx vitest run packages/agent-runtime/test/lsp-*.test.ts`.

## Phase D (P3) — macOS seatbelt sandbox executor

**Goal**: a real `SandboxExecutor` using macOS `sandbox-exec` (the
`seatbelt` profile language), so untrusted Bash runs under OS-level
containment on macOS without requiring Docker/gVisor.

### D1 — `SeatbeltSandbox` (RED → GREEN)

- **Test** `packages/sandbox/test/seatbelt-sandbox.test.ts`:
  - On non-darwin platforms, `health()` returns `{ available: false,
detail: "seatbelt is macOS-only" }`.
  - On darwin, when `sandbox-exec` is on PATH, `health()` returns
    `{ available: true }`.
  - `run(["echo", "hi"])` returns stdout `hi\n` and the child does NOT
    have write access outside the workspace root (test by attempting to
    write to `/tmp/focuscode-seatbelt-test-<pid>` and asserting it
    fails — the seatbelt profile denies writes outside the workspace).
- **Impl**: new file `packages/sandbox/src/seatbelt.ts`.
  - `SeatbeltSandbox implements SandboxExecutor`.
  - `kind: "seatbelt"`.
  - Builds a seatbelt profile string from a template: allow read of
    `/usr/bin`, `/bin`, `/usr/lib`, node binary; allow read/write only
    inside `workspaceRoot`; deny everything else by default.
  - `run(command, options)` spawns `sandbox-exec -p <profile> -- <command>`.
  - `health()` probes `sandbox-exec --version`.

### D2 — Factory & config wiring (RED → GREEN)

- **Test** `packages/sandbox/test/factory-seatbelt.test.ts`:
  - `createSandbox({ kind: "seatbelt", workspaceRoot })` returns
    `SeatbeltSandbox` on darwin.
  - `auto` falls back: gvisor → docker → seatbelt (on darwin) →
    host (if allowed) → fail.
- **Impl**:
  - `factory.ts`: handle `kind === "seatbelt"`; add seatbelt to the
    `auto` fallback chain (after docker, before host).
  - `config.ts` `sandbox.kind` union: add `"seatbelt"`.
  - `agent-command.ts` `--sandbox` help text: add `seatbelt`.

### D3 — Barrel & verify

- Export `SeatbeltSandbox` from `packages/sandbox/src/index.ts`.
- `pnpm build && npx vitest run packages/sandbox/test/seatbelt-*.test.ts packages/sandbox/test/factory-seatbelt.test.ts`.

## Phase E (P4) — Skills industrialization

**Goal**: load skills from `SKILL.md` files on disk (in addition to the
inline manifest), and trigger skills by `toolNames` (when the agent is
about to call a matching tool), not just by keyword.

### E1 — `SKILL.md` file loading (RED → GREEN)

- **Test** `packages/agent-runtime/test/skills-file-loading.test.ts`:
  - Fixture dir with `SKILL.md` containing frontmatter
    `name`, `description`, `trigger.keywords`, `allowedTools` and a
    body used as `prompt`.
  - `loadSkillsFromDirectory(dir)` returns the parsed `Skill[]`.
  - Missing dir returns `[]` (no throw).
  - Malformed frontmatter throws a clear error.
- **Impl**: extend `skills.ts`:
  - `loadSkillsFromDirectory(dir: string): Promise<Skill[]>`.
  - Parse `SKILL.md` files: YAML frontmatter (between `---` lines) for
    structured fields, body as `prompt`. Reuse the existing
    `SkillManifest` schema for validation.

### E2 — `toolNames` trigger (RED → GREEN)

- **Test** `packages/agent-runtime/test/skills-tool-trigger.test.ts`:
  - `selectSkillsForTools(skills, ["bash"])` returns skills whose
    `trigger.toolNames` includes `"bash"`.
  - Skills without `toolNames` are not selected by this path.
- **Impl**: extend `skills.ts`:
  - `selectSkillsForTools(skills: Skill[], toolNames: string[]): Skill[]`.
  - The agent runtime can call this before tool execution to inject a
    just-in-time skill prompt. (Wire-up into `agent.ts` is optional in
    this phase — the function + tests are the deliverable; the agent
    integration can be a follow-up once the API stabilizes.)

### E3 — Barrel & verify

- `loadSkillsFromDirectory` and `selectSkillsForTools` are exported from
  `index.ts` via the existing `export * from "./skills.js";`.
- `pnpm build && npx vitest run packages/agent-runtime/test/skills-*.test.ts`.

## Phase F — Full verification & docs

### F1 — `pnpm verify` must be GREEN

- `source ~/.nvm/nvm.sh && nvm use 22 && pnpm verify`.
- All new tests pass; coverage thresholds still met; boundaries clean.

### F2 — Documentation updates

- Update `docs/ARCHITECTURE.md` — note MCP main-path wiring, fallback
  chain, LSP provider, seatbelt sandbox, skill file loading.
- Update `AGENTS.md` — add the new commands/files to the relevant
  sections (structure, commands, architecture boundaries).
- This plan document stays as the audit trail; mark each Task Step
  `[x]` as it completes.

## Task Steps (audit trail)

- [x] A1 — `index.ts` barrel export + remove duplicate `McpServerSpec`
- [x] A2 — `config.ts` `mcp.pins` field + resolver
- [x] A3 — `agent-command.ts` real `registerMcpServers` wiring
- [x] A4 — Phase A verify (three test files GREEN)
- [x] B1 — `fallbackModels` config field + resolver
- [x] B2 — `FallbackModelClient` decorator + tests
- [x] B3 — CLI fallback wiring
- [x] B4 — Phase B verify
- [x] C1 — `LspClient` + tests
- [x] C2 — `createLspDiagnosticProvider` + tests
- [x] C3 — Phase C verify
- [x] D1 — `SeatbeltSandbox` + tests
- [x] D2 — Factory + config wiring
- [x] D3 — Phase D verify
- [x] E1 — `loadSkillsFromDirectory` + tests
- [x] E2 — `selectSkillsForTools` + tests
- [x] E3 — Phase E verify
- [x] F1 — `pnpm verify` GREEN — 645 tests passed, coverage 80.75/70.12/85.67/84.11
- [x] F2 — Docs updated
