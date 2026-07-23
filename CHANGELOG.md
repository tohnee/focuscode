# Changelog

## Unreleased — Foxy companion experience + capability gap closure

This refresh closes the six gaps called out in the v0.4.0-beta.2 deep review (rg hard dependency,
no MCP runtime, no LSP diagnostics feedback, no todo/subagent/web tools, no file-level checkpoint/undo,
TUI syntax highlight + model picker + CLI `--list-models` + cost panel) and lands the second wave of the
Foxy companion experience: 9-level tail growth, 8-mood pixel-art frame animations for all 7 mascots,
a `fox`-as-default theme (谐音 focus), a `focuscode-skin.v1` skin pack format with `fox skins` subcommands,
and a model picker with reasoning-effort switching (Low/High/Max).

### Added

- `fox`, `fc` and `focus` bin aliases for `@focuscode/cli` alongside `focuscode`; a bare
  invocation in a TTY opens the full-screen TUI directly (e.g. `fox` starts a session);
- new default mascot **Foxy 小福** (`foxy`, Focus 小狐狸) — an animated fox "编程配备鼓励师"
  with idle/thinking/working/happy/oops frames and a rotating encouragement speech bubble
  rendered beside the mascot; cheers fire on model rounds, tool runs, successes, failures,
  compaction and turn completion, and can be toggled with `/cheer [on|off]`;
- new default theme **fox** (warm deep-black/orange/gold palette, 谐音 focus); `aurora`, `foxglow`,
  `candy`, `forest`, `midnight`, `mono` and the other mascots remain available via `--theme` /
  `--mascot`; `fox themes` lists them;
- TUI polish: 🦊 header glyph, braille busy spinner in the status line, friendly role tags
  (`you ›`, `fox ›`, `⚙ ›`, `✱ ›`) with theme-driven colors, theme-colored header, and a
  `fox»` input prompt when Foxy is active;
- trusted-ANSI welcome splash (fox art, mascot intro, model line and key tips) rendered into
  the transcript when the TUI opens;
- `FullScreenTui.setSpeech(text?)` mutator and `TuiRenderState.speech`, keeping the TUI
  zero-dependency and agent-agnostic — all encouragement copy lives in the CLI adapter.

#### Capability gap closure (agent-runtime)

- **ripgrep fallback** (`packages/agent-runtime/src/rg-fallback.ts`): `grepRecursive` / `listFiles`
  with gitignore-subset parsing, binary detection (8KB NUL probe), and a >5MB file skip; process-level
  cached probe (`spawnSync rg --version`); metadata carries `backend: "rg" | "fallback"` so callers
  can tell which path served the result. `grep`/`find` tools no longer hard-fail when `rg` is missing.
- **MCP stdio client** (`packages/agent-runtime/src/mcp.ts`): JSON-RPC 2.0 over line-delimited
  stdio; `McpStdioClient.connect/listTools/callTool/close`; `registerMcpServers` discovers tools at
  startup and namespaces them `mcp_<san(serverId)>_<san(toolName)>`; effect mapping
  `readOnlyHint→read` / `destructiveHint→write` / else `network`; `computeToolPin` / `verifyPins`
  fail-closed pin verification; `closeAll` for graceful shutdown. Configured via `mcp.servers`
  (`McpServerSpec[]` with `command`/`args`/`env`/`cwd`/`pins`) in `~/.focuscode/config.json`.
- **LSP diagnostics feedback** (`packages/agent-runtime/src/diagnostics.ts`):
  `shouldRunDiagnostics` (tsconfig present + `node_modules/.bin/tsc` preferred) +
  `runDiagnostics` (reuses `runProcess` env allowlist, truncates at 8000 chars); after every
  successful `write`/`edit`/`apply_patch`, diagnostics are appended to the context so the model
  sees compile errors before the next turn — closes the "edit-then-blind-continue" loop.
- **todo tool** (`packages/agent-runtime/src/todo.ts`): `TodoState` with `pending`/`in_progress`/
  `completed` state machine; `createTodoTool` (`effect: "read"`); validation: id unique,
  content ≤200 chars, items ≤50, status in the allowed set; the live todo list is rendered into
  the system prompt as Markdown checkboxes so the model can self-track.
