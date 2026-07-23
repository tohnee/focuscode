# SpecEngine Implementation Execution Log

> **Date:** 2026-07-23
> **Plan:** `docs/superpowers/plans/2026-07-23-spec-engine.md`
> **Spec:** `docs/superpowers/specs/2026-07-23-spec-engine-design.md`
> **Mode:** Subagent-Driven Development + TDD
> **Project:** FocusCode 0.4.0-beta.2

## Execution Summary

| Task                              | Status  | Implementer  | Reviewer       | Notes                                                                                                                                  |
| --------------------------------- | ------- | ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1: spec-types.ts             | ✅ DONE | subagent     | reviewer+fix   | 8/8 tests, eventSink type fixed                                                                                                        |
| Task 2: spec-pipeline-helpers.ts  | ✅ DONE | subagent     | reviewer       | 10/10 tests, APPROVED (6 Minor)                                                                                                        |
| Task 3: spec-classifier.ts        | ✅ DONE | subagent     | reviewer       | 7/7 tests, APPROVED (1M, 4L)                                                                                                           |
| Task 4: spec-explorer.ts          | ✅ DONE | subagent     | reviewer       | 6/6 tests, APPROVED (all Low/Info)                                                                                                     |
| Task 5: spec-drafter.ts           | ✅ DONE | subagent     | reviewer       | 6/6 tests, PASS WITH MINOR                                                                                                             |
| Task 6: spec-decision-detector.ts | ✅ DONE | subagent     | reviewer       | 8/8 tests, APPROVED                                                                                                                    |
| Task 7: spec-enhancer.ts          | ✅ DONE | subagent     | reviewer       | 6/6 tests, PASS WITH MINOR (missing error-propagation & format-coupling tests; Low: `## Confirmed Decisions` divergence)               |
| Task 8: spec-store.ts             | ✅ DONE | subagent     | reviewer+fix   | 10/10 tests, PASS WITH MINOR → fixed Important (updateStatus lossy) + Minor (updatedAt)                                                |
| Task 9: spec-engine.ts            | ✅ DONE | subagent     | reviewer       | 16/16 tests, PASS WITH MINOR (Important: mixed-severity latent bug plan-faithful; Minor: needsClarification scope, mid-pipeline abort) |
| Task 10: types.ts (AgentEvent)    | ✅ DONE | subagent     | reviewer       | 8/8 tests, APPROVED (2 Info)                                                                                                           |
| Task 11: agent.ts (submit)        | ✅ DONE | subagent     | reviewer       | 6/6 tests, APPROVED (1 Minor, 3 Info) — 3 plan deviations fixed (SessionStore name, activeBranch type, exactOptionalPropertyTypes)     |
| Task 12: index.ts (exports)       | ✅ DONE | subagent     | reviewer       | 4/4 tests, APPROVED (2 Info) — no export conflicts                                                                                     |
| Final Review                      | ✅ DONE | fix subagent | final reviewer | APPROVED WITH CONDITIONS → 2 fixes applied (I-1 mixed-severity bug, I-3 missing spec_* events); I-2 false positive                     |
| Fix Wave                          | ✅ DONE | fix subagent | -              | +6 tests (22 in spec-engine.test.ts); full suite 421 passed, 10 skipped, 0 failed                                                      |

## Final Test Counts (post-fix)

- **SpecEngine tests (12 test files):** 101 tests total (8+10+7+6+6+8+6+10+22+8+6+4)
- **Full agent-runtime suite:** 421 passed, 10 skipped (pre-existing live-providers), 0 failed
- **Total test files:** 50 passed, 1 skipped

## Final Review Outcome

**Verdict:** APPROVED (after fixes)

**Must-fix items resolved:**

1. I-1 (mixed-severity decision bug) — FIXED: minor auto-choice now preserved in confirmedDecisions rebuild (spec-engine.ts:217-222)
2. I-3 (3 missing spec_* events) — FIXED: spec_stage, spec_draft_ready, spec_skipped now emitted on all appropriate paths
3. I-2 (updateStatus data loss) — FALSE POSITIVE: updateStatus already uses in-place frontmatter editing (Task 8 fix was correctly applied)

**Deferred Minor findings (16 items):** Non-blocking, can be addressed in follow-up PRs.

## Task Execution Records

### Task 1: spec-types.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent + fix subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-types.ts` (type definitions for the SpecEngine pipeline — interfaces, types, discriminated unions; no runtime code)
- Created: `packages/agent-runtime/test/spec-types.test.ts` (8 vitest tests exercising the type contracts)

**TDD Process:**

