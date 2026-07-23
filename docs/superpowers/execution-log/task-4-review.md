# Task 4 Review: SpecEngine Explorer Stage

**Reviewed:** `packages/agent-runtime/src/spec-explorer.ts`, `packages/agent-runtime/test/spec-explorer.test.ts`
**Verifier:** review sub-agent
**Date:** 2026-07-23

## Verification Commands Run

- `pnpm --filter @focuscode/agent-runtime build` — PASS (tsc clean, exit 0)
- `npx vitest run packages/agent-runtime/test/spec-explorer.test.ts` — PASS (6/6, 201ms)
- `node scripts/check-boundaries.mjs` — PASS ("Architecture boundary check passed.")
- `npx prettier --check packages/agent-runtime/src/spec-explorer.ts packages/agent-runtime/test/spec-explorer.test.ts` — PASS

## Spec Compliance

| #   | Requirement                                                                  | Status           | Notes                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Uses the main model with read-only tools                                     | PASS             | `params.modelClient` + `params.readOnlyTools`; tools passed via `readOnlyTools.map(t => t.definition)`.                                                                                                                                                   |
| 2   | Runs a tool loop (model → tool call → execute → feed back → repeat)          | PASS             | `for (round = 0; round < maxRounds; …)` loop appends assistant message + tool results and re-calls `client.complete`.                                                                                                                                     |
| 3   | Filters tools to read-only set (read, grep, find, ls, web_fetch, web_search) | PASS (by design) | Filtering is the caller's responsibility — `readOnlyTools` is received pre-filtered. This matches the plan's interface contract. The explorer itself does not filter.                                                                                     |
| 4   | Returns `ExplorerResult` with relevant fields                                | PASS             | Returns `ExplorerResult` (`entryPoints`, `patterns`, `testConventions`, `constraints`, `relevantFiles`) per `spec-types.ts`. (Checklist's wording "understanding/codebasePatterns" does not match the actual type; implementation matches the real type.) |
| 5   | Uses `parseJsonResponse` for final output extraction                         | PASS             | Line 79: `parseJsonResponse<ExplorerResult>(response.content)`.                                                                                                                                                                                           |
| 6   | Fail-safe: returns `emptyExplorerResult()` on error                          | PASS             | Returns empty on: pre-abort, per-round abort, `client.complete` throw, non-JSON/unparseable content, and exhausted `maxRounds`.                                                                                                                           |

## Code Quality

| #   | Requirement                                                                  | Status | Notes                                                                                                                                 |
| --- | ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TypeScript strict, no external imports, no `node:fs`/`child_process`/`fetch` | PASS   | Only imports from sibling `./types.js`, `./spec-types.js`, `./spec-pipeline-helpers.js`. Boundary check confirms no forbidden tokens. |
| 2   | `.js` import extensions, `import type` for type-only                         | PASS   | Type-only imports use `import type`; runtime imports (`emptyExplorerResult`, `parseJsonResponse`) are separate without `type`.        |
| 3   | Prettier formatting                                                          | PASS   | `prettier --check` clean on both files.                                                                                               |
| 4   | Tool loop has `maxRounds` limit                                              | PASS   | `for (let round = 0; round < params.maxRounds; round++)` bounds iterations.                                                           |
| 5   | Abort signal handling                                                        | PASS   | Pre-loop check + per-round check + passed to `ModelRequest.signal`.                                                                   |

**Deviation from plan (improvement):** The plan's import block included `AgentToolCall` from `./types.js`, but that type is never referenced directly in the implementation (it's only used indirectly via `AgentMessage.toolCalls` / `ModelResponse.toolCalls`). The implementer correctly omitted the unused import. This is a positive deviation — removing dead imports keeps `verbatimModuleSyntax`/`isolatedModules` clean.

## Test Quality

| #   | Requirement                                                                  | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Tests cover normal exploration, tool loop, JSON parse, error fallback, abort | PASS   | 6 tests: happy path (tool call → JSON), maxRounds limit, pre-abort, non-JSON, throwing tool, empty tool list.                                                                                                                                                                                                                                                                              |
| 2   | Tests use `mockClient`/`mockClientSequence`                                  | N/A    | Tests use inline mock clients instead of the exported helpers. This is appropriate: the helpers (`mockClient`/`mockClientSequence` in `spec-pipeline-helpers.ts`) only emit `stopReason: "stop"` with no `toolCalls`, so they cannot simulate the tool-loop rounds the explorer requires. The inline mocks correctly branch on `request.messages.length` to simulate multi-round tool use. |
| 3   | Tests assert meaningful behavior                                             | PASS   | Asserts `entryPoints`, `testConventions`, `callCount <= 3`, captured `request.tools`, and empty-fallback results.                                                                                                                                                                                                                                                                          |

