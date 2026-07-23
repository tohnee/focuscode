# Task 4 Report: SpecEngine Explorer Stage (Stage 2)

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-explorer.ts` — `exploreCodebase()` and `ExploreCodebaseParams` interface; read-only tool loop that drives the MAIN model through read/grep/glob/ls style tools and parses a final `ExplorerResult` JSON summary
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-explorer.test.ts` — 6 vitest tests covering happy path (tool call → JSON summary), maxRounds limit, pre-aborted signal, non-JSON model output, throwing tool, and empty tool list

## Test results

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-explorer.test.ts`

- Test Files: 1 passed (1)
- Tests: 6 passed (6), 0 failed
- Duration: ~145ms

Per-suite breakdown:

- `returns ExplorerResult from model's final JSON response` — round 1 model emits a `read` tool call, tool result is appended, round 2 model emits JSON summary; `entryPoints` and `testConventions` parsed correctly
- `respects maxRounds limit` — model always returns `tool_use`; loop runs exactly 3 iterations (maxRounds=3), then returns `emptyExplorerResult()`
- `returns empty result on abort` — pre-aborted `AbortController` short-circuits before any model call
- `returns empty result when model returns non-JSON` — `parseJsonResponse` returns `null`, fall-back to `emptyExplorerResult()`
- `continues when read tool throws` — tool error is caught, error string is appended as tool message, next round returns valid JSON
- `uses empty tool list when readOnlyTools is empty` — `request.tools` is `[]` when `readOnlyTools` is empty

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

`packages/agent-runtime/src/spec-explorer.ts` only imports from sibling modules inside `agent-runtime/src`:

- `import type { AgentMessage, AgentTool, ModelClient, ModelProfile, ModelRequest, ModelResponse } from "./types.js"`
- `import type { ExplorerResult } from "./spec-types.js"`
- `import { emptyExplorerResult, parseJsonResponse } from "./spec-pipeline-helpers.js"`

No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `@focuscode/persistence`, `@focuscode/sdk`, `@focuscode/auth`, `@focuscode/ecosystem`, `@focuscode/sandbox`, `@focuscode/tui`, `/apps/`) are present. No external npm packages, no `node:fs`, no `node:child_process`, no `fetch(`.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-explorer.ts packages/agent-runtime/test/spec-explorer.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

A single `prettier --write` pass was needed on the test file to wrap long object literals (the `reliability` block and several `JSON.stringify({...})` payloads) to fit `printWidth: 100`. After the rewrite, both files passed `--check` cleanly and tests continued to pass (the rewrite only changed whitespace/line-wrapping, not behavior).

## Self-review notes

### TDD RED step verified

Before writing the implementation, the RED step failed correctly and for the expected reason:

```
Error: Cannot find module '../src/spec-explorer.js' imported from
.../packages/agent-runtime/test/spec-explorer.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

After writing the implementation and rebuilding, the same command produced 6/6 passing — a true RED → GREEN transition.

### Implementation fidelity to plan

The implementation matches the plan's `spec-explorer.ts` verbatim, with the `ExploreCodebaseParams` interface and `exploreCodebase()` function exported. The control flow is:

1. Pre-abort check — `params.signal?.aborted` returns `emptyExplorerResult()` immediately.
2. Build `toolMap: Map<string, AgentTool>` for O(1) tool lookup during execution.
3. Initialize `messages` with a single user message containing the system prompt + user prompt.
4. Loop `round = 0 .. maxRounds - 1`:
   - Re-check abort signal at the top of each round.
   - Build `ModelRequest` with `tools: readOnlyTools.map(t => t.definition)`, conditionally spread `signal`.
   - Call `client.complete(request)`; on throw, return `emptyExplorerResult()`.
   - If `stopReason !== "tool_use"` or `toolCalls.length === 0`: parse final JSON via `parseJsonResponse<ExplorerResult>`. Validate `parsed.entryPoints` is an array. Return normalized result or `emptyExplorerResult()`.
   - Otherwise, append the assistant message (with `toolCalls`) and execute each tool call. Tool errors are caught and serialized as `Error: <message>` strings in the tool result content. Unknown tools produce `Error: tool "<name>" not available`.
5. If the loop exhausts `maxRounds` without a final JSON, return `emptyExplorerResult()`.

The `normalizeExplorerResult()` helper coerces each field to its expected type (string arrays / string), so a model that returns `{entryPoints: 42}` instead of an array will produce `[]` rather than throwing.

### Type correctness verification

The implementation compiles cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true` — no indexed access on untrusted arrays; tool calls are iterated with `for (const call of response.toolCalls)` which is safe.
- `exactOptionalPropertyTypes: true` — the `signal` field on `ModelRequest` is conditionally spread with `...(params.signal ? { signal: params.signal } : {})`, which correctly omits the property when `signal` is `undefined`. The `ExploreCodebaseParams.signal?: AbortSignal` is also conditionally checked via `params.signal?.aborted` rather than direct access.
- `verbatimModuleSyntax: true` — all type-only imports (`AgentMessage`, `AgentTool`, `ModelClient`, `ModelProfile`, `ModelRequest`, `ModelResponse`, `ExplorerResult`) use `import type`; runtime imports (`emptyExplorerResult`, `parseJsonResponse`) are in a separate `import` statement.
- `isolatedModules: true`