- **web_fetch / web_search** (`packages/agent-runtime/src/web-tools.ts`): `web_fetch` is http/https
  only, rejects embedded credentials, 20s timeout, 2MB cap, HTML→text; `web_search` defaults to
  DuckDuckGo lite and honors a `searchEndpoint` override.
- **file-level checkpoints / undo** (`packages/agent-runtime/src/checkpoints.ts`): `CheckpointStore`
  snapshots files by relative path before `write`/`edit`/`apply_patch` into a
  `focuscode-checkpoint.v1` manifest; cap 50 entries with oldest-eviction; directory mode 0700,
  files 0600. `CodingAgent.undoCheckpoint()` rolls back the most recent file operation
  (distinct from session `fork`, which forks the conversation tree).
- **subagent delegation** (`packages/agent-runtime/src/delegate.ts`): DI-based `DelegateContext`
  with a `createAgent` factory; subagents share `modelClient` and `PermissionController` but get a
  fresh in-memory `SessionStore` and a tool registry with `delegate`/`bash`/`todo` stripped —
  prevents runaway delegation loops. Avoids a circular `CodingAgent` import via constructor
  injection rather than static import.

#### TUI refactor

- **8-mood frame system**: `MascotMood` expanded from 5 to 8 (`idle`/`thinking`/`working`/`happy`/
  `oops`/`sleeping`/`celebrating`/`levelup`); `frames` is now `Partial<Record<MascotMood, ...>>`
  with `getMascotFrames` falling back to `idle` when a mood is missing. All 7 mascots now ship
  `sleeping`/`celebrating`/`levelup` frames.
- **pixel-art frame set** (`packages/tui/src/pixel-frames.ts`): `PIXEL_FOXY_FRAMES` and
  `PIXEL_MASCOT_FRAMES` use block characters (`█▀▄░▒▓`) for a pixel-game aesthetic; every mood ×
  every mascot has 2-frame animation; `tailsForLevel(n)` returns the right tail count for level
  1–9; `composeFrame` assembles decorative lines around the mascot.
- **9-level companion growth** (`packages/tui/src/companion.ts`): `CompanionState` with
  `xp`/`level` (1–9)/`totalTurns`; `XP_LEVELS = [0, 50, 150, 300, 500, 800, 1200, 1800, 2500]`;
  `LEVEL_NAMES` (幼尾小福 → 二尾小福 → … → 九尾天福); `applyTurnReward` grants +1 XP per model
  round, +2 per tool call, bonus XP on milestones; `suggestMood(state, event)` maps
  events to moods (e.g. `tool_error` → `oops`, `levelup` → `celebrating` then 3s revert);
  `serializeCompanion`/`parseCompanion` for `focuscode-companion.v1` persistence.
- **skin pack format** (`packages/tui/src/skins.ts`): `SkinPack` (`focuscode-skin.v1`), strict
  `validateSkinPack` (rejects missing fields, ANSI injection, oversized payloads); `BUILTIN_SKINS`
  = sakura/ocean/arcade/matcha; `skinToTheme`/`skinToMascot`/`parseSkinPack`/`serializeSkinPack`;
  signature is optional (skin packs affect rendering only, they do not execute code).
- **syntax highlighting** (`packages/tui/src/syntax.ts`): `highlightCode(text, lang, theme)`
  supports ts/js/json/bash/markdown; sanitizes first, then highlights; integrated into
  `markdown.ts` so fenced code blocks render with color.
- **model picker** (`packages/tui/src/picker.ts`): `createPickerState` / `fuzzyMatch` /
  `pickerVisibleModels` / `updatePicker` / `cycleProvider` / `cycleReasoningEffort` /
  `confirmPicker` / `renderPicker`. UI matches the spec: top "Select a model (type to search)",
  Tab toggles provider, Alt+S = session-only, ←→ cycles Low/High/Max reasoning effort,
  ↑↓ navigates, Enter confirms, Esc cancels. A note warns that switching models invalidates
  the prompt cache. Bindings wired in `app.ts` via `Alt+M` (or `Ctrl+M`) and direct byte
  sequence interception (the keymap decoder would otherwise swallow `ESC m` / `ESC s`).
