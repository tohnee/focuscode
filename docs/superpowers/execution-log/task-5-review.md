# Task 5 Review: SpecEngine Drafter Stage

**Reviewer:** GLM-5.2 sub-agent
**Reviewed:** `packages/agent-runtime/src/spec-drafter.ts`, `packages/agent-runtime/test/spec-drafter.test.ts`
**Plan ref:** `docs/superpowers/plans/2026-07-23-spec-engine.md` lines 1336-1711
**Date:** 2026-07-23

## Verification commands run

- `node scripts/check-boundaries.mjs` → **PASS** ("Architecture boundary check passed.")
- `npx prettier --check packages/agent-runtime/src/spec-drafter.ts packages/agent-runtime/test/spec-drafter.test.ts` → **PASS** ("All matched files use Prettier code style!")
- `pnpm --filter @focuscode/agent-runtime build` → **PASS** (tsc clean, exit 0)
- `npx vitest run packages/agent-runtime/test/spec-drafter.test.ts` → **PASS** (6/6 tests, 159ms)

## Spec Compliance

### 1. draftSpec uses 3B-7B model, returns SpecDraft with goal/scope/keyDecisions/openQuestions/files? — COMPLIANT (with caveat)

`draftSpec(client, profile, params)` accepts a caller-supplied `ModelProfile`; the drafter itself does not enforce a 3B-7B class — that selection lives in `SpecPipeline.drafter.profile` (the pipeline config), which is the correct separation per the plan. Returns `SpecDraft` whose shape covers the semantic intent:

- `goal` → `understanding.goal` ✓
- `scope` → `understanding.affectedAreas` (no literal `scope` field on `SpecDraft`; `affectedAreas` is the scope proxy) ✓
- `keyDecisions` → `keyDecisions: []` (always empty; populated by the later decision-detector stage) ✓
- `openQuestions` → `understanding.ambiguities` (no literal `openQuestions` field; `ambiguities` is the proxy) ✓
- `files` → `taskBreakdown[].files` and `affectedAreas[].path` ✓

The literal `SpecDraft` type (`spec-types.ts` lines 133-139) has no `scope`/`openQuestions` fields, so the checklist wording is a loose mapping. The implementation matches the type contract exactly.

### 2. Uses parseJsonResponse for JSON extraction? — COMPLIANT

`spec-drafter.ts:102` calls `parseJsonResponse<Partial<SpecDraft>>(response.content)` from `./spec-pipeline-helpers.js`. Returns `null` on parse failure (caller retries).

### 3. JSON normalization validates and coerces fields? — COMPLIANT

`normalizeDraft` validates `raw.topic` (string) and `raw.understanding` (non-null object with string `goal`); returns `null` otherwise. Per-field normalizers (`normalizeConstraint`, `normalizeAcceptance`, `normalizeAffectedArea`, `normalizeAmbiguity`, `normalizeTask`) validate required string fields and coerce out-of-schema enum values to safe defaults (`source`→`"codebase"`, `severity`→`"soft"`, `verification`→`"manual"`, `impact`→`"review"`, `resolvedBy`→`"auto"`, `kind`→`"implement"`). `normalizeArray` drops items whose normalizer returns `null`. `verificationTarget` is conditionally spread to satisfy `exactOptionalPropertyTypes`.

### 4. Fail-safe: returns minimal SpecDraft on error? — NOT MET (deviates from checklist, matches plan)