- RED: Test passed even without the source file existing — type-only module where `import type` is erased at runtime by esbuild/rollup; `vitest.config.ts` does not enable `typecheck.enabled`, and `packages/agent-runtime/tsconfig.json` only includes `src/**/*.ts` (test files not compiled by tsc). Meaningful validation comes from `tsc` compiling the source file.
- GREEN: `pnpm build` succeeded (exit 0); all 8 tests pass at runtime; source compiles cleanly under strict mode.

**Test Results:** 8/8 passed (~120ms)
**Boundary Check:** PASS (`node scripts/check-boundaries.mjs` — "Architecture boundary check passed.")
**Format Check:** PASS (initial `prettier --write` required on `spec-types.ts`)

**Review Verdict:** NEEDS FIXES → FIXED → APPROVED
**Findings:**

- Important: `SpecClarifyInput.eventSink` used `unknown` instead of `AgentEvent` (spec deviation) — FIXED (added `AgentEvent` to import from `./types.js`, tightened parameter type; field remains optional `eventSink?`)
- Minor: Test type annotations not validated by tsc (toolchain limitation; `import type` erased at runtime)
- Minor: No direct tests for `SpecStore`, `SpecEngineDeps`, `SpecPipeline`, `SpecPipelineTrace` (forward references for later tasks)

**Deviations from plan:**

- `AgentToolRegistry` imported from `./tools.js` instead of `./types.js` (plan error fixed — `AgentToolRegistry` is a class exported from `./tools.ts`, not `./types.ts`; without the fix `tsc` would error)

**Report:** `task-1-report.md`
**Review:** `task-1-review.md`

---

### Task 2: spec-pipeline-helpers.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-pipeline-helpers.ts` (runtime helpers: `parseJsonResponse`, `emptyExplorerResult`, `fallbackEnhance`, plus test utilities `mockClient` and `mockClientSequence`)
- Created: `packages/agent-runtime/test/spec-pipeline-helpers.test.ts` (10 vitest tests covering all five exported helpers)

**TDD Process:**

- RED: `Error: Cannot find module '../src/spec-pipeline-helpers.js'` — true RED because test imports runtime values (not just types).
- GREEN: 10/10 tests pass after writing implementation; true RED → GREEN transition.

**Test Results:** 10/10 passed (~120ms)
**Boundary Check:** PASS
**Format Check:** PASS (initial `prettier --write` required on both files to wrap long lines to `printWidth: 100`)

**Review Verdict:** APPROVED
**Findings (all Minor, deferred):**

- Minor: `mockClientSequence([])` produces `content: undefined` at runtime — no empty-input guard (`responses[-1]!` only silences TS)
- Minor: `parseJsonResponse` regex anchored at `^`````, won't extract JSON embedded in prose (matches plan)
- Minor: No test for `mockClientSequence` empty-array edge case
- Minor: `fallbackEnhance` "Confirmed Decisions" branch (`if (d.chosen)`) untested — test passes `[]` for decisions
- Minor: `fallbackEnhance` "## Files" section content not asserted
- Minor: `mockClient` test doesn't assert `usage` shape

**Deviations from plan:**