- **widgets** (`packages/tui/src/widgets.ts`): `progressBar` / `costBar` / `levelBadge` as pure
  functions, rendered by `renderer.ts` into the status line.
- **8 new slash commands**: `/character [list|<id>]`, `/skin [import|export|builtin]`,
  `/init`, `/undo`, `/cost`, `/todo [add|done|clear]`, `/mcp [list|reload]`,
  `/diagnostics [on|off]`. Slash completion in `completion.ts` extended to include them.
- **companion persistence**: `~/.focuscode/companion.json` stores level/XP/totalTurns so growth
  survives across sessions; `fox companion` and `fox companion reset` are the CLI accessors.

#### CLI integration

- **`fox --list-models`**: early-exit branch in `agent-command.ts` that prints available models
  grouped by provider (from the provider presets + user `providers`/`models` config).
- **`fox --cost`**: in `print`/`json` modes, appends a cost summary
  (`printCostPanel(usage, config)`) computed from `pricing.<provider>/<model>` unit prices.
- **`fox skins list/apply/import/export/remove`**: full lifecycle management for skin packs
  in `~/.focuscode/skins/<id>.json`; import validates the pack before persisting.
- **`fox character list/<id>`**: list the 7 mascots or set the default.
- **`fox companion` / `fox companion reset`**: read or reset `~/.focuscode/companion.json`.
- **`fox doctor`** enhanced: now also checks MCP server reachability, checkpoint directory
  writability, and companion file integrity.
- `agent-args.ts` extended with `--list-models` and `--cost` boolean options; `agent-command.ts`
  threads `agent.checkpoints`/`diagnostics`/`enableDelegate`/`searchEndpoint` into `CodingAgentOptions`.

### Added

#### Expert review remediation (P0/P1 hardening)

- **P0-1 source manifest integrity**: `scripts/generate-source-manifest.mjs` now excludes build
  artifacts and machine-specific output (`coverage`/`bundle`/`model-packs`/`.focuscode`/
  `.focuscode-state`, `.DS_Store`, `*.log`, `*.tgz`, `reports/npm/`) so `SOURCE_MANIFEST.sha256`
  attests the real distributed source tree; regenerated 335 entries pass `sha256sum -c` cleanly.
- **P0-4 cancellable effect spine**: the turn `AbortSignal` is now threaded end-to-end —
  `EffectPort.submit(intents, context, signal?)` (`contracts`), `ToolExecutor.execute(args, signal?)`
  (`action-backends`), `LocalActionRuntime` pass-through, the `sdk` session spine adapter, and
  `CodingAgent.executeCallViaSpine` — so `/interrupt`/abort cancels in-flight tools, not just the
  gaps between calls. All additive optional params; kernel and test fakes are unaffected.
- **P0-5 crash-durability floor**: new `FileReceiptJournal` (`action-backends/src/receipt-journal.ts`)
  — append-only JSONL, fsync per append, torn-tail tolerated only on the final line, corrupt-line
  fail-closed. `LocalActionRuntime` accepts an optional `journal` and now persists each receipt
  **before** returning it (receipt-before-result) and exposes `journalReceipts()` for crash audit.
  Full stable-action-id + UNKNOWN reconciliation remains roadmap.
- **P1-1 shell policy AST-lite**: `analyzeShellCommand()` (quote-aware tokenizer, no deps) +
  `classifyShell()` now classifies the whole command **and** every pipeline/chain segment and takes
  the highest risk; interpreter wrappers and command substitution are raised to `high`; read-only
  detection tightened; new `isArbitraryShell()` for the enterprise full-auto gate.
- **P1-5 structured compaction**: `SessionCompaction.structured` (`focuscode-compaction.v1`) +
  `summarizeEntriesStructured()` extract files read/changed, commands run, key decisions, pending
  approvals and open questions as a bounded, non-destructive projection (entries are never mutated);
  `summarize()` renders them as leading `## …` sections and old text-only compactions still load.
