# Task 3 Review: SpecEngine Classifier Stage

**Reviewer:** GLM-5.2 (sub-agent)
**Date:** 2026-07-23
**Files reviewed:**

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-classifier.ts`
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-classifier.test.ts`
- `/Users/tohnee/Trae/Code/focuscode/docs/superpowers/execution-log/task-3-report.md`

## Spec Compliance: ✅ PASS

The implementation faithfully follows the **actual Task 3 spec** in the plan (lines 702-948 of `2026-07-23-spec-engine.md`).

### Checklist reconciliation

The review checklist supplied to this reviewer references `SpecClassification`, `action: "skip"`, and `understanding` fields. **These do not match the actual Task 3 spec or Task 1 types**, and the checklist appears to have been derived from the plan's dependency/coverage tables rather than the Task 3 implementation section. Evidence:

- `SpecClassification` is **not defined** in `packages/agent-runtime/src/spec-types.ts` (grep for `Classification|ClassifyResult` returned zero matches). The type defined and used by Task 3 is `ClassifyResult = { needsClarification: boolean; confidence: number; reason: string }`, declared locally in `spec-classifier.ts`.
- The plan's dependency table (line 3823) claims `SpecClassification` is "Defined In: Task 1" — this is an **error in the plan's self-review table**. Task 1 does not define it.
- The plan's coverage table (line 3799) claims "Fail-safe principle (all errors → action: 'skip') | Tasks 3-9 (each stage's try/catch returns skip)". This is **misleading for Task 3**: the Task 3 implementation spec (lines 877-932) throws on error; the `action: "skip"` fail-safe is implemented at the **orchestrator layer (Task 9)**, which wraps `classifyIntent` in try/catch (plan lines 3089-3096). The classifier itself throwing is the intended, correct behavior for Stage 1.

Per-checklist items, judged against the **actual** Task 3 spec:

