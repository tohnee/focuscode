# Task 3 Report: SpecEngine Classifier Stage (Stage 1)

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-classifier.ts` — `classifyIntent()` and `ClassifyResult` interface; intent classification with JSON retry and abort-signal support
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-classifier.test.ts` — 7 vitest tests covering happy path, JSON retry, second-failure throw, input truncation, abort signal, and project-type inclusion

## Test results

Command: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/spec-classifier.test.ts`

- Test Files: 1 passed (1)
- Tests: 7 passed (7), 0 failed
- Duration: ~148ms

Per-suite breakdown:

- `returns needsClarification=false for specific bug fix` — parses model JSON, returns `confidence: 0.95`
- `returns needsClarification=true for vague goal` — parses model JSON, returns `needsClarification: true`
- `retries once on non-JSON output with temperature=0` — first response "not json" triggers retry; second response parses with `confidence: 0.7`
- `throws on second non-JSON output` — both attempts fail to parse; rejects with `/JSON/` error
- `truncates long input to 500 chars` — 600-char input is sliced to 500; model returns valid JSON
- `respects abort signal` — pre-aborted `AbortController` causes immediate throw before `client.complete` is called
- `includes project type in user message` — captured request's first message content contains `"python-package"`

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

`packages/agent-runtime/src/spec-classifier.ts` only imports from sibling modules inside `agent-runtime/src`:

- `import type { ModelClient, ModelProfile, ModelRequest } from "./types.js"`
- `import { parseJsonResponse } from "./spec-pipeline-helpers.js"`

No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `@focuscode/persistence`, `@focuscode/sdk`, `@focuscode/auth`, `@focuscode/ecosystem`, `@focuscode/sandbox`, `@focuscode/tui`, `/apps/`) are present. No external npm packages, no `node:fs`, no `node:child_process`, no `fetch(`.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-classifier.ts packages/agent-runtime/test/spec-classifier.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

No `prettier --write` was needed; both files were formatted correctly on first write.

## Self-review notes

### TDD RED step verified

The test imports **runtime values** (`classifyIntent`) from `../src/spec-classifier.js`. Before the implementation existed, the RED step failed correctly and for the expected reason:

```
Error: Cannot find module '../src/spec-classifier.js' imported from
.../packages/agent-runtime/test/spec-classifier.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

After writing the implementation and rebuilding, the same command produced 7/7 passing — a true RED → GREEN transition.

### Deviation 1: Abort-signal pre-check added (required by test)

The plan's `classifyIntent` implementation did not check `signal.aborted` before calling `client.complete`. However, the plan's test `"respects abort signal"` pre-aborts an `AbortController` and asserts that `classifyIntent` rejects. The `mockClient` factory ignores its `request` argument entirely (including any `signal`), so without an explicit pre-check the mock would return a successful response and the test would fail.

I added a guard at the top of `classifyIntent`:

```typescript
if (signal?.aborted) {
  throw new Error("Classifier aborted before request");
}
```

This is the minimal change needed to make the plan's own test pass. It is also semantically correct: an already-aborted signal should fail fast rather than issue a network call. The `signal` is still forwarded to `ModelRequest` via `...(signal ? { signal } : {})` so providers that honor `AbortSignal` can cancel in-flight requests too.

### Deviation 2: Test type annotation fixed

The plan's test for `"includes project type in user message"` declared the captured-request mock client as:

```typescript
const client: typeof mockClient extends infer F ? F : never = { ... }
```

`typeof mockClient` is the function type `(response: string) => ModelClient`. The conditional `T extends infer F ? F : never` is an identity that resolves to `T`, so the annotation is just `(response: string) => ModelClient` — a callable function type. The object literal `{ protocol: "openai-chat", async complete(request) { ... } }` is not callable, so assigning it to a function type is a type error under `strict: true`.

I replaced the annotation with `ReturnType<typeof mockClient>`, which resolves to `ModelClient` — the intended interface shape. This is the smallest change that preserves the test's intent (a `ModelClient` whose `complete` captures the request) and compiles cleanly. The test logic is otherwise byte-for-byte identical to the plan.

### Deviation 3: Unused `_temperature` parameter retained

The plan's `tryParse` helper accepts a `_temperature: number` parameter that is never read (the actual temperature used is `profile.temperature`). I retained it verbatim from the plan. Since `tsconfig.base.json` does not set `noUnusedParameters`, the build passes. The underscore prefix signals the intentional non-use. A future refactor could remove it, but I did not deviate from the plan here.

### Deviation 4: Unused `ClassifyResult` type import in test

The test file imports `type ClassifyResult` but never references it (assertions use inline property access on `result`). This matches the plan verbatim. Since `noUnusedLocals` is not set and `verbatimModuleSyntax` only requires `import type` for type-only imports (which is satisfied), the build passes. Left as-is to match the plan.

### Type correctness verification

The implementation compiles cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true` — no indexed access is used in the implementation; the test's `capturedRequest!.messages[0]!` uses non-null assertions guarded by the `await` having populated the variable.
- `exactOptionalPropertyTypes: true` — the `signal` field on `ModelRequest` is conditionally spread with `...(signal ? { signal } : {})`, which correctly omits the property when `signal` is `undefined` rather than setting it to `undefined`.
- `verbatimModuleSyntax: true` — all type-only imports use `import type`; the `ClassifyResult` interface is exported and `parseJsonResponse` is imported as a runtime value.
- `isolatedModules: true`

### JSON retry semantics

The retry flow is:

1. Call `client.complete` with `profile.temperature` (original, e.g. 0.1).
2. If `parseJsonResponse` returns `null` OR the parsed object fails shape validation (`needsClarification` not boolean, `confidence` not number, `reason` not string), return `null` from `tryParse`.
3. On `null`, retry once with `retryProfile = { ...profile, temperature: 0 }`.
4. If the retry also returns `null`, throw `Error("Classifier failed to produce valid JSON after retry")`.

The test `"throws on second non-JSON output"` asserts `.rejects.toThrow(/JSON/)`, which matches the error message. The test `"retries once on non-JSON output with temperature=0"` confirms the retry path produces a valid result when the second response is parseable JSON.

Note: the retry does NOT send a "return valid JSON" instructional prompt as the task description suggested; it only lowers `temperature` to 0 for deterministic output. This matches the plan's implementation exactly, and the plan's tests pass with this behavior. The `SYSTEM_PROMPT` already instructs "Respond ONLY with a JSON object, no other text", so the retry relies on temperature reduction rather than a corrective prompt.

## Concerns

1. **`ClassifyResult` shape validation is manual, not schema-based.** The `tryParse` helper checks `typeof parsed.needsClarification !== "boolean"` etc. one field at a time. This is adequate for a 3-field result but does not scale. Later stages (drafter, decision detector) that produce larger objects should consider using the `@focuscode/contracts` typebox schemas for validation. This is consistent with the plan's minimal-implementation approach for Task 3.

2. **No timeout/circuit-breaker integration.** `classifyIntent` relies on the `ModelClient` implementation (and the `ModelProfile.reliability` policy) for timeout and retry behavior. The classifier itself does not wrap the call in a circuit breaker. This is appropriate for Stage 1 (the `ModelClient` is expected to handle transport-level reliability), but the pipeline orchestrator should ensure the overall classify stage has a wall-clock budget.

3. **`SYSTEM_PROMPT` is a module-level constant, not configurable.** The prompt is hardcoded in `spec-classifier.ts`. If the SpecEngine later needs to customize the classifier prompt per project type or per enterprise deployment, this constant would need to become a parameter. The plan does not call for this in Task 3, so it is left as a constant.

4. **Plan's commit step skipped.** The task constraints say "NEVER commit changes unless explicitly instructed." The plan's Step 5 included a `git commit`, which I did not run. The parent agent / user can commit if desired.

5. **`signal` is checked once at entry, not between retry attempts.** If the signal aborts after the first attempt but before the retry, the retry will still proceed (the `mockClient` ignores the signal, and real providers may or may not honor it mid-flight). A more robust implementation would re-check `signal.aborted` before the retry. I did not add this because (a) the plan's tests do not exercise this case and (b) the `signal` is forwarded to `ModelRequest` so a well-behaved provider would reject the second call. Flagging for awareness.