- **P1-7 session cross-process locking**: per-session `<id>.lock` files (pid + timestamp + TTL
  preemption) guard all mutating ops, and appends now compare-and-swap on `expectedLeafId`, closing
  the two-CLI resume race; read paths stay lock-free.
- **P1-8 task-lifetime Docker sandbox**: `DockerSandboxOptions.taskLifetime` runs commands via
  `docker exec` into one long-lived container (all security flags preserved, best-effort `pkill` on
  timeout instead of teardown) with `SandboxExecutor.dispose()` for cleanup; per-command `docker run
--rm` stays the default.

### Changed

- `packages/agent-runtime/src/tools.ts`: `grep`/`find` now probe for `rg` and fall back to the
  pure-TS implementation; `todo`/`web_fetch`/`web_search` registered.
- `packages/agent-runtime/src/agent.ts`: holds a `TodoState`, renders `## Current task list` into
  `systemPrompt()`; `executeCalls` invokes `captureForCheckpoint` before each write/edit/apply_patch;
  `todoCounts()`/`listCheckpoints()`/`undoCheckpoint()` exposed as public methods.
- `packages/agent-runtime/src/config.ts`: `agent` section gains `checkpoints`/`diagnostics`/
  `enableDelegate`/`searchEndpoint`; top-level adds `mcp.servers` (`McpServerSpec[]`) and `pricing`
  (`ModelPricing`).
- `packages/tui/src/mascots.ts`: `frames` type widened from `Record` to `Partial<Record>` so
  partial mood coverage doesn't break type-checking; missing moods fall back to `idle`.
- `packages/tui/src/themes.ts`: `fox` inserted as the first theme (default); `DEFAULT_THEME_ID`
  exported as `"fox"`.
- `packages/tui/src/renderer.ts`: `TuiRenderState` extended with `picker`/`companion`/`widgets`;
  legacy `require()` calls replaced with static imports.
- `apps/cli/src/tui.ts`: new slash command handlers; companion state persisted to
  `~/.focuscode/companion.json`; `describeMascots()` / `describeSkins()` switched from
  `require()` to static imports.

### Verified

- 23 workspace projects build;
- 53 test files and 404 tests pass, plus 10 tests skipped without credentials;
- Statements 78.8% / Branches 68.62% / Functions 84.11% / Lines 82.35% (thresholds: 75/60/80/80);
- new module coverage: `mcp.ts` 85.83%, `rg-fallback.ts` 91.11%, `todo.ts` 95.65%,
  `web-tools.ts` 81.37%, `companion.ts` 100%, `picker.ts` 97.7%, `pixel-frames.ts` 100%,
  `skins.ts` 92.7%, `syntax.ts` 92.24%, `widgets.ts` 95.83%;
- architecture (`scripts/check-boundaries.mjs`), schema-sync (`scripts/export-schemas.mjs --check`)
  and prettier gates all pass;
- the second-wave TUI refactor adds 119 tests across 7 files (syntax/widgets/picker/companion/
  pixel-frames/skins/tui); the CLI integration adds 38 tests across 5 files
  (cli-models/cli-skins/cli-cost/cli-tui/cli-platform).

### Remaining release gates

- the external HA gates remain open: PostgreSQL/transactions/RLS/outbox (HA-101-103), Temporal
  durable workflows (HA-104/105), K8s multi-replica/PDB (HA-203/207) and the remote write path in
  general, a production OIDC IdP with RBAC, SPIFFE/KMS/WORM (HA-305/306/309), OTel/SLOs
  (HA-501/502), real Docker/gVisor/VM adversarial CI (HA-302, no Docker on the dev host),
  live-conformance certificate issuance (HA-402, needs real APIs), the Pi same-model A/B
  (HA-508), WASI (HA-308), vendor subscription OAuth (deliberate stance) and audio/video
  modalities (non-goal). The spine is now the default, but file-layer hardening is not database
  transactions; the extension process host is crash isolation, not a capability sandbox; the full
  kill-point matrix is still not automated (window C now has deterministic UNKNOWN semantics).
- the MCP runtime speaks the line-delimited JSON-RPC 2.0 protocol and is compatible with most
  TS/JS MCP servers; the framed header protocol is not yet implemented.

