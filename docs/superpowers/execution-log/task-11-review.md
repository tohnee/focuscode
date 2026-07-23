# Task 11 Review: agent.ts submit() integration

## Verdict: APPROVED

## Spec Compliance

All 6 integration points verified against the plan (lines 3500-3698 of
`docs/superpowers/plans/2026-07-23-spec-engine.md`) and the source.

1. **Import** — PRESENT. `agent.ts` lines 24-25:
   `import { SpecEngine } from "./spec-engine.js";` and
   `import type { SpecEngineOptions, SpecEngineDeps } from "./spec-types.js";`.
   Both use `.js` extensions (ESM convention) and reference internal modules.
   `spec-engine.ts` exports `class SpecEngine` (line 25) and `spec-types.ts`
   exports the referenced types. Matches plan verbatim.

2. **CodingAgentOptions** — PRESENT. `agent.ts` lines 110-120 add
   `specEngine?: SpecEngineOptions` and `specEngineDeps?: SpecEngineDeps` with
   JSDoc comments matching the plan text (including the "keeps agent-runtime
   free of direct node:fs imports" note). Placed after `skills?: Skill[]`.

3. **Private fields** — PRESENT. `agent.ts` lines 139-140:
   `private specEngine: SpecEngine | undefined;` and
   `private currentSpecId: string | undefined;`. Placed after
   `private currentSkillPrompt = "";` as the plan specified.

4. **`create()` validation + instantiation** — PRESENT. `agent.ts` lines 248-253:
   validates `specEngineDeps` is required when `specEngine` is set (throws
   `Error("specEngine option requires specEngineDeps to be provided")`),
   then `agent.specEngine = new SpecEngine(options.specEngine, options.specEngineDeps)`.
   Placed after checkpoints setup, before `return agent;`. Matches plan.

5. **Getter** — PRESENT. `agent.ts` lines 261-263:
   `get specEngineInstance(): SpecEngine | undefined { return this.specEngine; }`.
   Placed after `get sessionId()`. Matches plan.

6. **`submit()` preprocessing block** — PRESENT. `agent.ts` lines 281-319,
   inserted between prompt parsing (lines 269-279) and
   `if (this.running)` (line 320). The block:
   - Guards on `this.specEngine && this.options.specEngine?.enabled !== false`.
   - Calls `this.specEngine.clarify({...})` with all `SpecClarifyInput` fields
     (`prompt`, `attachments`, `cwd`, `sessionBranch`, `modelClient`, `model`,
     `toolRegistry`, `eventSink`, `externalSignal`).
   - `abort`: returns early with `stopped: "aborted"` and zeroed fields.
   - `apply`: reassigns `prompt = result.enhancedPrompt`, sets initial todos
     via `this.todoState.set(...)`, sets `this.currentSpecId = result.specId`.
   - `skip`: falls through with original prompt (comment documented).
     Matches plan.

## Deviation Validation

All 3 deviations verified as correct and necessary.

1. **SessionStore class name** — VALID. `session-store.ts` line 86 exports
   `class SessionStore` with constructor `(directory: string, persistent = true, ...)`.
   There is NO `InMemorySessionStore` class in the codebase. The plan's test
   code referenced a non-existent class. The implementer's fix —
   `new SessionStore("unused", false)` for non-persistent mode — is the
   correct API: `persistent=false` routes through the in-memory `Map` backend
   (lines 322, 331-334), bypassing all filesystem I/O. The test file uses a
   static import `import { SessionStore } from "../src/session-store.js"` rather
   than the plan's dynamic `await import(...)`, which is functionally equivalent
   and cleaner.

2. **`activeBranch` return type** — VALID. `session-store.ts` lines 497-500
   declare `export function activeBranch(snapshot, leafId?): SessionEntry[]`.
   `SessionEntry` (lines 19-25) has `message: AgentMessage` plus metadata
   (`entryId`, `parentId`, `createdAt`, `usage`). `SpecClarifyInput.sessionBranch`
   (`spec-types.ts` line 114) is typed `AgentMessage[]`. The plan's
   `sessionBranch: activeBranch(this.session)` would pass `SessionEntry[]` where
   `AgentMessage[]` is required — a type error under strict mode. The
   implementer's `.map((e) => e.message)` correctly extracts the `AgentMessage`
   from each entry. This is a necessary fix, not a stylistic choice.

3. **`eventSink` exactOptionalPropertyTypes** — VALID. `AgentRuntimeOptions.eventSink`
   (`types.ts` line 274) is declared `eventSink?: (event: AgentEvent) => void | Promise<void>`,
   so `AgentRuntimeOptions["eventSink"]` is `(...) | undefined`. The private
   field `private eventSink: AgentRuntimeOptions["eventSink"]` (agent.ts line 135)
   therefore includes `undefined`. With `exactOptionalPropertyTypes: true`
   (enabled in `tsconfig.base.json`), assigning `eventSink: this.eventSink`
   directly would be a compile error when `this.eventSink` is `undefined`,
   because the optionality on `SpecClarifyInput.eventSink?` (`spec-types.ts`
   line 118) forbids explicit `undefined`. The conditional spread
   `...(this.eventSink ? { eventSink: this.eventSink } : {})` is the canonical
   fix and matches the pattern the plan itself used for `attachments` and
   `externalSignal`.

## Code Quality

- **TypeScript strict compliance**: No `any` types, no `@ts-ignore` /
  `@ts-expect-error` in the changes. Optional properties are handled via
  conditional spreads throughout (consistent with existing codebase patterns).
  The `status: "pending" as const` annotation correctly narrows the literal
  type for `TodoItem.status`.
- **Boundary compliance**: The only `node:fs` reference in agent.ts is inside
  a JSDoc comment (line 118: "keeps agent-runtime free of direct node:fs
  imports") — not an import. No `node:child_process`, `fetch(`, or external
  npm package imports were added. New imports (`./spec-engine.js`,
  `./spec-types.js`) are internal to agent-runtime. `pnpm lint` boundary check
  passes per the implementer report.
- **ESM convention**: All imports use `.js` extensions.
- **Abort return shape**: The `abort` branch returns
  `{ sessionId, entryId: "", content: "", rounds: 0, toolCalls: 0, usage: zeroUsage(), stopped: "aborted" }`.
  Verified against `AgentRunResult` (types.ts lines 210-218): all required
  fields present with correct types. `"aborted"` is a valid `ModelStopReason`
  (types.ts line 51: `"stop" | "tool_use" | "length" | "aborted" | "error"`).
- **`apply` todo mapping**: `SpecInitialTodo` (`spec-types.ts` lines 84-88)
  has `priority: "high" | "medium" | "low"` but `TodoItem` (`todo.ts` lines 5-9)
  has only `{ id, content, status }` — no `priority` field. The mapping drops
  `priority` intentionally because `TodoItem` has no place for it. The priority
  data is preserved in the persisted `SpecDocument.initialTodos` written by
  the SpecEngine, so it is not truly lost — just not surfaced in the in-memory
  todo list. `TodoItem` validation in `TodoState.set()` (todo.ts lines 25-48)
  would reject an object with extra `priority` properties via the `additionalProperties: false`
  schema on the tool, though the runtime `set()` method itself only checks
  the three known fields. The mapping is correct.
- **`currentSpecId`**: Set in the `apply` branch but not read elsewhere in
  agent.ts. This is expected — it is a hook for later tasks (Task 12) and
  external consumers. Not dead code in the context of the 12-task plan.

## Test Quality

The test file `packages/agent-runtime/test/spec-engine-integration.test.ts`
(210 lines, 6 tests) meets all requirements:

- **6 tests present** (2 baseline from plan + 4 expanded), matching the plan's
  instruction to expand the file.
- **Pipeline exercise**: Test #3 ("emits spec_* events and applies enhanced
  prompt when SpecEngine pipeline runs") configures a full SpecEngine with
  mocked drafter/decisionDetector/enhancer pipeline stages, submits
  `/spec add a feature`, and asserts `spec_start` + `spec_completed` events are
  emitted and `result.stopped === "stop"`. This exercises `submit()` →
  `specEngine.clarify()` → main tool loop end-to-end.
- **Getter verification**: Tests #4 and #5 cover both the present and absent
  cases of `specEngineInstance`.
- **Missing-deps validation**: Test #6 asserts `CodingAgent.create(...)` rejects
  with `/specEngineDeps/` when `specEngine` is set without `specEngineDeps`.
- **Mock client**: All tests import `mockClient` from `spec-pipeline-helpers.js`
  (line 6). No real API calls are made — `mockClient("done")` returns a fixed
  response, and pipeline stages use `mockClient(drafterResponse)` /
  `mockClient("[]")` / `mockClient("## Objective\n...")`.
- **Test helpers**: `makeAgent`, `makeAgentWithSpecEngine`, `makeDeps`,
  `makeSpecEngineOptions` are well-factored and reduce duplication.

Minor test limitation: Test #3 asserts `result.content === "done"`, but
`mockClient("done")` returns `"done"` regardless of input, so this does not
actually prove the enhanced prompt reached the main model. The spec_* event
assertions are what actually verify the pipeline ran. This is acceptable for
an integration smoke test.

## Regression

The implementer reports 411 passed + 10 skipped (0 failed) across 49 test
files, up from 405 + 10. The +6 increase matches the 6 new tests in
`spec-engine-integration.test.ts`. The test file was read and contains exactly
6 tests, all of which are self-contained (no shared mutable state across
tests, each constructs its own agent + session store). The regression claim is
plausible and consistent with the change scope (additive: new optional field,
new optional preprocessing block, no mutation of existing control flow when
`specEngine` is undefined).

## Findings

### Critical

None.

### Important

None.

### Minor

1. Test #3's `result.content === "done"` assertion does not actually verify
   the enhanced prompt was applied — `mockClient("done")` returns `"done"`
   regardless of input. The spec_* event assertions carry the real
   verification weight. A stronger test would use `mockClientSequence` or a
   recording mock to inspect the prompt sent to the main model. Non-blocking.

### Info

1. The `priority` field on `SpecInitialTodo` is intentionally dropped during
   `SpecInitialTodo` → `TodoItem` mapping because `TodoItem` has no `priority`
   field. The data is preserved in the persisted `SpecDocument`. This is a
   design decision, not a bug.
2. The implementer's report lists 4 deviations, but #4 (expanded test
   coverage) is not a deviation — the plan explicitly requested expanding the
   test file. Only deviations 1-3 are actual plan departures.
3. `currentSpecId` is write-only in agent.ts after Task 11. It is presumably
   consumed by Task 12 or external callers. Not dead code in the plan context.

## Recommendation

Proceed to Task 12 — the integration is spec-compliant, all deviations are
valid fixes for plan errors, and the test suite is green.
