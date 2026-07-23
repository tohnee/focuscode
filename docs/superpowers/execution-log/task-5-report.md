# Task 5 Report: SpecEngine Drafter Stage (Stage 3)

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-drafter.ts` — `draftSpec()` and `DraftSpecParams` interface; calls a 3B-7B class model with a system prompt + user message built from the explorer result + instructions summary, parses the JSON response into a `SpecDraft`, retries once at `temperature: 0` on parse failure, and throws if the retry also fails. Includes field-level normalizers that coerce model output to the `SpecDraft` schema and a `generateSpecId()` helper that mints `spec_<unix-seconds>_<6-hex>` IDs via `node:crypto.randomBytes`.
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-drafter.test.ts` — 6 vitest tests covering happy-path JSON parsing, spec ID format, retry on non-JSON, throw on second non-JSON, explorer-result/instructions inclusion in the user message, and missing-array normalization.

## Test results

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-drafter.test.ts`

- Test Files: 1 passed (1)
- Tests: 6 passed (6), 0 failed
- Duration: ~145ms

Per-suite breakdown:

- `parses valid spec draft JSON` — full schema (topic + understanding with all 4 sub-arrays + taskBreakdown) is parsed; `topic`, `understanding.goal`, `taskBreakdown[0].id`, `keyDecisions` (always `[]`), and `id` (truthy) are asserted.
- `generates a spec ID` — minimal input produces `result.id` matching `/^spec_\d+_[a-f0-9]+$/`.
- `retries on non-JSON output` — first response is `"not json"`; second is valid JSON; `result.topic === "t"` confirms the retry path succeeded.
- `throws on second non-JSON output` — both responses are non-JSON; `draftSpec` rejects with an error matching `/JSON/`.
- `includes explorer result in user message` — a custom `ModelClient` captures `request.messages[0].content`; the captured string contains `"src/main.ts:entry"` (from `explorerResult.entryPoints`) and `"convention: TDD"` (from `instructionsSummary`).
- `normalizes missing arrays to empty` — input has `understanding: { goal: "g" }` with no arrays; all four understanding sub-arrays coerce to `[]`.

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

`packages/agent-runtime/src/spec-drafter.ts` only imports from sibling modules inside `agent-runtime/src`:

- `import { randomBytes } from "node:crypto"` — already used by `audit-journal.ts`, `media.ts`, `steering.ts` in the same package; `node:crypto` is not on the `agent-runtime/src` forbidden-token list.
- `import type { ModelClient, ModelProfile, ModelRequest } from "./types.js"`
- `import type { ExplorerResult, SpecAcceptanceCriterion, SpecAffectedArea, SpecAmbiguity, SpecConstraint, SpecDraft, SpecTaskNode, SpecUnderstanding } from "./spec-types.js"`
- `import { parseJsonResponse } from "./spec-pipeline-helpers.js"`

No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `@focuscode/persistence`, `@focuscode/sdk`, `@focuscode/auth`, `@focuscode/ecosystem`, `@focuscode/sandbox`, `@focuscode/tui`, `/apps/`) are present. No external npm packages, no `node:fs`, no `node:child_process`, no `fetch(`.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-drafter.ts packages/agent-runtime/test/spec-drafter.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

A single `prettier --write` pass was needed on both files: the implementation needed the `normalizeDraft` guard condition and several normalizer ternaries wrapped to fit `printWidth: 100`; the test file needed the `reliability` block and the `taskBreakdown` array entry wrapped. After the rewrite, both files passed `--check` cleanly and tests continued to pass (the rewrite only changed whitespace/line-wrapping, not behavior).

## Self-review notes

### TDD RED step verified

Before writing the implementation, the RED step failed correctly and for the expected reason:

```
Error: Cannot find module '../src/spec-drafter.js' imported from
.../packages/agent-runtime/test/spec-drafter.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

After writing the implementation and rebuilding, the same command produced 6/6 passing — a true RED → GREEN transition.

### Implementation fidelity to plan

The implementation matches the plan's `spec-drafter.ts` behaviorally. The control flow is:

1. `buildUserMessage(params)` — assembles `User request: <prompt>`, a blank line, `Codebase context:`, the pretty-printed `explorerResult` JSON, and (if non-empty) `Project conventions (from AGENTS.md): <instructionsSummary>`.
2. `tryParse(client, profile, userMessage)` — builds a `ModelRequest` with `SYSTEM_PROMPT`, a single user message, empty `tools`, `profile.temperature`, and `profile.maxOutputTokens`; calls `client.complete`; runs `parseJsonResponse<Partial<SpecDraft>>` on `response.content`; returns `null` if parsing failed, otherwise `normalizeDraft(parsed)`.
3. If the first attempt returns `null`, retry with `{ ...profile, temperature: 0 }` and a user message appended with `\n\nIMPORTANT: Output must be valid JSON, no markdown fences.`.
4. If the retry also returns `null`, throw `Error("Drafter failed to produce valid JSON after retry")` — the message contains `"JSON"` so the test's `/JSON/` regex matches.
5. `normalizeDraft(raw)` validates `raw.topic` is a string and `raw.understanding` is a non-null object with a string `goal`; if not, returns `null` (treated as a parse failure for retry purposes). On success, returns a `SpecDraft` with `id: generateSpecId()`, `keyDecisions: []`, and all understanding/task arrays passed through their respective normalizers.
6. `normalizeArray<T>(raw, normalizer)` — returns `[]` if `raw` is not an array, otherwise maps each element through `normalizer` and filters out `null` results. This is what makes the "missing arrays" test pass.
7. Per-field normalizers (`normalizeConstraint`, `normalizeAcceptance`, `normalizeAffectedArea`, `normalizeAmbiguity`, `normalizeTask`) — each validates the required string fields and coerces enum-typed fields to a default if the model emitted an out-of-schema value. `verificationTarget` is conditionally spread to satisfy `exactOptionalPropertyTypes`.
8. `generateSpecId()` — `spec_<Math.floor(Date.now()/1000)>_<randomBytes(3).toString("hex")>`; 3 bytes → 6 hex chars, matching `/^spec_\d+_[a-f0-9]+$/`.

### Type correctness verification

The implementation compiles cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true` — indexed access on `raw.understanding` is guarded by a `null` check and a `typeof` check before being cast; `result.taskBreakdown[0]!.id` in the test uses non-null assertion after `toHaveLength(1)`.
- `exactOptionalPropertyTypes: true` — `verificationTarget` on `SpecAcceptanceCriterion` is conditionally spread with `...(typeof obj.verificationTarget === "string" ? { verificationTarget: obj.verificationTarget } : {})`, which correctly omits the property when absent. `keyDecisions: []` is always present (not optional on `SpecDraft`).
- `verbatimModuleSyntax: true` — all type-only imports use `import type`; the only runtime imports are `randomBytes` (from `node:crypto`) and `parseJsonResponse` (from `./spec-pipeline-helpers.js`).
- `isolatedModules: true`

### Deviation 1: Test file typing for the custom-client test

The plan's test 5 (`includes explorer result in user message`) used an untyped object literal for the client with a narrow `complete` parameter type `{ messages: { content: string }[] }` and no explicit return type annotation. Under `strict` + `strictFunctionTypes`, the inferred return type would widen `"stop"` to `string` (not assignable to `ModelStopReason`) and the narrow parameter type would not match `ModelRequest`. I adjusted the test to explicitly type the client as `ModelClient` and annotate the `complete` method as `async complete(request: ModelRequest): Promise<ModelResponse>`, mirroring the pattern used in `spec-explorer.test.ts`. The assertions and behavior are unchanged; only the type annotations were added so the test compiles.

### Deviation 2: Test import cleanup

The plan's test imported `ModelProfile` from both `../src/spec-types.js` (as `ModelProfile`) and `../src/types.js` (as `MP`), but `spec-types.ts` does not re-export `ModelProfile` — it only imports it from `./types.js` for internal use. Under `verbatimModuleSyntax`, importing a non-exported type would fail. I consolidated the imports to `import type { ModelClient, ModelProfile, ModelRequest, ModelResponse } from "../src/types.js"` and `import type { ExplorerResult } from "../src/spec-types.js"`, and used `ModelProfile` (not `MP`) as the type name throughout. No behavior change.

### Deviation 3: Prettier reformatting on both files

Both the implementation and test files needed a `prettier --write` pass to fit `printWidth: 100`. The implementation had the `normalizeDraft` guard condition and several normalizer ternaries that exceeded 100 columns when written as the plan's single-line forms. The test had the `reliability` block and the `taskBreakdown` array entry that exceeded 100 columns. The reformatting only changed whitespace/line-wrapping.

### Deviation 4: Plan's commit step skipped

The task constraints say "NEVER commit changes unless explicitly instructed." The plan's Step 5 included a `git commit`, which I did not run. The parent agent / user can commit if desired.

### No other deviations

The implementation is otherwise behaviorally identical to the plan's `spec-drafter.ts`. The test file is behaviorally identical to the plan's `spec-drafter.test.ts` modulo the typing/import fixes and Prettier reformatting described above.

## Concerns

1. **No abort signal support.** Unlike `classifyIntent` (Task 3) and `exploreCodebase` (Task 4), `draftSpec` does not accept an `AbortSignal`. The drafter can make up to 2 model calls (first attempt + retry), and there is no way to cancel mid-flight. The pipeline orchestrator should enforce an overall stage deadline if needed. The plan does not include a signal parameter for Task 5, so this matches the plan; a future task may need to thread the signal through.

2. **`keyDecisions` is always `[]`.** The drafter does not populate `keyDecisions` — that is the responsibility of the decision-detector stage (a later task). The `SpecDraft` type requires the field, so `normalizeDraft` hardcodes `keyDecisions: []`. This is correct per the plan but means a downstream consumer cannot rely on `keyDecisions` being non-empty from the drafter alone.

3. **`id` is generated client-side, not by the model.** `generateSpecId()` uses `Date.now()` and `randomBytes(3)`. The 3-byte random component gives 16.7M possibilities per second, which is sufficient for single-process spec generation but would collide under high-concurrency multi-process generation. For the SpecEngine's single-session-per-process model this is acceptable. If the engine ever becomes multi-process, the random component should be widened.

4. **Retry uses `temperature: 0` but does not change `maxOutputTokens`.** A model that ran out of output tokens on the first attempt (producing truncated JSON) would likely fail again on retry with the same token budget. The plan does not call for increasing `maxOutputTokens` on retry, so this matches the plan. A future enhancement could detect `stopReason === "length"` and bump the token budget.

5. **Normalizers silently drop invalid items.** `normalizeArray` filters out any item for which the normalizer returns `null`. If the model emits a structurally invalid constraint (e.g. `{ source: "codebase", severity: "hard" }` with no `description`), it is silently dropped rather than surfaced. This is intentional fail-safe behavior per the plan, but it means a malformed model response could produce a spec with fewer constraints/tasks than intended without any warning. The pipeline trace (a later task) should capture token usage and fallback signals so the orchestrator can detect degraded drafts.

6. **No streaming.** The drafter uses `client.complete()` (non-streaming). This is appropriate for a structured-JSON generation stage, but it means long model responses are not visible until the call completes. Not in scope for Task 5.