## 0.4.0-beta.2 — 2026-07-20

Hardened protected-path enforcement across both policy layers and shipped the default audited-kernel
Model Pack inside the published tarball. This refresh closes the mid-turn steering gap, lands the
first convergence step between the conversational session path and the audited effect spine, adds
six TUI components, introduces an out-of-process extension host for crash isolation, and closes the
Kernel grant inner loop. A follow-up enterprise-HA alignment round then made the spine the default,
single-sourced the policy rules in `action-domain`, hardened file persistence with defined
crash-window semantics, and added provider reliability controls.

### Added

- `normalizeRelativePath` in `@focuscode/contracts`: unifies separators, drops `.` segments and
  collapses `..` segments so disguised paths such as `src/../.env`, `src/sub/../../.env` and
  `src\..\.env` can no longer bypass protected-path matching;
- protected-path normalization is now applied consistently in the Kernel `PolicyEngine`
  (`action-domain`) and the conversational `PermissionController` (`agent-runtime`), including
  `apply_patch` target files extracted from patch headers;
- the default `generic-openai` Model Pack is bundled into `@focuscode/cli`
  (`files: ["bundle", "model-packs", ...]`), so the audited-kernel path
  (`focuscode run`) works from the clean-installed tarball without a repository checkout;
- `npm:verify` now also exercises a clean-installed audited-kernel run with the bundled Model Pack;
- steering queue retrieval end to end: `SteeringQueue.remove/removeLatest/drainOne`,
  `CodingAgent.listSteering()/unsteer(id?)`, a `steering_removed` event, RPC `unsteer` /
  `steering_list` and TUI `/unsteer [id]`;
- steering delivery modes via `AgentRuntimeOptions.steeringDelivery: "all" | "one-at-a-time"`
  (default `all`), threaded through config, CLI and SDK;
- the session-path effect spine, first step: `effect-gateway.ts` in `@focuscode/agent-runtime`
  (`buildActionIntent` / `receiptToToolResult`, effect→capability mapping) and an optional
  `EffectPort` injection on `CodingAgent` (`effectPort` / `effectContext`) that routes tool calls
  through Policy→Grant→Receipt when enabled; an `agent.effectSpine` config switch (default
  `false` = legacy) and the `createSessionEffectSpine()` composition helper in `@focuscode/sdk`.
  Both policy rule sources still coexist; a single policy path is deferred to the stable release;
- six TUI components: `EditorBuffer` (multiline, undo, kill ring, grapheme-aware cursor), tab
  completion (slash commands, skills, prompts, extension commands, file paths), EAW wide-character
  width handling (fixes CJK misalignment), sanitized Markdown rendering for assistant messages, an
  edit-tool diff view (red/green `+/-` with folding) and macOS clipboard-image paste (`/image`,
  pngpaste/osascript — not yet exercised on a real GUI). New key bindings: Home/End, Ctrl+A/E,
  Alt+B/F, Ctrl+Z undo, Tab complete, Ctrl+K/Y kill/yank;
- an out-of-process extension host (`process-extension-host.ts` + `extension-runner.ts`): one Node
  child process per extension speaking stdio JSON-RPC (registerTool/Command/appendSystemPrompt/
  onEvent registration, toolExecute/commandExecute/event/cancel dispatch), crash isolation, a 60s
  tool timeout, an environment allowlist and dispose; unified with the in-process host behind
  `ExtensionHostLike`; `extensions.host: "in-process" | "process"` (default `in-process`). This is
  reliability isolation and a runtime permission enforcement hook — not a security sandbox;
- per provider/model circuit breaker and bulkhead (`circuit-breaker.ts`): opens after 5
  consecutive failures, cools down for 30s with half-open probes, and queues excess work behind a
  per-provider concurrency semaphore (8); retry backoff now carries jitter;
- enterprise allowlist entries may pin `provider/model@revision` (a missing revision fails
  closed); the five provider presets ship placeholder revisions that production deployments must
  replace with measured ones; `system_fingerprint` drift detection (`fail`/`warn`/`off`,
  enterprise default `warn`, a missing fingerprint counts as drift);