**Finding.** On double parse/validation failure, `draftSpec` **throws** `Error("Drafter failed to produce valid JSON after retry")` (line 72). It does **not** return a minimal fallback `SpecDraft`. This is faithful to the plan (the plan's Step 3 implementation also throws), but does not satisfy the checklist's "returns minimal SpecDraft on error" expectation.

The fail-safe behavior that IS present is at the field level: partial JSON with missing arrays or invalid enum values is coerced to a valid `SpecDraft` rather than throwing. But the top-level error path (both attempts produce non-JSON or structurally invalid output) throws, so a pipeline-level fallback (e.g. `SpecStageModel.fallback: "skip"`) must handle drafter failures. This is a design choice, not a bug, but worth flagging because the checklist expected a minimal-SpecDraft return.

### 5. Retry on parse failure? — COMPLIANT

Lines 63-70: first attempt via `tryParse`; on `null`, retry once with `retryProfile: ModelProfile = { ...profile, temperature: 0 }` and a user message appended with `"\n\nIMPORTANT: Output must be valid JSON, no markdown fences."`. If the retry also returns `null`, throw. The retry profile is explicitly typed `ModelProfile` (good — `temperature` is a required `number` on `ModelProfile`, and `0` is assignable under `exactOptionalPropertyTypes`).

## Code Quality

### 1. strict / exactOptionalPropertyTypes / verbatimModuleSyntax — COMPLIANT

Build passes clean under `tsc -p tsconfig.json` (which inherits `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` from `tsconfig.base.json`).

- `exactOptionalPropertyTypes`: `verificationTarget` conditionally spread (lines 160-162); `keyDecisions: []` always present (required field).
- `verbatimModuleSyntax`: all type-only imports use `import type` (lines 2-12); only runtime imports are `randomBytes` and `parseJsonResponse`.
- `noUncheckedIndexedAccess`: indexed access on `raw.understanding` is guarded by `typeof`/`null` checks before the `as Partial<SpecUnderstanding>` cast (lines 108-116).

### 2. No external imports, no node:fs/child_process/fetch — COMPLIANT

Imports: `node:crypto` (`randomBytes`), `./types.js`, `./spec-types.js`, `./spec-pipeline-helpers.js`. `node:crypto` is already used by 3 siblings (`audit-journal.ts`, `media.ts`, `steering.ts`) and is not on the `agent-runtime/src` forbidden-token list. Boundary check passes. No `node:fs`, no `node:child_process`, no `fetch(`, no `@focuscode/*` cross-package deps.

### 3. .js import extensions, import type for type-only — COMPLIANT

All four import statements use `.js` extensions. Type-only imports use `import type`. The single value import (`parseJsonResponse`) is correctly a runtime import.

### 4. Prettier formatting — COMPLIANT

`prettier --check` passes on both files.

## Test Quality

### 1. Coverage of required scenarios

| Required scenario          | Test                                 | Status                                                                                                     |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Normal draft               | `parses valid spec draft JSON`       | ✓                                                                                                          |
| JSON parse failure + retry | `retries on non-JSON output`         | ✓                                                                                                          |
| Error fallback             | `throws on second non-JSON output`   | ⚠ tests the throw path, not a minimal-SpecDraft fallback (consistent with impl, but not a "fallback" test) |
| Normalization              | `normalizes missing arrays to empty` | ✓                                                                                                          |

Plus two extra tests: `generates a spec ID` (id format `/^spec_\d+_[a-f0-9]+$/`), `includes explorer result in user message` (captures user-message content and asserts `src/main.ts:entry` and `convention: TDD` are present).

### 2. Tests assert meaningful behavior — YES

Assertions check `topic`, `understanding.goal`, `taskBreakdown[0].id`, `keyDecisions` (`[]`), `id` truthiness/format, all four understanding sub-arrays coerced to `[]`, and captured user-message content. The throw test uses `rejects.toThrow(/JSON/)`.

### Coverage gaps (minor, non-blocking)

- **Normalizer coercion of invalid enum values** (e.g. `severity: "bogus"` → `"soft"`, `kind: "wat"` → `"implement"`) is not directly tested. The "normalizes missing arrays" test only covers absent arrays, not invalid enum coercion.
- **`verificationTarget` conditional spread** (present vs absent) is not asserted.
- **Invalid items silently dropped** by `normalizeArray` (e.g. a constraint missing `description`) is not tested.
- **`normalizeDraft` returning `null` for missing `topic`/`goal`** (which triggers the retry path) is not directly tested — the retry test covers non-JSON parse failure, not structural-validation failure. A test where the first response is valid JSON but missing `topic` (so `normalizeDraft` returns `null`) and the second is valid would close this gap.
- **Retry uses `temperature: 0`** is not asserted — the retry test only checks the result succeeds, not that the retry request carried `temperature: 0`.

These are refinements; the core happy/sad paths are covered.

## Overall Verdict

**PASS WITH MINOR FINDINGS.**

The implementation is faithful to the plan, compiles clean under the repo's strict TypeScript configuration, passes the architecture boundary check, passes Prettier, and all 6 tests pass. The code is well-structured with single-responsibility normalizers and correct `exactOptionalPropertyTypes` handling.

The one notable discrepancy is **checklist item 4 (fail-safe minimal SpecDraft on error)**: the drafter throws on double-failure rather than returning a minimal fallback `SpecDraft`. This matches the plan's design (the plan throws too) but does not satisfy the checklist's "returns minimal SpecDraft on error" wording. The pipeline orchestrator must handle drafter-stage failures via its own fallback mechanism (`SpecStageModel.fallback`). This is a design observation, not a defect — flagging it so the orchestrator (later task) knows `draftSpec` can throw.

Test coverage is adequate for the core behaviors; the minor gaps above (enum coercion, structural-validation retry trigger, `temperature: 0` assertion) are non-blocking refinements that could be added if the team wants tighter regression protection on the normalizers.

## Findings summary

1. **[Spec Compliance, minor]** `draftSpec` throws on double-failure instead of returning a minimal `SpecDraft` — matches plan, deviates from checklist item 4. Orchestrator must catch.
2. **[Test Quality, minor]** No direct test for enum-coercion normalizers, `verificationTarget` spread, or `normalizeArray` null-dropping.
3. **[Test Quality, minor]** Retry path triggered only by non-JSON, not by structurally-invalid JSON (missing `topic`/`goal`); `temperature: 0` on retry not asserted.
4. **[Code Quality, none]** `node:crypto` use is consistent with 3 sibling modules and permitted by boundary rules.
5. **[Report fidelity, none]** The task-5-report's claims (boundary pass, prettier pass, 6/6 tests, type correctness) were independently reproduced and confirmed accurate.
