# Task 9 Report: SpecEngine Orchestrator

## Status: DONE

## Files Created

- `packages/agent-runtime/src/spec-engine.ts` — 395 lines (SpecEngine class: `clarify()`, `resolveDecisions()`, `declineSpec()`, private helpers `runStage`, `runStageMain`, `fallbackToMain`, `waitForConfirmation`, `readOnlyTools`, `extractTodos`, `emit`)
- `packages/agent-runtime/test/spec-engine.test.ts` — 16 tests covering all pipeline paths

## Files Modified

- `packages/agent-runtime/src/types.ts` — Added `import type { SpecKeyDecision } from "./spec-types.js";` (line 2) and 4 new variants to the `AgentEvent` union (`spec_start`, `spec_confirmation_required`, `spec_confirmed`, `spec_completed` at lines 199–202). Cross-task dependency for Task 10 — minimal addition so Task 9 compiles.
- `packages/agent-runtime/src/spec-enhancer.ts` — Added empty-content check that throws `Error("Enhancer returned empty content")` so `fallbackEnhance` gets triggered on model failure (aligns with plan's design intent).

## TDD Evidence

- RED phase: `npx vitest run packages/agent-runtime/test/spec-engine.test.ts` — FAIL (Cannot find module `../src/spec-engine.js`)
- GREEN phase: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/spec-engine.test.ts` — PASS, 16 tests
- Final GREEN: `Test Files  1 passed (1)` / `Tests  16 passed (16)` / `Duration  275ms`

## Stage Signature Verification (source of truth vs plan)

All stage function signatures match the plan usage exactly — no signature adaptations required:

| Stage      | File                        | Signature (verified)                                                                                                                                                                                                     |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Classifier | `spec-classifier.ts`        | `classifyIntent(client, profile, prompt, projectType, signal?)` — throws on double JSON failure                                                                                                                          |
| Explorer   | `spec-explorer.ts`          | `exploreCodebase(params: ExploreCodebaseParams)` — fail-safe, returns `emptyExplorerResult()` on error                                                                                                                   |
| Drafter    | `spec-drafter.ts`           | `draftSpec(client, profile, params: DraftSpecParams)` — throws on double JSON failure                                                                                                                                    |
| Detector   | `spec-decision-detector.ts` | `detectDecisions(client, profile, draft, rules)` — throws on double JSON failure                                                                                                                                         |
| Enhancer   | `spec-enhancer.ts`          | `enhancePrompt(client, profile, params: EnhancePromptParams)` — now throws on empty content                                                                                                                              |
| Store      | `spec-store.ts`             | `new SpecStoreImpl(cwd, specDirectory, deps)`, `save(doc) → Promise<string>` returns path                                                                                                                                |
| Helpers    | `spec-pipeline-helpers.ts`  | `emptyExplorerResult()`, `fallbackEnhance(draft, decisions)`, plus test mocks `mockClient`, `mockClientSequence`                                                                                                         |
| Types      | `spec-types.ts`             | All types verified: `SpecClarifyInput`, `SpecClarifyResult`, `SpecStageModel`, `SpecStageTrace`, `SpecPipeline`, `SpecEngineOptions`, `SpecEngineDeps`, `SpecDraft`, `SpecKeyDecision`, `SpecDocument`, `ExplorerResult` |
| Tools      | `tools.ts`                  | `AgentToolRegistry.get(name): AgentTool \| undefined` (NOT optional, but tests use `{} as never` mocks so `get?.()` defensive chaining is retained)                                                                      |

## Boundary & Prettier

- Boundary check: `node scripts/check-boundaries.mjs` — PASSED ("Architecture boundary check passed.")
- Prettier check: initial run flagged `spec-engine.ts` and `spec-engine.test.ts`; ran `npx prettier --write` on both; re-check PASSED ("All matched files use Prettier code style!")
- All 4 modified/created files pass Prettier: `spec-engine.ts`, `spec-engine.test.ts`, `types.ts`, `spec-enhancer.ts`
- Post-format re-verification: build + tests still GREEN (16/16 pass)

## Deviations from plan

- **`AgentToolRegistry` import split (required fix):** The plan's import statement placed `AgentToolRegistry` in `./types.js`, but it is actually exported from `./tools.js`. Split the import into two: `import type { AgentEvent, AgentTool, ModelClient, ModelProfile } from "./types.js";` and `import type { AgentToolRegistry } from "./tools.js";`.
- **`spec-enhancer.ts` empty-content throw (required for fallback path):** The plan's design assumes the enhancer throws on model error so `fallbackEnhance` gets called. The original `enhancePrompt` returned an empty string on empty content, which broke the "uses fallback enhance when enhancer fails" test. Added `if (!content) throw new Error("Enhancer returned empty content");` after trimming the response. This aligns the implementation with the plan's fallback strategy.
- **`catch` block cleanup (cosmetic):** The classifier catch block originally had `catch (error)` with a `void error;` statement to satisfy `useUnknownInCatchVariables`. Since `error` was unused, simplified to `catch { ... }` — no behavior change.
- **types.ts modification (cross-task dependency):** Plan says Task 10 owns the AgentEvent `spec_*` variants, but Task 9 cannot compile without them. Added only the 4 minimal variants needed for `spec-engine.ts` to emit events. Task 10 can extend further without conflict.
- Skipped `git add`/`git commit` per task instructions (not a git repo).

## Concerns

- **`process.cwd()` usage in constructor:** `SpecEngine` calls `process.cwd()` directly in the constructor (for `SpecStoreImpl` and `deps.detectProjectType`). This couples the engine to the process working directory at construction time. Acceptable for the current single-process CLI usage; a future embedder (e.g. SDK) that constructs `SpecEngine` from a different cwd would need constructor injection. Flagging for Task 10/integration review.
- **`waitForConfirmation` Promise leak on abort:** If the external signal aborts while a confirmation resolver is pending, the resolver is deleted and `null` is resolved. Good. But if neither `resolveDecisions`/`declineSpec` nor abort ever fires, the Promise hangs indefinitely. The orchestrator relies on the caller to drive resolution — appropriate for the integration design but worth noting.
- **`registry.get?.()` optional chaining:** `AgentToolRegistry.get` is not optional in the real class, but tests use `{} as never` mocks without a `get` method. The `?.` is defensive and harmless for production. Acceptable trade-off for test ergonomics.
- **`runStageMain` ignores `client`/`profile` params:** The helper signature accepts `client`/`profile` for symmetry with `runStage` but voids them (`void client; void profile;`) because the actual call uses `input.modelClient`/`input.model` via the closure. Slight API awkwardness but keeps the trace-recording logic centralized. Flagging for future cleanup.

## Test summary

- 16 passed, 0 failed
- Coverage paths:
  1. `/raw` prefix skips pipeline
  2. `/spec` with empty body skips pipeline
  3. Classifier high-confidence (≥0.6) `needsClarification=false` skips pipeline
  4. Classifier low-confidence proceeds through full pipeline
  5. `/spec` force flag bypasses classifier and runs pipeline
  6. Classifier stage failure with `skip` fallback returns skip
  7. Explorer failure continues pipeline (fail-safe)
  8. Drafter failure aborts with skip
  9. Detector failure continues pipeline (records fallback trace)
  10. Enhancer failure triggers `fallbackEnhance` and continues
  11. Minor-only decisions do not pause (auto-choose first option)
  12. Critical decisions pause via `spec_confirmation_required`, then `resolveDecisions` confirms
  13. `declineSpec` returns abort
  14. External signal abort returns abort
  15. Pipeline trace records all stages with `fellBack` flags
  16. `autoTrigger: false` skips classifier and runs pipeline

---

# Fix Report: SpecEngine Post-Review Fixes (I-1, I-3)

**Date:** 2026-07-23
**Trigger:** Final whole-branch review found 2 issues (I-1 real bug, I-3 missing event emissions)

## I-1: Mixed-severity decision bug (REAL — fixed)

**Problem:** When blocking (critical/major) decisions exist, `confirmedDecisions` was rebuilt from `keyDecisions` at line 194. The rebuild only added `chosen` if `userChoices[d.id]` existed. But `userChoices` only contains choices for blocking decisions — minor decisions were auto-chosen at line 178-181, and that auto-choice was LOST in the rebuild. This caused the `spec_confirmed` event, the saved `SpecDocument.keyDecisions`, and the `fallbackEnhance` output to omit the minor decision's `chosen` field.

**Fix:** In the rebuild, preserve the minor auto-choice BEFORE the user choice conditional (so user choice overrides if present, which it won't be for minor decisions):

```typescript
confirmedDecisions = keyDecisions.map((d) => ({
  ...d,
  // Preserve minor auto-choice — userChoices only contains blocking decisions
  ...(d.severity === "minor" && d.options.length > 0 ? { chosen: d.options[0]!.label } : {}),
  ...(userChoices[d.id] ? { chosen: userChoices[d.id] } : {}),
}));
```

**File:** `packages/agent-runtime/src/spec-engine.ts` (clarify method, blocking-decisions rebuild)

## I-3: 3 of 7 spec_* events never emitted (IMPORTANT — fixed)

**Problem:** The `AgentEvent` union declares 7 `spec_*` variants, but `spec-engine.ts` only emitted 4 (`spec_start`, `spec_confirmation_required`, `spec_confirmed`, `spec_completed`). Three were missing: `spec_stage`, `spec_draft_ready`, `spec_skipped`.

### I-3a: Emit `spec_stage` in `runStage()` and explorer call site

Added a private helper `emitSpecStage(input, name, trace)` that reads the last trace entry and emits a `spec_stage` event. Called:

- In `runStage()` after the `!stage` path (delegated to `runStageMain`)
- In `runStage()` success path (after `trace.push`)
- In `runStage()` primary-fallback path (after the retry via `runStageMain`)
- In `clarify()` explorer try block (after `runStageMain` success)
- In `clarify()` explorer catch block (after the fallback trace push)

This ensures exactly one `spec_stage` event per stage execution (classify, explore, draft, detect-decisions, enhance). Stages that throw (strict/skip fallback) do not emit — consistent with stage failure semantics.

### I-3b: Emit `spec_draft_ready` after drafter stage

Added emit immediately after the drafter try-catch block (only reached on success; the catch returns skip):

```typescript
await this.emit(input, {
  type: "spec_draft_ready",
  specId: draft.id,
  topic: draft.topic,
  understanding: draft.understanding,
});
```

### I-3c: Emit `spec_skipped` on all skip paths

Added `await this.emit(input, { type: "spec_skipped", reason: ... })` before every `return { action: "skip" }` in `clarify()`:

1. `/raw` command — reason: "user forced /raw"
2. Empty prompt after `/spec` — reason: "empty prompt after command"
3. Classifier says no clarification needed (high confidence) — reason: `classifier: ${result.reason}`
4. Classifier fails with `fallback=skip` — reason: "classifier failed, assuming execute"
5. Classifier fails with `strict`/`primary` (retry also failed) — reason: "classifier stage failed"
6. Drafter fails — reason: "drafter failed"

## Tests Added

All tests in `packages/agent-runtime/test/spec-engine.test.ts`:

1. **`preserves minor decision auto-choice when blocking decisions exist (I-1)`** — Sets up 1 critical + 1 minor decision, resolves the critical one, and verifies:
   - The `spec_confirmed` event contains BOTH decisions with `chosen` fields (critical="No", minor="camelCase")
   - The `fallbackEnhance` output (enhancer forced to fail) includes the minor decision's point and chosen value

2. **`emits spec_stage events for each pipeline stage (I-3a)`** — Captures all events via `eventSink`, verifies `spec_stage` events are emitted for classify, explore, draft, and enhance stages, and that each has valid `model`, `durationMs`, `fellBack` fields.

3. **`emits spec_draft_ready event after drafter stage (I-3b)`** — Verifies the `spec_draft_ready` event is emitted with correct `topic`, `specId`, and `understanding`, and that it appears in correct order (after `spec_start`, before `spec_completed`).

4. **`emits spec_skipped event when prompt starts with /raw (I-3c)`** — Verifies `spec_skipped` with reason "user forced /raw".

5. **`emits spec_skipped event when classifier says no clarification needed (I-3c)`** — Verifies `spec_skipped` with reason containing "classifier" and the classifier's reason.

6. **`emits spec_skipped event when drafter fails (I-3c)`** — Verifies `spec_skipped` with reason "drafter failed".

## TDD Evidence

- **Before fix (I-1):** The `preserves minor decision auto-choice` test would fail — the `spec_confirmed` event's minor decision would have `chosen: undefined` instead of `"camelCase"`, and the fallback enhanced prompt would omit the minor decision.
- **Before fix (I-3):** The `spec_stage`, `spec_draft_ready`, and `spec_skipped` tests would fail — `events.find(...)` would return `undefined`.
- **After fix:** All 22 tests pass (16 original + 6 new).

```
 ✓ packages/agent-runtime/test/spec-engine.test.ts (22 tests) 165ms
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

## Full Suite Regression Result

```
 Test Files  50 passed | 1 skipped (51)
      Tests  421 passed | 10 skipped (431)
   Duration  6.41s
```

Was 415 passed / 10 skipped before fixes; now 421 passed (415 + 6 new) / 10 skipped. No regressions.

## Boundary Check Result

```
Architecture boundary check passed.
```

## Prettier Check Result

```
Checking formatting...
All matched files use Prettier code style!
```

## Files Modified

- `packages/agent-runtime/src/spec-engine.ts` — I-1 fix (1 hunk), I-3a fix (emitSpecStage helper + 5 call sites), I-3b fix (1 emit), I-3c fix (6 skip-path emits)
- `packages/agent-runtime/test/spec-engine.test.ts` — Added `AgentEvent` import and 6 new tests