- `CertifiedModelRefSchema` gains an optional `expiresAt`, and the Kernel fails closed on expired
  model certificates;
- 32 protocol fixtures under `evals/protocol/` (five families × text/reasoning/tool/usage/abort/
  overflow, plus images for kimi/minimax; hand-written from public documentation, not recorded
  traffic) with arbitrary-chunking replay tests, an env-gated live-provider scaffold
  (`FOCUSCODE_LIVE_PROVIDERS`, skipped by default) and a `deepseek-specific` ablation pack;
- crash-window-C semantics: `ActionStarted` is persisted before execution, and recovery that finds
  a started action without a receipt records an `EffectUnknown` event instead of re-executing;
- stale-lock recovery for the file stores: locks carry pid + timestamp and are preempted after a
  TTL, fixing the permanent 2s-timeout deadlock left behind by a crashed process;
- an audit `KeyProvider` seam with `EnvAuditKeyProvider` (KMS-ready), a recorded `keyId` on
  journal entries, rotation-tolerant verification and gap-detection tests.

### Changed

- `EffectReceiptV1` gains an optional `grant` field (additive contract change, exported schemas
  regenerated); `LocalActionRuntime` no longer drops the grant, and the Kernel records
  `GrantIssued` / `ActionStarted` before `EffectObserved` with idempotent resume;
- `pnpm lint` now includes `node scripts/export-schemas.mjs --check`, a schema drift gate that
  deep-compares the 11 parsed schemas;
- `agent.effectSpine` now defaults to `true`: conversational tool calls go through the
  Policy→Grant→Receipt spine by default — including bridged `approval_required` events and
  `changeApproval` hot-switching — while legacy direct execution remains as an explicit escape
  hatch (`effectSpine: false`); a differential parity suite
  (`packages/sdk/test/session-spine-parity.test.ts`) locks the two paths to equivalent outcomes;
- policy rule semantics are single-sourced in `@focuscode/action-domain` (`shell-policy.ts`:
  shell classification, `commandReferencesPath`, `apply_patch` target extraction, and the
  ApprovalMode matrix in `PolicyConfig`); the conversational `PermissionController` degrades to
  a thin local adapter over the shared PolicyEngine;
- file persistence hardened: all appends (FactStore/SessionStore/AuditJournal) fsync, checkpoints
  write tmp → fsync → rename → directory fsync, event loading re-verifies per-entry digests
  fail-closed, torn tails are tolerated only on the final line, and crash window B (checkpoint
  newer than events) rebuilds from events instead of wedging;
- provider `maxRetries` default unified to 2 across profiles.

### Security

- the process extension host keeps extension crashes away from the main loop, scrubs the child
  environment to an allowlist and enforces per-tool timeouts — crash isolation only; extensions
  remain explicitly trusted code and this is not a capability sandbox;
- when the effect spine is enabled, `tool_end` audit metadata carries `grantId` and
  `receiptDigest` into the HMAC-chained journal;
- `harness-worker` job specs reference API keys via `apiKeyEnv` only — inline plaintext `apiKey`
  is rejected fail-closed and job digests never contain secrets;
- enterprise mode forces the process extension host: `process` is the default, an explicit
  `in-process` fails closed, and `init --enterprise` writes the template accordingly;
- crash recovery no longer blindly retries side effects that were started but not receipted —
  window C resolves to `EffectUnknown` for reconciliation instead of silent re-execution;
- the Kernel policy engine now inspects shell command text for protected-path references
  (`commandReferencesPath`), closing the blind spot where `cat ~/.ssh/id_rsa` was denied on the
  session path but invisible to the Kernel.

### Verified

- 23 workspace projects build;
- 37 test files and 234 tests pass, plus 1 env-gated live-provider scaffold file and 10 tests
  skipped without credentials (previously 31/145), including session JSONL cross-instance reload
  with corrupted-line fail-closed, kernel crash recovery without re-execution, effect-gateway/
  spine coverage, process-extension-host, steering retrieval, ecosystem/SDK permission denials,
  SSE arbitrary-chunking property tests (100 random splittings each, multibyte-safe) and 16 TUI
  tests — now also session-spine differential parity (6), protocol-fixture replay (32 fixtures,
  arbitrary chunking), circuit breaker (8), kernel crash windows B/C, persistence fsync/digest/
  torn-tail/stale-lock (9), audit key rotation (8), a real macOS clipboard round-trip and the
  deepseek ablation pack;