### Deviation 1: Prettier reformatting on test file

The plan's test file was pasted verbatim but did not conform to the project's `printWidth: 100` Prettier config — several inline object literals (the `reliability` block, the inline `JSON.stringify({...})` payloads in the non-JSON and empty-tools tests) exceeded 100 columns. I ran `prettier --write` on the test file to wrap these into multi-line form. The behavior of the tests is unchanged; only whitespace/line-wrapping was modified. The implementation file (`spec-explorer.ts`) needed no reformatting.

### Deviation 2: Plan's commit step skipped

The task constraints say "NEVER commit changes unless explicitly instructed." The plan's Step 5 included a `git commit`, which I did not run. The parent agent / user can commit if desired.

### No other deviations

The implementation is otherwise byte-for-byte identical to the plan's `spec-explorer.ts`. The test file is behaviorally identical to the plan's `spec-explorer.test.ts` modulo Prettier reformatting.

## Concerns

1. **No timeout / wall-clock budget.** The explorer relies on `ModelClient` for transport-level timeout/retry (via `ModelProfile.reliability`). The `maxRounds` parameter bounds the number of model rounds, but a slow model on a fast loop could still run for a long time. The pipeline orchestrator should enforce an overall stage deadline if needed. This matches the plan's minimal-implementation approach for Task 4.

2. **`EXPLORER_SYSTEM_PROMPT` is a module-level constant, not configurable.** The prompt is hardcoded in `spec-explorer.ts`. If the SpecEngine later needs to customize the explorer prompt per project type or per enterprise deployment, this constant would need to become a parameter. The plan does not call for this in Task 4, so it is left as a constant.

3. **Tool error handling is permissive.** When a read-only tool throws (e.g. file not found, grep timeout), the error message is appended to the conversation as the tool result content and the loop continues. This is intentional — the model can react to "file not found" by trying a different path — but it means a misbehaving tool could produce a long string of errors and exhaust `maxRounds` without surfacing the underlying issue. A future enhancement could track consecutive tool failures and short-circuit. Not in scope for Task 4.

4. **`AgentMessage.toolCalls` assigned directly.** The assistant message is constructed with `toolCalls: response.toolCalls` rather than conditionally spread. This works because `ModelResponse.toolCalls` is always an array (per the type), and `AgentMessage.toolCalls?: AgentToolCall[]` accepts an array under `exactOptionalPropertyTypes`. This matches the pattern in `agent.ts` lines 363-372, where `toolCalls` is conditionally spread only to avoid attaching an empty array — but attaching an empty array is also type-safe. I kept the plan's direct assignment for consistency with the plan.

5. **No streaming.** The explorer uses `client.complete()` (non-streaming). This is appropriate for a context-gathering stage that does not need to surface incremental text to the user, but it means long model responses are not visible until the round completes. Not in scope for Task 4.

6. **`maxRounds` semantics.** `maxRounds` bounds the number of `client.complete` calls, not the number of tool calls. A single round can execute up to N tool calls (one per entry in `response.toolCalls`). The plan's test `"respects maxRounds limit"` asserts `callCount <= 3`, which matches the `for (let round = 0; round < params.maxRounds; round++)` loop. This is the intended semantics per the plan.