1. **Signature** — ✅ Matches plan exactly: `(client: ModelClient, profile: ModelProfile, prompt: string, projectType: string, signal?: AbortSignal) => Promise<ClassifyResult>`. (The checklist's `(client, model, prompt, options?)` shape does not appear in the plan and is disregarded.)
2. **`parseJsonResponse` usage** — ✅ Used in `tryParse` to extract JSON from `response.content`, tolerating markdown fences via the Task 2 helper.
3. **JSON retry on parse failure** — ✅ `callWithRetry` makes a first attempt, then retries once with `temperature: 0` if `tryParse` returns `null`.
4. **Fail-safe default on error** — ⚠️ Not applicable at this layer per the actual spec. The classifier **throws** `Error("Classifier failed to produce valid JSON after retry")` on second parse failure and propagates transport errors from `client.complete`. The fail-safe `action: "skip"` is the orchestrator's responsibility (Task 9). This matches the Task 3 code spec verbatim.
5. **System prompt instructs JSON-only output** — ✅ `SYSTEM_PROMPT` contains "Respond ONLY with a JSON object, no other text." and provides 5 few-shot examples.
6. **Deviations reasonable and necessary** — ✅ See "Deviation assessment" below.

### Deviation assessment

| #   | Deviation                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Abort-signal pre-check (`if (signal?.aborted) throw`) added at top of `classifyIntent`                 | ✅ **Necessary.** The plan's own test `"respects abort signal"` pre-aborts an `AbortController` and asserts rejection, but `mockClient` ignores the request argument (including `signal`). Without this guard the test would receive a successful response and fail. Semantically correct (fail-fast on already-aborted signal). The signal is still forwarded to `ModelRequest` via `...(signal ? { signal } : {})` for in-flight cancellation. |
| 2   | Test type annotation `typeof mockClient extends infer F ? F : never` → `ReturnType<typeof mockClient>` | ✅ **Necessary.** The plan's annotation resolves to a callable function type `(response: string) => ModelClient`; assigning a non-callable object literal to it is a `strict` error. `ReturnType<typeof mockClient>` = `ModelClient` is the intended shape. Test logic otherwise byte-identical.                                                                                                                                                 |
| 3   | Report claims unused `_temperature` parameter "retained"                                               | ⚠️ **Report inaccuracy, not a code issue.** The implementation actually **removed** the unused `_temperature` parameter from `tryParse` (5 params, not 6) and dropped the corresponding arguments in `callWithRetry`. This is a clean-up improvement over the plan. The implementer's report text is stale on this point.                                                                                                                        |
| 4   | Unused `type ClassifyResult` import in test                                                            | ✅ Acceptable. `verbatimModuleSyntax` satisfied via inline `import { classifyIntent, type ClassifyResult }`. `noUnusedLocals` is not set in `tsconfig.base.json` (confirmed). Matches plan verbatim.                                                                                                                                                                                                                                             |

## Code Quality: ✅ APPROVED

Verified against `tsconfig.base.json`:

- **`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`** — all satisfied.
  - `exactOptionalPropertyTypes`: `signal` conditionally spread via `...(signal ? { signal } : {})` — correctly omits the property when `undefined` rather than setting it to `undefined`. ✅
  - `verbatimModuleSyntax`: `import type { ModelClient, ModelProfile, ModelRequest }` for type-only; `import { parseJsonResponse }` for runtime value. ✅
- **No external imports, no `node:fs`/`child_process`/`fetch`** — only `./types.js` and `./spec-pipeline-helpers.js`. Boundary-safe per `agent-runtime` rules. ✅
- **`.js` import extensions** — present on both imports. ✅
- **Prettier** — report claims `prettier --check` passed; visual inspection confirms double quotes, trailing commas, 2-space indent, semicolons, printWidth ≤ 100. ✅
- **Error handling** — `tryParse` returns `null` on parse failure or shape-validation failure (caller retries/throws); `callWithRetry` throws on second failure; `classifyIntent` propagates (no swallow). Shape validation is manual (`typeof` checks on each of the 3 fields) — adequate for a 3-field result; report's Concern #1 correctly flags that later stages with larger objects should use `@focuscode/contracts` typebox schemas. ✅
- **Abort signal** — pre-check at entry + forwarded to `ModelRequest`. Report's Concern #5 flags that the signal is not re-checked between retry attempts; acceptable since (a) no test exercises that case and (b) a well-behaved provider honors the forwarded signal mid-flight. ⚠️ Minor robustness gap, not blocking.

Minor notes (non-blocking):

- `SYSTEM_PROMPT` is a module-level constant, not configurable. Report's Concern #3 acknowledges this; acceptable for Task 3 scope.
- No try/catch around `client.complete(request)` — transport-level reliability is delegated to `ModelClient` / `ModelProfile.reliability` (report's Concern #2). Matches plan intent.

## Test Quality: ✅ APPROVED

7 tests, all mapping to required coverage:

| Test                                                    | Covers                          | Assertion quality                                                              |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `returns needsClarification=false for specific bug fix` | Normal classification (execute) | Asserts `needsClarification` + `confidence` ✅                                 |
| `returns needsClarification=true for vague goal`        | Normal classification (clarify) | Asserts `needsClarification` ✅                                                |
| `retries once on non-JSON output with temperature=0`    | JSON parse failure + retry      | Asserts `needsClarification` + `confidence` after retry ✅                     |
| `throws on second non-JSON output`                      | Error fallback (second failure) | Asserts `.rejects.toThrow(/JSON/)` matching error message ✅                   |
| `truncates long input to 500 chars`                     | Input boundary                  | 600-char input → success ✅                                                    |
| `respects abort signal`                                 | Abort signal                    | Pre-aborted controller → throw ✅                                              |
| `includes project type in user message`                 | Request construction            | Captures request, asserts `messages[0].content` contains `"python-package"` ✅ |

- ✅ Tests use `mockClient` / `mockClientSequence` from Task 2 helpers (no re-implemented mocks except the captured-request client in the last test, which is a justified one-off).
- ✅ Tests assert meaningful behavior on `needsClarification` and `confidence`. (`reason` is not directly asserted in expectations but is validated by the shape check in `tryParse` — a non-string `reason` would cause `null` → retry/throw. The checklist's reference to "action type / understanding fields" does not apply to `ClassifyResult`.)

Minor test gaps (non-blocking):

- The retry test name says "with temperature=0" but does **not** capture/assert that the second `ModelRequest.temperature` was `0`. The implementation does set `retryProfile.temperature = 0`, but no test verifies it. A captured-request assertion on the second call's `temperature` would close this gap.
- No test exercises the shape-validation failure path (e.g., model returns valid JSON but `needsClarification` is a string). Currently `tryParse` returns `null` in that case, triggering retry/throw, but no test confirms this. Low risk given the `typeof` guards are simple.
- `mockClientSequence` clamps the index via `Math.min(i, responses.length - 1)`, so a test that under-provides responses would silently reuse the last one rather than fail. Not a defect in this task's tests (all sequences have exactly 2 entries), but worth noting for later stages.

## Overall Verdict: APPROVED

The implementation is a faithful, clean realization of the Task 3 spec. Both justified deviations (abort pre-check, type annotation fix) are necessary to make the plan's own tests compile and pass. The implementer also made a small improvement by removing the unused `_temperature` parameter.

### Findings by severity

**Blocking:** none.

**High:** none.

**Medium:**

- M1 (process): The review checklist supplied for this task references `SpecClassification` / `action: "skip"` / `understanding` fields that do not exist in the Task 3 spec or Task 1 types. The checklist was likely generated from the plan's dependency/coverage tables, which themselves contain an error (line 3823 claims `SpecClassification` is defined in Task 1 — it is not). The implementation correctly follows the Task 3 implementation section. **Recommend the parent agent reconcile the checklist with the actual Task 3 spec before drawing conclusions about "fail-safe skip" compliance; the fail-safe skip is a Task 9 (orchestrator) concern, not Task 3.**

**Low:**

- L1 (report accuracy): The implementer's report "Deviation 3" states the unused `_temperature` parameter was "retained" from the plan. In fact the implementation **removed** it. Code is correct; report text is stale.
- L2 (test gap): Retry test does not assert `temperature === 0` was sent on the second call, despite the test name implying it.
- L3 (test gap): No test for the shape-validation failure path (valid JSON, wrong field types).
- L4 (robustness): Signal not re-checked between retry attempts (report's Concern #5). Acceptable for Task 3.

### Verification commands (per implementer report, not re-run by this reviewer)

- `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/spec-classifier.test.ts` → 7/7 passed
- `node scripts/check-boundaries.mjs` → PASS
- `npx prettier --check packages/agent-runtime/src/spec-classifier.ts packages/agent-runtime/test/spec-classifier.test.ts` → PASS
