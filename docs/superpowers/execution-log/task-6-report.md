# Task 6 Report: SpecEngine Decision Detector Stage (Stage 4)

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-decision-detector.ts` — `detectDecisions()` exported function. Calls a 1B-2B class model with a system prompt + user message built from the `KeyDecisionRule[]` and the pretty-printed `SpecDraft` JSON, parses the response as a JSON array of decisions via `parseJsonResponse`, normalizes each entry into `SpecKeyDecision`, retries once at `temperature: 0` on parse failure, and throws if the retry also fails. Includes `normalizeDecision` and `normalizeOption` helpers that coerce model output to the `SpecKeyDecision` schema, plus a single retry path that re-issues the request with a stricter "Output must be valid JSON array, no markdown fences" suffix.
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-decision-detector.test.ts` — 8 vitest tests covering: empty-array happy path, decision parsing with severity/options, retry on non-JSON, throw on second non-JSON, malformed-decision filtering, rule inclusion in the user message, unknown-severity normalization, and missing-options default.

## Test results

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-decision-detector.test.ts`

- Test Files: 1 passed (1)
- Tests: 8 passed (8), 0 failed
- Duration: ~150ms

Per-suite breakdown:

- `returns empty array when model outputs []` — `mockClient("[]")` returns `[]`; `detectDecisions` resolves to `[]`.
- `parses decisions with severity` — single decision with `severity: "critical"` and 2 options; asserts `severity === "critical"` and `options.length === 2`.
- `retries on non-JSON output` — first response is `"not json"`, second is `"[]"`; asserts retry path succeeds with `[]`.
- `throws on second non-JSON output` — both responses non-JSON; `detectDecisions` rejects with error matching `/JSON/`.
- `filters out malformed decisions` — model returns 3 entries; only `d1` (valid) is kept; entries with empty `id` or non-array `options` are dropped.
- `includes rules in user message` — a custom `ModelClient` captures `request.messages[0].content`; the captured string contains both `"destructive-change"` and `"arch-decision"` rule names.
- `normalizes unknown severity to minor` — `severity: "unknown"` is coerced to `"minor"`.
- `defaults missing options to empty array` — decision with no `options` field gets `options: []`.

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

`packages/agent-runtime/src/spec-decision-detector.ts` only imports from sibling modules inside `agent-runtime/src`:

- `import type { ModelClient, ModelProfile, ModelRequest } from "./types.js"`
- `import type { KeyDecisionRule, SpecDraft, SpecKeyDecision } from "./spec-types.js"`
- `import { parseJsonResponse } from "./spec-pipeline-helpers.js"`

No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `@focuscode/persistence`, `@focuscode/sdk`, `@focuscode/auth`, `@focuscode/ecosystem`, `@focuscode/sandbox`, `@focuscode/tui`, `/apps/`) are present. No external npm packages, no `node:fs`, no `node:child_process`, no `fetch(`.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-decision-detector.ts packages/agent-runtime/test/spec-decision-detector.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

The implementation file passed `--check` on the first try. The test file needed one `prettier --write` pass to wrap the long single-line JSON literal in the `normalizes unknown severity to minor` test case. Tests continued to pass after the rewrite (whitespace-only change).

## Self-review notes

### TDD RED step verified

Before writing the implementation, the RED step failed correctly and for the expected reason:

```
Error: Cannot find module '../src/spec-decision-detector.js' imported from
.../packages/agent-runtime/test/spec-decision-detector.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

After writing the implementation and rebuilding, the same command produced 8/8 passing — a true RED → GREEN transition.

### Implementation fidelity to plan

The implementation matches the plan's `spec-decision-detector.ts` behaviorally. The control flow is:

1. `detectDecisions(client, profile, draft, rules)` — builds the user message by concatenating `Detection rules:\n<rulesText>` (one `name: description` per line) with `Spec draft:\n<JSON.stringify(draft, null, 2)>`.
2. `tryParse(client, profile, userMessage)` — builds a `ModelRequest` with `SYSTEM_PROMPT`, a single user message, empty `tools`, `profile.temperature`, and `profile.maxOutputTokens`; calls `client.complete`; runs `parseJsonResponse<unknown>` on `response.content`; returns `null` if parsing failed, if the parsed value is not an array, or if every element failed normalization.
3. If the first attempt returns `null`, retry with `{ ...profile, temperature: 0 }` and a user message appended with `\n\nIMPORTANT: Output must be valid JSON array, no markdown fences.`.
4. If the retry also returns `null`, throw `Error("Decision detector failed to produce valid JSON after retry")` — the message contains `"JSON"` so the test's `/JSON/` regex matches.
5. `normalizeDecision(item)` validates `item.id` is a non-empty string and `item.point` is a string; if not, returns `null`. Coerces `severity` to `"minor"` if not one of `"critical" | "major" | "minor"`. Coerces `options` per the rule below.
6. `normalizeOption(item)` validates `label` and `description` are strings; `tradeoffs` defaults to `""` if missing or non-string. Returns `null` if `label`/`description` validation fails.

### Deviation 1: Malformed-options handling

The plan's `normalizeDecision` defaulted any non-array `options` (including a present-but-wrong-type value like `"not array"`) to `[]`. This caused the `filters out malformed decisions` test to fail: the entry `{ id: "d3", point: "invalid no options", options: "not array", severity: "minor" }` was kept with `options: []` instead of being dropped, yielding 2 results instead of the expected 1.

The plan's test expects this entry to be rejected as malformed, while the separate `defaults missing options to empty array` test expects an entry with no `options` field to be kept with `options: []`. These two expectations are only consistent if the normalizer distinguishes **missing** `options` (default to `[]`, keep the decision) from **present-but-non-array** `options` (reject as malformed).

I changed `normalizeDecision` to:

```typescript
let options: SpecKeyDecision["options"];
if (obj.options === undefined) {
  options = [];
} else if (Array.isArray(obj.options)) {
  options = obj.options
    .map(normalizeOption)
    .filter((o): o is SpecKeyDecision["options"][number] => o !== null);
} else {
  return null;
}
```

This makes both tests pass and is a more conservative parser: a model that emits `options: "not array"` is signaling type confusion and should be rejected rather than silently coerced. This is a behavioral deviation from the plan's literal code but matches the plan's test expectations, which take precedence over the plan's code snippet (the tests are the spec).

### Deviation 2: Test file typing for the custom-client test

The plan's `includes rules in user message` test used an untyped object literal for the client with a narrow `complete` parameter type `{ messages: { content: string }[] }` and an inline anonymous return type. Under `strict` + `strictFunctionTypes`, the inferred return shape widens `"stop"` to `string` (not assignable to `ModelStopReason`), and the narrow parameter type would not match `ModelRequest` when the object literal is passed to `detectDecisions(client, ...)` expecting `ModelClient`. I adjusted the test to explicitly type the client as `ModelClient` and annotate the `complete` method as `async complete(request: ModelRequest): Promise<ModelResponse>`, mirroring the pattern used in `spec-drafter.test.ts` and `spec-explorer.test.ts`. The assertions and behavior are unchanged; only the type annotations were added so the test compiles.

### Deviation 3: Prettier reformatting on the test file

The test file needed one `prettier --write` pass to wrap the long single-line JSON literal in the `normalizes unknown severity to minor` test case to fit `printWidth: 100`. The implementation file passed `--check` on the first try. The reformatting only changed whitespace/line-wrapping; tests continued to pass after the rewrite.

### Deviation 4: Plan's commit step skipped

The task constraints say "NEVER commit changes unless explicitly instructed." The plan's Step 5 included a `git commit`, which I did not run. The parent agent / user can commit if desired.

### No other deviations

The implementation is otherwise behaviorally identical to the plan's `spec-decision-detector.ts`. The test file is behaviorally identical to the plan's `spec-decision-detector.test.ts` modulo the typing fix and Prettier reformatting described above.

## Type correctness verification

The implementation compiles cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true` — indexed access on `parsed` array elements goes through `normalizeDecision` which validates types before use; `result[0]!` in tests is guarded by `toHaveLength` assertions.
- `exactOptionalPropertyTypes: true` — `SpecKeyDecision` has optional `chosen?` and `rationale?` fields; `normalizeDecision` does not set them, so they are correctly omitted (not set to `undefined`).
- `verbatimModuleSyntax: true` — all type-only imports use `import type`; the only runtime import is `parseJsonResponse` (from `./spec-pipeline-helpers.js`).
- `isolatedModules: true`

## Concerns

1. **No abort signal support.** Unlike `classifyIntent` (Task 3) and `exploreCodebase` (Task 4), `detectDecisions` does not accept an `AbortSignal`. The detector can make up to 2 model calls (first attempt + retry), and there is no way to cancel mid-flight. The plan does not include a signal parameter for Task 6, so this matches the plan; the pipeline orchestrator should enforce an overall stage deadline if needed.

2. **Severity filtering is not applied here.** The plan's task description mentions "severity filtering (critical/major pause, minor auto-resolved)" as a behavior of the decision detector. The implemented `detectDecisions` returns ALL detected decisions (critical + major + minor) without filtering; the orchestrator that calls this stage is responsible for splitting the result into "pause for user" (critical/major) vs "auto-resolved" (minor) buckets. This matches the plan's code and tests, which assert that minor-severity decisions are returned (not dropped), but it means downstream code must not assume `detectDecisions` returns only pause-worthy decisions.

3. **`chosen` and `rationale` are never populated.** `SpecKeyDecision` has optional `chosen?` and `rationale?` fields for recording the user's selection after confirmation. `normalizeDecision` does not set these — they are populated later by the confirmation/persistence stage. This is correct per the plan but means a consumer cannot rely on `chosen` being set immediately after detection.

4. **Retry uses `temperature: 0` but does not change `maxOutputTokens`.** A model that ran out of output tokens on the first attempt (producing truncated JSON) would likely fail again on retry with the same token budget. The plan does not call for increasing `maxOutputTokens` on retry, so this matches the plan. A future enhancement could detect `stopReason === "length"` and bump the token budget.

5. **Normalizers silently drop invalid items.** `normalizeDecision` filters out any item for which validation returns `null`. If the model emits a structurally invalid decision (e.g., `{ point: "p" }` with no `id`), it is silently dropped rather than surfaced. This is intentional fail-safe behavior per the plan, but it means a malformed model response could produce fewer decisions than intended without any warning. The pipeline trace (a later task) should capture token usage and fallback signals so the orchestrator can detect degraded detection.

6. **No fail-safe `[]` return on error.** The task description in the delegation says "Fail-safe: returns [] on error", but the plan's implementation throws on second non-JSON output (verified by the `throws on second non-JSON output` test). I followed the plan's behavior (throw) rather than the delegation's summary (return `[]`), because the plan's tests are the authoritative spec and they explicitly assert the throw. If the orchestrator wants fail-safe behavior, it should wrap `detectDecisions` in a try/catch at the call site. Flagging this in case the delegation's "fail-safe" expectation was intended to override the plan.

7. **No streaming.** The detector uses `client.complete()` (non-streaming). This is appropriate for a structured-JSON generation stage, but it means long model responses are not visible until the call completes. Not in scope for Task 6.