- Statements 79.26% / Branches 69.05% / Functions 84.02% / Lines 83.06%;
- architecture, schema-sync and formatting gates pass;
- npm release verification performs a clean install plus a streaming tool loop and an audited-kernel
  run against the bundled Model Pack.

### Remaining release gates

- the external HA gates remain open: PostgreSQL/transactions/RLS/outbox (HA-101-103), Temporal
  durable workflows (HA-104/105), K8s multi-replica/PDB (HA-203/207) and the remote write path in
  general, a production OIDC IdP with RBAC, SPIFFE/KMS/WORM (HA-305/306/309), OTel/SLOs
  (HA-501/502), real Docker/gVisor/VM adversarial CI (HA-302, no Docker on the dev host),
  live-conformance certificate issuance (HA-402, needs real APIs), the Pi same-model A/B
  (HA-508), WASI (HA-308), vendor subscription OAuth (deliberate stance) and audio/video
  modalities (non-goal). The spine is now the default, but file-layer hardening is not database
  transactions; the extension process host is crash isolation, not a capability sandbox; the full
  kill-point matrix is still not automated (window C now has deterministic UNKNOWN semantics).

## 0.4.0-beta.1 — 2026-07-19

Apple-to-Apple reviewed the complete v0.3 Alpha implementation against Pi `0.80.10` and hardened
the CLI path for model portability and enterprise deployment.

### Added

- first-class Kimi/Moonshot, Qwen China/International, GLM/ZAI China/Global, DeepSeek and MiniMax
  China/Global provider profiles, plus per-model capability/compatibility/reliability overrides;
- Qwen/ZAI/DeepSeek reasoning dialects, assistant reasoning replay, tool-stream compatibility,
  conditional request fields, bounded retry/Retry-After handling and retry lifecycle events;
- OIDC discovery, token endpoint auth-method negotiation and OAuth token revocation;
- validated custom TUI theme and animated mascot JSON, configurable title and differential frame
  updates;
- append, interrupt and follow-up mid-turn queues across TUI, RPC and SDK;
- HMAC-SHA-256 chained, content-minimizing enterprise audit journals with offline verification;
- enterprise provider/model/extension allowlists, signed-extension enforcement, remote-media denial,
  isolated-executor enforcement and a `focuscode doctor` readiness command;
- digest-pinned container policy, `--pull never`, IPC/log isolation and explicit isolation health;
- share-server signer allowlists, maximum age, authentication fail-closed mode and rate limiting.

### Verified

- 23 workspace projects build;
- 26 test files and 89 tests pass;
- architecture and formatting gates pass;
- npm release verification performs a clean install and full local streaming tool loop.

### Remaining release gates

- live contract tests with credentials for each named provider and pinned model revision;
- real Docker/runsc and disposable-VM adversarial CI on target infrastructure;
- Pi same-model/same-budget repository benchmark;
- capability-contained extension execution, session WAL/recovery, and a single policy path shared by
  the conversational Agent and deterministic Focus Kernel;
- production OIDC/RBAC, secret/egress broker, HA share persistence and operations SLOs.

## 0.3.0-alpha.1 — 2026-07-19

Completed the next Harness product slice across CLI, SDK, infrastructure, tests and documentation.

### Added

- OAuth 2.0 Authorization Code + PKCE, loopback callback, Device Authorization, refresh and an
  AES-256-GCM multi-account credential store;
- native OpenAI Responses and Google Gemini clients alongside OpenAI Chat and Anthropic Messages;
- full-screen raw-terminal TUI, five themes, configurable keymap and six animated mascots;
- PNG/JPEG/WebP/GIF input through CLI, TUI, RPC and SDK with runtime validation and four-provider
  mappings;