- Removed unused `ModelRequest` import (cleanup; strict subset of plan's imports, no behavior change)

**Report:** `task-2-report.md`
**Review:** `task-2-review.md`

---

### Task 3: spec-classifier.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-classifier.ts` (`classifyIntent()` and `ClassifyResult` interface; intent classification with JSON retry and abort-signal support)
- Created: `packages/agent-runtime/test/spec-classifier.test.ts` (7 vitest tests: happy path, JSON retry, second-failure throw, input truncation, abort signal, project-type inclusion)

**TDD Process:**

- RED: `Error: Cannot find module '../src/spec-classifier.js'` — true RED (runtime value import).
- GREEN: 7/7 tests pass after implementation.

**Test Results:** 7/7 passed (~148ms)
**Boundary Check:** PASS
**Format Check:** PASS (no `prettier --write` needed; both files formatted correctly on first write)

**Review Verdict:** APPROVED (1 Medium, 4 Low)
**Findings:**

- Medium (process): Review checklist referenced non-existent types (`SpecClassification`, `action: "skip"`, `understanding` fields) — checklist derived from plan's dependency/coverage tables, not the actual Task 3 spec. The fail-safe `action: "skip"` is a Task 9 (orchestrator) concern; Task 3 classifier correctly throws on error.
- Low (report accuracy): Report claimed unused `_temperature` parameter was "retained" — implementation actually removed it (clean-up improvement over plan; report text stale)
- Low (test gap): Retry test name says "with temperature=0" but does not capture/assert that the second `ModelRequest.temperature` was `0`
- Low (test gap): No test for the shape-validation failure path (valid JSON, wrong field types)
- Low (robustness): Signal not re-checked between retry attempts (acceptable; signal forwarded to `ModelRequest`)

**Deviations from plan:**

- Abort-signal pre-check added at top of `classifyIntent` (required by plan's own test `"respects abort signal"` — `mockClient` ignores request argument including signal; semantically correct fail-fast)
- Test type annotation fixed: `typeof mockClient extends infer F ? F : never` → `ReturnType<typeof mockClient>` (plan's annotation resolved to callable function type; object literal not assignable under `strict`)
- Unused `_temperature` parameter removed from `tryParse` (improvement over plan)

**Report:** `task-3-report.md`
**Review:** `task-3-review.md`

---

### Task 4: spec-explorer.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-explorer.ts` (`exploreCodebase()` and `ExploreCodebaseParams` interface; read-only tool loop driving the MAIN model through read/grep/glob/ls style tools, parsing final `ExplorerResult` JSON summary)
- Created: `packages/agent-runtime/test/spec-explorer.test.ts` (6 vitest tests: happy path, maxRounds limit, pre-aborted signal, non-JSON model output, throwing tool, empty tool list)

**TDD Process:**

- RED: `Error: Cannot find module '../src/spec-explorer.js'` — true RED.
- GREEN: 6/6 tests pass after implementation.

**Test Results:** 6/6 passed (~145ms)
**Boundary Check:** PASS
**Format Check:** PASS (single `prettier --write` pass on test file to wrap long object literals)

**Review Verdict:** APPROVED (all Low/Info)
**Findings:**

- Low: Abort signal not propagated to `tool.execute()` — slow read-only tools can't be interrupted mid-execution (matches plan verbatim)
- Low: `stopReason` branching imprecise but fail-safe (`"length"`/`"aborted"`/`"error"` fall into parse-JSON branch; `parseJsonResponse` returns `null` → fallback)
- Info: System prompt mentions "glob" while checklist mentions "find" — instructional text only, no behavioral impact
- Low: No test for multi-tool-call round (every test's `toolCalls` array has exactly one element)
- Positive: `normalizeExplorerResult` is robust (defensive coercion prevents runtime errors on malformed model output)

**Deviations from plan:**

- Removed unused `AgentToolCall` import (positive deviation — dead import removal keeps `verbatimModuleSyntax`/`isolatedModules` clean)
- Prettier reformatting on test file (whitespace/line-wrapping only)

**Report:** `task-4-report.md`
**Review:** `task-4-review.md`

---

### Task 5: spec-drafter.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-drafter.ts` (`draftSpec()` and `DraftSpecParams` interface; calls 3B-7B class model with system prompt + user message built from explorer result + instructions summary, parses JSON response into `SpecDraft`, retries once at `temperature: 0` on parse failure, throws if retry fails. Includes field-level normalizers and `generateSpecId()` helper via `node:crypto.randomBytes`)
- Created: `packages/agent-runtime/test/spec-drafter.test.ts` (6 vitest tests: happy-path JSON parsing, spec ID format, retry on non-JSON, throw on second non-JSON, explorer-result/instructions inclusion, missing-array normalization)

**TDD Process:**

- RED: `Error: Cannot find module '../src/spec-drafter.js'` — true RED.
- GREEN: 6/6 tests pass after implementation.

**Test Results:** 6/6 passed (~145ms)
**Boundary Check:** PASS (`node:crypto` used by 3 sibling modules, not on forbidden-token list)
**Format Check:** PASS (single `prettier --write` pass on both files)

**Review Verdict:** PASS WITH MINOR
**Findings:**

- Spec compliance (minor): `draftSpec` throws on double-failure instead of returning a minimal `SpecDraft` — matches plan (plan throws too), deviates from checklist item 4 "returns minimal SpecDraft on error". Orchestrator must catch.
- Test quality (minor): No direct test for enum-coercion normalizers, `verificationTarget` conditional spread, or `normalizeArray` null-dropping
- Test quality (minor): Retry path triggered only by non-JSON, not by structurally-invalid JSON (missing `topic`/`goal`); `temperature: 0` on retry not asserted
- Code quality (none): `node:crypto` use consistent with 3 sibling modules and permitted by boundary rules
- Report fidelity (none): Task-5-report claims (boundary pass, prettier pass, 6/6 tests, type correctness) independently reproduced and confirmed accurate

**Deviations from plan:**

- Test file typing for custom-client test fixed (explicit `ModelClient` type + `async complete(request: ModelRequest): Promise<ModelResponse>` annotation; plan's untyped literal wouldn't compile under `strict` + `strictFunctionTypes`)
- Test import cleanup (`ModelProfile` from `types.js` not `spec-types.js` — `spec-types.ts` doesn't re-export it)
- Prettier reformatting on both files

**Report:** `task-5-report.md`
**Review:** `task-5-review.md`

---

### Task 6: spec-decision-detector.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-decision-detector.ts` (`detectDecisions()` exported function; calls 1B-2B class model with system prompt + user message built from `KeyDecisionRule[]` + pretty-printed `SpecDraft` JSON, parses response as JSON array via `parseJsonResponse`, normalizes entries into `SpecKeyDecision`, retries once at `temperature: 0` on parse failure, throws if retry fails. Includes `normalizeDecision` and `normalizeOption` helpers)
- Created: `packages/agent-runtime/test/spec-decision-detector.test.ts` (8 vitest tests: empty-array happy path, decision parsing with severity, retry on non-JSON, throw on second non-JSON, malformed-decision filtering, rule inclusion in user message, unknown-severity normalization, missing-options default)

**TDD Process:**

- RED: `Error: Cannot find module '../src/spec-decision-detector.js'` — true RED.
- GREEN: 8/8 tests pass after implementation.

**Test Results:** 8/8 passed (~150ms)
**Boundary Check:** PASS
**Format Check:** PASS (implementation file passed `--check` first try; test file needed one `prettier --write` pass)

**Review Verdict:** APPROVED
**Findings (all non-blocking informational):**

- F1: Deviation — malformed-options handling (distinguishes missing `options` → `[]` keep, from present-but-non-array `options` → reject). Makes both plan tests coherent; more conservative fail-safe parser.
- F2: Fail-safe semantics — throws on second parse failure, not returns `[]` (delegation summary said "returns []" but plan's code/tests explicitly throw; plan/tests authoritative; orchestrator wraps in try/catch)
- F3: No `AbortSignal` (consistency gap with Tasks 3/4; plan-compliant; orchestrator should enforce stage deadline)
- F4: Retry doesn't bump `maxOutputTokens` (plan-compliant; future enhancement only)
- F5: Normalizers silently drop invalid items (intentional fail-safe per plan)

**Deviations from plan:**

- Malformed-options handling changed: missing `options` → `[]` (keep), present-but-non-array `options` → reject (plan's literal code defaulted both to `[]`, contradicting plan's own `filters out malformed decisions` test)
- Test file typing for custom-client test fixed (explicit `ModelClient` type)
- Prettier reformatting on test file

**Report:** `task-6-report.md`
**Review:** `task-6-review.md`

---

### Task 7: spec-enhancer.ts

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-enhancer.ts` (`enhancePrompt()` and `EnhancePromptParams` interface; transforms confirmed `SpecDraft` + `SpecKeyDecision[]` into executable text prompt for the coding agent. Returns model's raw text content trimmed — no `parseJsonResponse`, no retry, no normalization)
- Created: `packages/agent-runtime/test/spec-enhancer.test.ts` (6 vitest tests: text output passthrough, decision embedding, empty decisions, raw content, whitespace trimming, draft JSON inclusion)

**TDD Process:**

- RED: `Error: Cannot find module '../src/spec-enhancer.js'` — true RED (runtime value import).
- GREEN: 6/6 tests pass after implementation.

**Test Results:** 6/6 passed (~147ms)
**Boundary Check:** PASS
**Format Check:** PASS (initial `prettier --write` required on both files)

**Review Verdict:** PASS WITH MINOR
**Findings:**

- Minor: Missing error propagation test (requirement 5 makes "may throw on error — orchestrator catches" contractual, but no test asserts rejecting `client.complete()` causes `enhancePrompt` to reject)
- Minor: Missing format coupling test with `fallbackEnhance` (requirement 6 requires output format alignment, but no test asserts the coupling)
- Low: `## Confirmed Decisions` section divergence — `fallbackEnhance` emits it when `decisions.length > 0`; enhancer's `SYSTEM_PROMPT` does not instruct model to produce it. Both paths functional but latent format asymmetry.
- Info: Review task signature vs plan signature discrepancy (review task's `(client, profile, draft, decisions, confirmations, signal?)` doesn't match plan's `(client, profile, params: { draft, confirmedDecisions })`; implementation correctly follows plan)
- Info: `signal` (AbortSignal) not threaded through (plan-compliant; out of scope for Task 7)

**Deviations from plan:**

- None significant — implementation matches plan's `spec-enhancer.ts` verbatim. Prettier reformatting only.
- `fallbackEnhance` fallback is orchestrated at pipeline level (Task 9), not inside `enhancePrompt` (per plan's dependency table)

**Report:** `task-7-report.md`
**Review:** `task-7-review.md`

---

### Task 8: spec-store.ts

**Implementer:** subagent (TDD) + fix subagent
**Reviewer:** subagent + fix subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-store.ts` (226 lines — `SpecStoreImpl` implementing `SpecStore` interface: `save`, `load`, `list`, `updateStatus` with frontmatter serialization/parsing)
- Created: `packages/agent-runtime/test/spec-store.test.ts` (144 lines initially → extended with 2 new tests for the fix)

**TDD Process:**

- RED: `Cannot find module '../src/spec-store.js'` — FAIL.
- GREEN: 8 tests pass.
- Fix RED: 2 new tests failed (`updateStatus preserves spec body content` — body wiped by deserialize → serialize round-trip; `load returns correct updatedAt` — `deserialize` set `updatedAt: fm.createdAt`). Result: 2 failed | 8 passed (10).
- Fix GREEN: 10/10 tests pass after fix.

**Test Results:** 10/10 passed (after fix)
**Boundary Check:** PASS
**Format Check:** PASS (initial `prettier --write` on test file; no `--write` needed after fix)

**Review Verdict:** PASS WITH MINOR → fixed Important (updateStatus lossy) + Minor (updatedAt)
**Findings:**

- Important: `updateStatus` silently destroys spec body content — `deserialize` returns minimal doc with empty body fields; `updateStatus` round-trips through load → save, wiping `goal`, `enhancedPrompt`, `taskBreakdown`, `keyDecisions`, etc. (FIXED — `updateStatus` rewritten to do in-place frontmatter editing via new `replaceFrontmatterField` helper; body never touched)
- Minor: `parseFrontmatter` doesn't extract `updatedAt` — loaded docs have `updatedAt === createdAt` (FIXED — `parseFrontmatter` return type extended with `updatedAt`, falls back to `createdAt` for legacy files; `deserialize` updated)
- Minor: `resolveFilename` uses unbounded `while(true)` loop (acceptable for internal tool)
- Low: No slugification of topic in filename (spaces produce awkward filenames)
- Low: `list(0)` returns all specs instead of zero (falsy check on `limit`)
- Info: Type assertions on `status`/`trigger` lack runtime validation (acceptable for self-authored files)

**Deviations from plan:**

- Conflict-handling logic added (required by task brief): async `resolveFilename(doc, dir, existing)` replaces sync `buildFilename(doc)` — handles no-existing → base name, same-ID → overwrite, different-ID → `-N` suffix starting at N=2
- Type adaptation: used `SpecTrigger` type alias instead of plan's inline literal `"auto" | "explicit"`
- `deserialize` signature simplified: dropped unused `content: string` first parameter
- (Fix) `updateStatus` rewritten for in-place frontmatter editing; `parseFrontmatter` extended with `updatedAt`

**Report:** `task-8-report.md`
**Review:** `task-8-review.md`

---

### Task 9: spec-engine.ts

**Implementer:** subagent (TDD) + fix subagent
**Reviewer:** subagent + fix subagent
**Status:** ✅ DONE

**Files:**

- Created: `packages/agent-runtime/src/spec-engine.ts` (395 lines — `SpecEngine` class: `clarify()`, `resolveDecisions()`, `declineSpec()`, private helpers `runStage`, `runStageMain`, `fallbackToMain`, `waitForConfirmation`, `readOnlyTools`, `extractTodos`, `emit`)
- Created: `packages/agent-runtime/test/spec-engine.test.ts` (16 tests initially → 22 tests after fix wave)
- Modified: `packages/agent-runtime/src/types.ts` (added `import type { SpecKeyDecision } from "./spec-types.js"` then removed in Task 10; added 4 minimal `spec_*` variants: `spec_start`, `spec_confirmation_required`, `spec_confirmed`, `spec_completed` — cross-task dependency for Task 9 to compile)
- Modified: `packages/agent-runtime/src/spec-enhancer.ts` (added empty-content check that throws `Error("Enhancer returned empty content")` so `fallbackEnhance` gets triggered on model failure)

**TDD Process:**

- RED: `Cannot find module '../src/spec-engine.js'` — FAIL.
- GREEN: 16/16 tests pass (~275ms).
- Fix wave: +6 new tests added (22 total); all pass.

**Test Results:** 16/16 passed initially → 22/22 passed after fix wave
**Boundary Check:** PASS
**Format Check:** PASS (initial `prettier --write` on `spec-engine.ts` and `spec-engine.test.ts`)

**Review Verdict:** PASS WITH MINOR (Important: mixed-severity latent bug plan-faithful; Minor: needsClarification scope, mid-pipeline abort)
**Findings:**

- Important: Minor decision auto-choice lost when mixed with blocking decisions — when `blockingDecisions.length > 0`, `confirmedDecisions` rebuilt from `keyDecisions` using only `userChoices[d.id]`, discarding minor auto-choices set at line 178-181. Plan-level bug (plan code identical). No test covers mixed-severity case. (FIXED in fix wave — see Final Review)
- Minor: `needsClarification` variable scope wider than necessary (declared at function scope, only read within classifier block; cosmetic)
- Minor: `runStageMain` accepts but voids `client`/`profile` params (signature symmetry with `runStage`; actual call uses `input.modelClient`/`input.model` via closure)
- Minor: Mid-pipeline abort only takes effect at signal-checking points (drafter/detector/enhancer don't receive signal; acceptable for current design)
- Info: `process.cwd()` couples engine to process cwd at construction time (not a boundary violation; `cwd` available in `SpecClarifyInput.cwd`)
- Info: `waitForConfirmation` Promise hangs indefinitely without resolution (appropriate for interactive use; caller expected to always resolve or abort)

**Deviations from plan:**

- `AgentToolRegistry` import split (required fix — plan placed it in `./types.js` but it's exported from `./tools.js`)
- `spec-enhancer.ts` empty-content throw (required for fallback path — plan's design assumes enhancer throws on model error so `fallbackEnhance` gets called; original `enhancePrompt` returned empty string, breaking the "uses fallback enhance when enhancer fails" test)
- `catch` block cleanup (cosmetic — `catch (error)` with unused `error` simplified to `catch { ... }`)
- `types.ts` modification (cross-task dependency — plan says Task 10 owns `spec_*` variants but Task 9 cannot compile without them; added only 4 minimal variants needed)

**Report:** `task-9-report.md`
**Review:** `task-9-review.md`

---

### Task 10: types.ts (AgentEvent)

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Modified: `packages/agent-runtime/src/types.ts` (removed `import type { SpecKeyDecision } from "./spec-types.js"` — eliminated circular type dependency; changed `decisions: SpecKeyDecision[]` → `decisions: unknown[]` in both `spec_confirmation_required` and `spec_confirmed` variants; added 3 missing variants: `spec_stage`, `spec_draft_ready`, `spec_skipped`. Union now has all 7 `spec_*` variants per plan)
- Created: `packages/agent-runtime/test/spec-events.test.ts` (62 lines, 8 tests verbatim from plan)

**TDD Process:**

- RED: `tsc --noEmit` on test file produced 3 type errors for `spec_stage`, `spec_draft_ready`, `spec_skipped` (vitest uses esbuild, no type-checking, so 8 tests passed at runtime even in RED; true RED signal was the `tsc --noEmit` failure)
- GREEN: 8/8 tests pass; `tsc --noEmit` on test file exits 0 with no errors.

**Test Results:** 8/8 passed
**Boundary Check:** PASS (types.ts remains leaf-level module; sole `@focuscode/*` import `@focuscode/action-domain` was pre-existing)
**Format Check:** PASS (after `--write` on test file to fix long `spec_draft_ready` line)

**Review Verdict:** APPROVED (2 Info)
**Findings:**

- Info: RED phase verified via `tsc --noEmit` rather than `vitest run` (sound methodology note for type-only changes in this repo)
- Info: `spec_draft_ready` test literal's prettier-induced multi-line form is semantically identical to plan's single-line form

**Deviations from plan:**

- None in implementation — 9 export lines match plan verbatim.
- RED phase verified via `tsc --noEmit` (plan's "Expected: FAIL" for Step 2 satisfied by tsc type errors, not vitest runtime failure).
- No changes needed to `spec-engine.ts` — `SpecKeyDecision[]` → `unknown[]` widening is structurally compatible with existing emit call sites (array covariance).

**Report:** `task-10-report.md`
**Review:** `task-10-review.md`

---

### Task 11: agent.ts (submit)

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Modified: `packages/agent-runtime/src/agent.ts` (1051 total, added ~45 lines — import, `CodingAgentOptions` fields, private fields, `create()` validation + instantiation, `specEngineInstance` getter, `submit()` preprocessing block)
- Created: `packages/agent-runtime/test/spec-engine-integration.test.ts` (210 lines, 6 tests)

**TDD Process:**

- RED: 3 tests passed (baseline no-SpecEngine), 3 failed (tests requiring `specEngine` option, `specEngineInstance` getter, `specEngineDeps` validation).
- GREEN: 6/6 tests pass after implementation.
- Full suite regression: 411 passed, 10 skipped, 0 failed (was 405 + 10; +6 new tests).

**Test Results:** 6/6 passed
**Boundary Check:** PASS (only `node:fs` reference is inside a JSDoc comment, not an import)
**Format Check:** PASS (initial `prettier --write` on test file)

**Review Verdict:** APPROVED (1 Minor, 3 Info)
**Findings:**

- Minor: Test #3 `result.content === "done"` doesn't verify enhanced prompt was applied — `mockClient("done")` returns `"done"` regardless of input; spec_* event assertions carry the real verification weight
- Info: `priority` field on `SpecInitialTodo` intentionally dropped during `SpecInitialTodo` → `TodoItem` mapping (`TodoItem` has no `priority` field; data preserved in persisted `SpecDocument`)
- Info: Implementer's report lists 4 deviations, but #4 (expanded test coverage) is not a deviation — plan explicitly requested expanding the test file
- Info: `currentSpecId` is write-only in agent.ts after Task 11 (presumably consumed by Task 12 or external callers)

**Deviations from plan:**

- `SessionStore` class name fixed (plan referenced non-existent `InMemorySessionStore`; actual class is `SessionStore` constructed with `(directory, false)` for non-persistent mode)
- `activeBranch` return type fixed (plan passed `activeBranch(this.session)` directly, but it returns `SessionEntry[]` while `sessionBranch` expects `AgentMessage[]`; fixed with `.map((e) => e.message)`)
- `eventSink` `exactOptionalPropertyTypes` fix (plan passed `eventSink: this.eventSink` directly, but `this.eventSink` includes `undefined`; fixed with conditional spread `...(this.eventSink ? { eventSink: this.eventSink } : {})`)

**Report:** `task-11-report.md`
**Review:** `task-11-review.md`

---

### Task 12: index.ts (exports)

**Implementer:** subagent (TDD)
**Reviewer:** subagent
**Status:** ✅ DONE

**Files:**

- Modified: `packages/agent-runtime/src/index.ts` (appended 9 export lines after existing `export * from "./web-tools.js";`; 41 total lines, was 32)
- Created: `packages/agent-runtime/test/spec-exports.test.ts` (27 lines, 4 tests)

**TDD Process:**

- RED: All 4 tests failed (`AssertionError: expected undefined to be defined` / `expected 'undefined' to be 'function'`).
- GREEN: 4/4 tests pass after appending exports; build succeeded with no TypeScript errors — no export name conflicts.
- Full suite regression: 415 passed, 10 skipped, 0 failed (was 411 + 10; +4 new tests).

**Test Results:** 4/4 passed
**Boundary Check:** PASS (9 new export lines introduce no forbidden tokens)
**Format Check:** PASS (no `--write` needed)

**Review Verdict:** APPROVED (2 Info)
**Findings:**

- Info: `mockClient`/`mockClientSequence` leak into public API via `export *` (pre-existing condition from Task 2; Task 12 followed plan's `export *` instruction verbatim; consider named exports in future cleanup)
- Info: `SpecStoreImpl` test is slightly weaker than `SpecEngine` test (asserts only `toBeDefined()`, not `typeof === "function"`; matches plan exactly)

**Deviations from plan:**

- None in implementation — 9 export lines appended to `index.ts` exactly match plan lines 3750–3759.
- None in test — `spec-exports.test.ts` content exactly matches plan lines 3711–3738.
- Skipped plan Step 6 (git commit) — not a git repository; git commands must not be run.

**Report:** `task-12-report.md`
**Review:** `task-12-review.md`

---

### Final Review (Whole-Branch)

**Reviewer:** final review subagent (GLM-5.2, cross-cutting)
**Status:** ✅ APPROVED WITH CONDITIONS → conditions met

**Scope:** 12-task Subagent-Driven Development of SpecEngine (5-stage requirement clarification pipeline). All 12 tasks implemented + individually reviewed.

**Verification Commands Run:**

- `node scripts/check-boundaries.mjs` → PASS ("Architecture boundary check passed.")
- `pnpm build` → PASS (all packages compiled clean)
- `npx vitest run packages/agent-runtime/ --reporter=verbose` → PASS (415 passed, 10 skipped, 0 failed across 51 test files)

**Findings (0 Critical, 3 Important, 15 Minor, 5 Info):**

- I-1 (Important): Mixed-severity decision bug — `confirmedDecisions` rebuild at `spec-engine.ts:194-197` discards minor auto-choices when blocking decisions exist. Plan-faithful but real bug. No test covers mixed-severity case. — FIXED
- I-2 (Important): `updateStatus` data loss — `deserialize` returns minimal doc; `updateStatus` round-trips through load → save, wiping spec body. — FALSE POSITIVE (already fixed in Task 8 via in-place frontmatter editing with `replaceFrontmatterField`)
- I-3 (Important): 3 of 7 `spec_*` events never emitted (`spec_stage`, `spec_draft_ready`, `spec_skipped`). Plan did not include emission code; implementer followed plan. — FIXED
- 16 Minor findings deferred (M1–M16, all non-blocking — see "Deferred Minor findings" above)

**Cross-cutting strengths confirmed:**

- Architecture boundaries clean across all 9 new files (no `node:fs`/`node:child_process`/`fetch(`/cross-package deps)
- TypeScript strict mode compliance excellent (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` all correctly handled)
- Tool name correctness verified: spec-engine.ts uses `["read", "grep", "find", "ls"]` matching actual registry in `tools.ts:347` (design spec's "glob" is a doc error)
- `node:crypto` in spec-drafter.ts NOT a boundary violation (used by 3 sibling modules)
- All 9 new exports in `index.ts` conflict-free (40 unique export names across 9 files)
- `CodingAgent.submit()` integration additive — when `specEngine` undefined, original control flow unchanged

**Must-Fix Before Merge:**

1. I-1: Mixed-severity decision bug — fix rebuild to preserve minor auto-choices; add mixed-severity test.
2. I-2: `updateStatus` data loss — fix to preserve spec body (rewrite only frontmatter); add body-preservation test.

**Strongly recommended (not blocking):** 3. I-3: Emit `spec_skipped` on all skip paths at minimum; emit `spec_stage` and `spec_draft_ready` if possible.

**Fix Wave:**

- I-1 fix: minor auto-choice preserved in `confirmedDecisions` rebuild — `...(d.severity === "minor" && d.options.length > 0 ? { chosen: d.options[0]!.label } : {})` before the user-choice conditional (`spec-engine.ts:217-222`)
- I-3 fix: `spec_stage`, `spec_draft_ready`, `spec_skipped` now emitted on all appropriate paths
  - `spec_stage`: new private helper `emitSpecStage(input, name, trace)` called in `runStage()` (3 paths) and `clarify()` explorer try/catch (2 paths) — exactly one event per stage execution
  - `spec_draft_ready`: emitted immediately after drafter try-catch block (only on success)
  - `spec_skipped`: emitted before every `return { action: "skip" }` in `clarify()` (6 skip paths: `/raw`, empty `/spec`, classifier no-clarify, classifier skip-fallback, classifier strict/primary failure, drafter failure)
- I-2: confirmed FALSE POSITIVE — Task 8 fix (in-place frontmatter editing) was correctly applied; `updateStatus` already uses `replaceFrontmatterField`, body never touched
- +6 new tests added to `spec-engine.test.ts` (22 total):
  1. `preserves minor decision auto-choice when blocking decisions exist (I-1)`
  2. `emits spec_stage events for each pipeline stage (I-3a)`
  3. `emits spec_draft_ready event after drafter stage (I-3b)`
  4. `emits spec_skipped event when prompt starts with /raw (I-3c)`
  5. `emits spec_skipped event when classifier says no clarification needed (I-3c)`
  6. `emits spec_skipped event when drafter fails (I-3c)`
- Full suite after fix wave: **421 passed, 10 skipped, 0 failed** (was 415 + 10; +6 new tests; 50 test files passed, 1 skipped)
- Boundary check: PASS
- Prettier check: PASS

**Files Modified in Fix Wave:**

- `packages/agent-runtime/src/spec-engine.ts` — I-1 fix (1 hunk), I-3a fix (`emitSpecStage` helper + 5 call sites), I-3b fix (1 emit), I-3c fix (6 skip-path emits)
- `packages/agent-runtime/test/spec-engine.test.ts` — added `AgentEvent` import and 6 new tests

**Final Review:** `final-review.md`

---

## Execution Complete

All 12 tasks implemented via Subagent-Driven Development with TDD.
Final verdict: **APPROVED** (after fix wave).

**Deliverables:**

- 9 new source files in `packages/agent-runtime/src/`
- 3 modified files (types.ts, agent.ts, index.ts)
- 12 test files (101 tests, all passing)
- Design doc: `docs/superpowers/specs/2026-07-23-spec-engine-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-23-spec-engine.md`
- 12 task reports + 12 task reviews + 1 final review
- This execution log