**Test coverage gap (Low):** No test exercises a multi-call round (a single model response with two tool calls). The loop's inner `for (const call of response.toolCalls)` is only ever exercised with a single-element `toolCalls` array. Not blocking — the code path is simple — but a second tool call in one round would confirm ordering of appended tool messages.

## Findings

### Finding 1 — Abort signal not propagated to tool execution (Low)

**Location:** `spec-explorer.ts:100` — `tool.execute(call.arguments, { cwd: params.cwd })`
**Detail:** `ToolExecutionContext` accepts `{ cwd: string; signal?: AbortSignal }`, but the explorer omits `signal`. A long-running read-only tool (e.g. a slow grep) cannot be interrupted mid-execution; abort only takes effect between rounds. This matches the plan verbatim, so it's not a deviation — but if the orchestrator enforces a stage deadline, tool-level cancellation would be useful.
**Severity:** Low
**Recommendation:** Consider `{ cwd: params.cwd, ...(params.signal ? { signal: params.signal } : {}) }` in a future pass. Not blocking for Task 4.

### Finding 2 — `stopReason` branching is imprecise but fail-safe (Low)

**Location:** `spec-explorer.ts:77` — `if (response.stopReason !== "tool_use" || response.toolCalls.length === 0)`
**Detail:** A `stopReason` of `"length"`, `"aborted"`, or `"error"` falls into the "parse final JSON" branch. For `"length"` the content may be truncated; for `"error"` it may be empty. However, `parseJsonResponse` returns `null` on failure and the code falls back to `emptyExplorerResult()`, so the behavior is fail-safe. No correctness bug.
**Severity:** Low (informational)
**Recommendation:** Optionally special-case `"error"`/`"aborted"` to short-circuit to `emptyExplorerResult()` without a parse attempt. Cosmetic only.

### Finding 3 — System prompt mentions "glob" while checklist mentions "find" (Info)

**Location:** `spec-explorer.ts:13` — `read-only tools: read, grep, glob, ls`
**Detail:** The review checklist lists `read, grep, find, ls, web_fetch, web_search`; the prompt string mentions `read, grep, glob, ls`. This is purely instructional text for the model and does not filter or constrain the actual tool set (which is `readOnlyTools`). No behavioral impact.
**Severity:** Info
**Recommendation:** None required. The prompt is a module-level constant; aligning the wording with the actual tool registry names would be a minor improvement if desired.

### Finding 4 — No test for multi-tool-call round (Low)

**Location:** `spec-explorer.test.ts`
**Detail:** Every test's `toolCalls` array has exactly one element. The inner `for (const call of response.toolCalls)` loop is never exercised with 2+ calls, so the ordering/content of multiple appended `tool` messages is untested.
**Severity:** Low
**Recommendation:** Add a test where round 1 returns two tool calls and assert both tool results are appended before round 2. Optional; the code path is straightforward.

### Finding 5 — `normalizeExplorerResult` is robust (Positive)

**Location:** `spec-explorer.ts:119-127`
**Detail:** Defensive coercion (`Array.isArray(...) ? ...map(String) : []`) prevents runtime errors when the model returns malformed field types (e.g. `entryPoints: 42`). Good defensive coding; no test specifically covers this coercion but it's a safety net.
**Severity:** Positive observation

## Overall Verdict

**APPROVED**

The implementation is faithful to the plan, with one positive deviation (removing an unused `AgentToolCall` import). All spec-compliance, code-quality, and test-quality criteria are met. The build compiles cleanly under strict TypeScript, all 6 tests pass, the architecture boundary check passes, and Prettier is clean. The findings are all Low/Info severity and match the plan's intended minimal implementation — none are blocking. The explorer correctly implements a bounded read-only tool loop with fail-safe fallback to `emptyExplorerResult()` on every error path.