- bounded append/interrupt mid-turn steering with generation-only cancellation and recovery;
- npm extension pack/install/list/remove, signature/integrity checks, permission manifest and lock;
- Ed25519 session sharing, default redaction, import/publish/download and an immutable reference
  share server;
- hardened Docker, gVisor and strict SSH VM/microVM executors with secure auto selection;
- standalone publish-ready `@focuscode/cli` npm bundle and clean-install coding-loop verification;
- example extension, deployment infrastructure and focused architecture/operations documentation.

### Hardened

- default Sandbox is now gVisor → Docker → fail, with no silent Host fallback;
- SDK honors the same Sandbox and extension signature policy as the CLI;
- RPC and stored images validate base64, size, MIME, magic bytes and digest;
- share server cryptographically verifies bundles instead of checking signature fields;
- extension install failures roll back and unsigned locks are blocked again at load time;
- Docker timeout/abort force-removes the uniquely named container;
- TUI handles cross-chunk bracketed paste, visible cursor and terminal-control injection;
- steering handles custom providers that throw on AbortSignal and avoids receipt-size races;
- Agent config validates protocols, auth, URLs, sandbox/VM settings and keymaps at runtime.

### Known limitations

- the delivery host has no Docker/runsc/Firecracker/QEMU, so physical isolation was not executed
  locally; driver and invocation contracts are tested;
- extensions are still trusted in-process Node.js code, not capability-contained;
- Session JSONL and conversational Tool effects do not yet provide WAL/unknown-effect recovery;
- share server lacks organization identity, ACL, TTL, deletion and abuse controls;
- no real-repository same-model benchmark proves superiority over Pi or other agents.

## 0.2.0-alpha.1 — 2026-07-19

Added the complete conversational CLI coding-agent path while retaining the audited task Kernel.

### Added

- streaming OpenAI Chat Completions and Anthropic Messages clients with native tool calling;
- model-portable native, prompt-JSON and automatic tool modes;
- ten coding tools: read, write, exact edit, apply patch, grep, find, ls, shell, git status and diff;
- interactive, print, JSON event stream, JSON-RPC and TypeScript SDK entrypoints;
- append-only JSONL sessions with active-branch tree, resume, fork, compaction and HTML export;
- AGENTS instructions, skills, prompt templates and hot-reloadable JavaScript extensions;
- provider presets for API and local OpenAI-compatible endpoints;
- permission modes, protected path checks, shell risk classification and child-environment secret scrubbing;
- deterministic CLI agent demo and real process-level streaming/tool-call E2E tests;
- Pi capability baseline, CLI architecture, onboarding and updated threat model.

### Known limitations

- host process execution only; no container/microVM network or filesystem isolation;
- no OAuth subscriptions, OpenAI Responses/Gemini-native clients, images or remote model catalog;
- lightweight readline UI, not a full component/theme/keybinding TUI;
- no extension package manager/signature ecosystem;
- no mid-turn steering queue; abort and subsequent prompt are supported;
- CLI Session effects are not backed by a durable receipt/reconciliation journal.

## 0.1.0-alpha.1 — 2026-07-19

Initial executable Harness Alpha derived from the FocusCode product, architecture and engineering
plans.

### Added

- Canonical contracts and generated JSON Schemas;
- Focus Kernel with Atomic Turn and deterministic verification gate;
- declarative Model Pack and OpenAI-compatible transport;
- Scripted Model for deterministic protocol/E2E tests;
- Context Compiler and stable prefix digest;
- Policy, Capability Grant construction, Effect Receipt and Effect Ledger;
- bounded local read/edit/registered-command tools;
- File FactStore, Memory proposal/acceptance and portable export;
- CLI, SDK, read-only Control API and Action Runtime manifest process;
- ACP/MCP/A2A/Capsule boundary utilities;
- architecture, onboarding, progress, security and test documentation;
- 33 tests and enforced coverage floors.

### Known limitations

- local process guard only; no production physical sandbox;
- File persistence only; no PostgreSQL/WAL/outbox/unknown-effect recovery;
- Generic Pack only; no formally certified open-model Pack;
- protocol modules are contract-level, not authenticated network gateways;
- no VS Code client, multi-agent write path, Secret Broker or Egress Broker.
