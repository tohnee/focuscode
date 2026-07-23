# Final Whole-Branch Review: SpecEngine Implementation

**Reviewer:** GLM-5.2 (final cross-cutting reviewer)
**Date:** 2026-07-23
**Scope:** 12-task Subagent-Driven Development of SpecEngine (5-stage requirement clarification pipeline)
**Branch state:** All 12 tasks implemented + individually reviewed

## Verdict: APPROVED WITH CONDITIONS — Merge after fixing 2 must-fix items

The SpecEngine implementation is architecturally sound, boundary-compliant, builds clean, and passes all 415 tests (10 skipped live-provider tests). The cross-cutting review found **0 Critical**, **3 Important**, **15 Minor**, and **5 Info** findings. Two Important findings are must-fix before merge (data-loss + logic bug); the third Important finding (event contract gap) is a strong recommendation but not blocking.

## Executive Summary

The SpecEngine adds a 5-stage requirement clarification pipeline (classifier → explorer → drafter → decision-detector → enhancer) to `packages/agent-runtime`, integrated as an optional preprocessing block at the top of `CodingAgent.submit()`. The implementation spans 9 new source files (~1,400 LOC) and 3 modified files, with 95 tests across 12 test files.

**Strengths confirmed by cross-cutting review:**

- Architecture boundaries are clean: `check-boundaries.mjs` passes, no forbidden tokens (`node:fs`, `node:child_process`, `fetch(`, cross-package deps) in any new file
- TypeScript strict mode compliance is excellent across all 9 files — `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` all correctly handled
- Tool name correctness verified: spec-engine.ts uses `["read", "grep", "find", "ls"]` matching the actual registry in `tools.ts:347` (the design spec's mention of "glob" is a doc error, not a code error)
- `node:crypto` in spec-drafter.ts is NOT a boundary violation (used by 3 sibling modules, not on the forbidden list)
- All 9 new exports in `index.ts` are conflict-free (40 unique export names across 9 files)
- The `CodingAgent.submit()` integration is additive — when `specEngine` is undefined, the original control flow is unchanged

**Issues found by cross-cutting review (not caught by individual task reviewers):**

1. A logic bug in the mixed-severity decision confirmation flow that produces incorrect `confirmedDecisions` output
2. A data-loss bug in `SpecStoreImpl.updateStatus` that wipes spec body content on every status update
3. A design-contract gap where 3 of 7 declared `spec_*` AgentEvent variants are never emitted

## Verification Commands Run

| Check                   | Command                                                     | Result                                                      |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Architecture boundaries | `node scripts/check-boundaries.mjs`                         | **PASS** — "Architecture boundary check passed."            |
| Build                   | `pnpm build`                                                | **PASS** — all packages compiled clean                      |
| Tests                   | `npx vitest run packages/agent-runtime/ --reporter=verbose` | **PASS** — 415 passed, 10 skipped, 0 failed (51 test files) |

## Cross-Cutting Findings

### 1. Type Consistency

The type system is generally coherent across the 9 new files, with one notable cross-task pattern:

- **Task 1** defined `SpecClarifyInput.eventSink` as `(event: unknown) => ...` (spec-types.ts:112) rather than `(event: AgentEvent) => ...`. The design spec specified `AgentEvent`. The plan also had `unknown`, so the implementer was plan-faithful. Task 10 later widened `spec_confirmation_required.decisions` and `spec_confirmed.decisions` to `unknown[]` (deliberately, to avoid circular deps between `types.ts` and `spec-types.ts`). These two `unknown` usages are consistent with each other but represent a loss of type safety for consumers. **Non-blocking** — the one-directional dependency (`spec-types.ts` → `types.ts`, never reverse) is correctly maintained.

- **Task 10** correctly preserved all 15 pre-existing `AgentEvent` variants and added 7 new `spec_*` variants. The `SpecKeyDecision[] → unknown[]` widening is structurally sound (array covariance), so no casts were needed at emit sites in `spec-engine.ts`.

- **Cross-task type flow verified:** `SpecClarifyResult` (discriminated union: skip/abort/apply) flows correctly from `spec-engine.ts` → `agent.ts` submit() preprocessing block. The `apply` variant's `enhancedPrompt: string` correctly reassigns the `prompt` variable, and `initialTodos: SpecInitialTodo[]` correctly maps to `TodoItem[]` (dropping `priority`, which has no `TodoItem` field — data preserved in persisted `SpecDocument`).

### 2. Boundary Compliance

**All 9 new source files pass boundary checks.** Verified via `check-boundaries.mjs` + manual grep:

- No `node:fs`, `node:child_process`, `fetch(`, or `require(` in any new file
- No `@focuscode/*` cross-package imports (all imports are sibling `./....js` within `agent-runtime/src`)
- `node:crypto` in `spec-drafter.ts` is permitted (used by `audit-journal.ts`, `media.ts`, `steering.ts`)
- `node:path` in `spec-store.ts` is permitted
- `process.cwd()` in `spec-engine.ts` constructor is permitted (not a forbidden token; couples to construction-time cwd — see Info findings)
- Filesystem access is correctly injected via `SpecEngineDeps` callbacks (`writeFile`/`readFile`/`listDir`), keeping `agent-runtime` free of direct `node:fs`

### 3. Pipeline Orchestration Correctness

**Important finding — mixed-severity decision bug (spec-engine.ts:178-197):**

The confirmation flow has a logic bug when decisions span multiple severity levels. The flow:

1. Line 178-181: `confirmedDecisions` is built from `keyDecisions`, auto-choosing the first option for minor decisions with options.
2. Line 183: If `blockingDecisions.length > 0`, the user is asked to confirm critical/major decisions.
3. Line 194-197: `confirmedDecisions` is **rebuilt from scratch** from `keyDecisions`, using only `userChoices[d.id]` to set `chosen`.

The rebuild at step 3 discards the auto-choices from step 1. `userChoices` only contains entries for blocking decisions (critical/major) that the user confirmed. Minor decisions have no entry in `userChoices`, so `userChoices[d.id]` is `undefined` for them, and the `chosen` field is not set. The enhancer (Stage 5) receives `confirmedDecisions` where minor decisions have no `chosen` despite being auto-resolved at step 1.

This is **plan-faithful** (the plan's code is identical) but a real bug. No test covers the mixed-severity scenario — all tests use either empty decisions, all-blocking decisions, or no decisions. The bug manifests whenever a spec has both critical/major and minor decisions with options, which is the expected common case per the design spec's severity model.

### 4. Integration Correctness

**Important finding — 3 declared AgentEvent variants never emitted:**

`types.ts` (Task 10) declares 7 `spec_*` variants in the `AgentEvent` union. `spec-engine.ts` (Task 9) only emits 4:

| Event variant                | Declared in types.ts | Emitted in spec-engine.ts | Line |
| ---------------------------- | -------------------- | ------------------------- | ---- |
| `spec_start`                 | ✅                   | ✅                        | 96   |
| `spec_confirmation_required` | ✅                   | ✅                        | 186  |
| `spec_confirmed`             | ✅                   | ✅                        | 199  |
| `spec_completed`             | ✅                   | ✅                        | 260  |
| `spec_stage`                 | ✅                   | ❌ Never emitted          | —    |
| `spec_draft_ready`           | ✅                   | ❌ Never emitted          | —    |
| `spec_skipped`               | ✅                   | ❌ Never emitted          | —    |

The `spec_skipped` gap is the most impactful: all 5 skip paths (lines 61, 83, 87, 90, 149) return `{ action: "skip" }` without emitting any event. Since `spec_start` is only emitted AFTER the skip decision (line 95 comes after the skip checks), consumers cannot distinguish "SpecEngine was configured but decided to skip" from "SpecEngine was not configured at all." This is an observability gap for any UI or audit consumer tracking SpecEngine activity.

The `spec_stage` gap means progress tracking (which stage is running, which model, duration, fallback status) is only captured in the `trace` array internal to `clarify()` — it never reaches `eventSink`. The `spec_draft_ready` gap means consumers cannot show the draft to the user before the confirmation flow.

The integration test (Task 11, test #3) only asserts `spec_start` + `spec_completed`, so this gap is hidden by the test suite.

### 5. Accumulated Minor Findings Triage

| #   | Source task | Finding                                                                         | Severity | Cross-cutting impact                                                 | Disposition                                                |
| --- | ----------- | ------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| M1  | Task 1      | `eventSink` typed `unknown` not `AgentEvent`                                    | Minor    | Consumers lose type narrowing on spec_* events                       | **Defer** — plan-faithful, one-line fix, no runtime impact |
| M2  | Task 2      | `mockClientSequence([])` returns undefined response                             | Minor    | Test utility, no production impact                                   | **Defer** — add guard or document precondition             |
| M3  | Task 2      | `parseJsonResponse` won't extract JSON in prose                                 | Minor    | Affects all stages if model prefixes JSON with text                  | **Accept** — plan-faithful, retry path compensates         |
| M4  | Task 2      | `fallbackEnhance` decisions branch untested                                     | Minor    | `## Confirmed Decisions` section never exercised                     | **Defer** — add test in follow-up                          |
| M5  | Task 4      | Abort signal not propagated to tool execution                                   | Minor    | Slow read-only tools can't be interrupted mid-execution              | **Defer** — plan-faithful, low real-world impact           |
| M6  | Task 4      | System prompt says "glob", actual tool is "find"                                | Minor    | Instructional text only, no behavioral impact                        | **Accept** — cosmetic                                      |
| M7  | Task 5      | Drafter throws instead of returning minimal SpecDraft                           | Minor    | Orchestrator catches → skip; by design                               | **Accept** — design decision, documented                   |
| M8  | Task 7      | `## Confirmed Decisions` format divergence between enhancer and fallbackEnhance | Minor    | Downstream tool loop sees different format on fallback vs happy path | **Defer** — pick one canonical shape                       |
| M9  | Task 8      | `parseFrontmatter` doesn't extract `updatedAt`                                  | Minor    | Loaded docs have `updatedAt === createdAt`                           | **Defer** — one-line fix                                   |
| M10 | Task 8      | `resolveFilename` unbounded `while(true)` loop                                  | Minor    | Pathological directory could cause many probes                       | **Accept** — internal tool, low risk                       |
| M11 | Task 8      | `list(0)` returns all specs instead of zero                                     | Minor    | `list(0)` is an unlikely call                                        | **Accept** — edge case                                     |
| M12 | Task 8      | No slugification of topic in filename                                           | Minor    | Topics with spaces produce awkward filenames                         | **Defer** — convention upstream                            |
| M13 | Task 9      | `needsClarification` variable scope wider than necessary                        | Minor    | Style only                                                           | **Accept**                                                 |
| M14 | Task 9      | `runStageMain` accepts but voids client/profile params                          | Minor    | Dead parameters                                                      | **Accept** — plan-faithful                                 |
| M15 | Task 11     | Test #3 `result.content === "done"` doesn't verify enhanced prompt              | Minor    | Mock returns "done" regardless of input                              | **Defer** — use `mockClientSequence` or recording mock     |
| M16 | Task 12     | `mockClient`/`mockClientSequence` leak into public API                          | Minor    | Test utilities in public surface                                     | **Defer** — use named exports instead of `export *`        |

### 6. Test Coverage Gaps

**Cross-cutting gaps not visible in any single task review:**

1. **No mixed-severity decision test:** The confirmation flow (spec-engine.ts:174-203) is never tested with a mix of critical/major + minor decisions. This hides the Important bug in finding #3. All tests use either empty decisions, all-blocking, or no decisions.

2. **No `spec_skipped` event assertion:** No test asserts that `spec_skipped` is (or is not) emitted on skip paths. This hides the Important finding in #4.

3. **No `updateStatus` body-preservation test:** The "updates status" test (spec-store.test.ts) only asserts frontmatter fields. No test asserts that `goal`, `enhancedPrompt`, `taskBreakdown`, or `keyDecisions` survive a `updateStatus` round-trip. This hides the Important finding in #5.

4. **No abort-during-confirmation test:** The `waitForConfirmation` mechanism with `AbortController` bridge is not tested with an aborted signal. Only the happy path (resolveDecisions) and decline path (declineSpec) are tested.

5. **No end-to-end fallback chain test:** No test exercises the full pipeline where classifier succeeds, explorer fails (→ emptyExplorerResult), drafter succeeds with empty explorer data, detector fails (→ empty decisions), enhancer fails (→ fallbackEnhance). Each stage's fallback is tested in isolation, but the composition is not.

### 7. Design Fidelity

The implementation is faithful to the design spec (`docs/superpowers/specs/2026-07-23-spec-engine-design.md`) with two notable gaps:

- **Event contract gap (finding #4):** The design spec describes `spec_stage`, `spec_draft_ready`, and `spec_skipped` as part of the AgentEvent extension. The plan did not implement emission of these events, and the implementer followed the plan. This is a plan-level gap from the design spec.

- **Tool name "glob" vs "find":** The design spec references "glob" as a read-only tool name. The actual registry uses "find" (tools.ts:347, context.ts:85). The implementation correctly uses "find" (spec-engine.ts:378), deviating from the design spec text but matching the actual codebase. This is a design spec doc error, not an implementation error.

- **Small-model pipeline tiers:** The design spec recommends specific model tiers per stage (1B-2B for classifier/detector, 3B-7B for drafter/enhancer, main model for explorer). The implementation correctly delegates model selection to `SpecPipeline` config (caller's responsibility), not hardcoding tiers. This is the correct separation of concerns.

## Findings

### Critical

None.

### Important

**I-1. Mixed-severity decision confirmation bug**

- **Location:** `packages/agent-runtime/src/spec-engine.ts:194-197`
- **Symptom:** When `blockingDecisions.length > 0`, `confirmedDecisions` is rebuilt from `keyDecisions` using only `userChoices[d.id]`. Minor decisions auto-chosen at line 180 lose their `chosen` field because `userChoices` only contains blocking decisions.
- **Source:** The rebuild at line 194 discards the auto-choices from line 178-181.
- **Consequence:** The enhancer (Stage 5) receives `confirmedDecisions` where minor decisions have no `chosen` field despite being auto-resolved. The enhanced prompt will omit the auto-chosen options for minor decisions, producing an incomplete specification.
- **Remedy:** Merge auto-choices with user-choices in the rebuild:
  ```typescript
  confirmedDecisions = keyDecisions.map((d) => ({
    ...d,
    ...(d.severity === "minor" && d.options.length > 0
      ? { chosen: d.options[0]!.label }
      : userChoices[d.id]
        ? { chosen: userChoices[d.id] }
        : {}),
  }));
  ```
- **Test gap:** No test covers mixed-severity decisions. Add a test with 1 critical + 1 minor decision (with options), confirm both `chosen` fields are set in the `spec_confirmed` event.

**I-2. `SpecStoreImpl.updateStatus` destroys spec body content**

- **Location:** `packages/agent-runtime/src/spec-store.ts:67-73` (`updateStatus`) + `spec-store.ts:194-225` (`deserialize`)
- **Symptom:** `updateStatus` calls `load(specId)` → mutate `status`/`updatedAt` → `save(doc)`. But `deserialize` returns a minimal doc with empty body fields (`goal: ""`, `enhancedPrompt: ""`, `taskBreakdown: []`, `keyDecisions: []`, etc.). After re-save, the file's body is wiped — all structured content is lost; only frontmatter survives.
- **Source:** `deserialize` does not parse the markdown body; it only reads frontmatter. `updateStatus` round-trips through load → save, so the unparsed body is lost.
- **Consequence:** Any status update (draft → executing → completed) destroys the spec's human-readable content. The spec lifecycle requires `updateStatus` calls, so this bug manifests on every spec that progresses past `draft`.
- **Remedy:** Have `updateStatus` read the raw file text and rewrite only the frontmatter lines (preserving the body). The `replaceFrontmatterField` helper already exists for in-place frontmatter editing — use it or follow the same pattern.
- **Test gap:** The "updates status" test only asserts `status: executing` in frontmatter. Add a test asserting `goal`, `enhancedPrompt`, and `taskBreakdown` are preserved after `updateStatus`.

**I-3. Three declared AgentEvent variants never emitted**

- **Location:** `packages/agent-runtime/src/types.ts:199-200, 207` (declarations) vs `packages/agent-runtime/src/spec-engine.ts` (emissions)
- **Symptom:** `spec_stage`, `spec_draft_ready`, and `spec_skipped` are declared in the `AgentEvent` union but never emitted by `spec-engine.ts`. Only 4 of 7 variants are emitted.
- **Source:** The plan did not include emission code for these 3 events. The implementer followed the plan.
- **Consequence:** Consumers listening for stage progress (`spec_stage`), draft readiness (`spec_draft_ready`), or skip notifications (`spec_skipped`) receive nothing. The `spec_skipped` gap is most impactful: consumers cannot distinguish "SpecEngine skipped" from "SpecEngine not configured."
- **Remedy:** Emit `spec_skipped` on all 5 skip paths (lines 61, 83, 87, 90, 149). Emit `spec_stage` after each `runStage`/`runStageMain` call with trace data. Emit `spec_draft_ready` after the drafter stage succeeds. Alternatively, remove the 3 unused variants from `types.ts` and document the reduced contract.
- **Test gap:** No test asserts presence/absence of these 3 events. Add tests for `spec_skipped` on skip paths.

### Minor

1. **M1 (Task 1):** `SpecClarifyInput.eventSink` typed `unknown` instead of `AgentEvent` (spec-types.ts:112). Plan-faithful, one-line fix.
2. **M2 (Task 2):** `mockClientSequence([])` produces `undefined` response — no empty-array guard.
3. **M3 (Task 2):** `parseJsonResponse` regex anchored at `^`````, won't extract JSON embedded in prose.
4. **M4 (Task 2):** `fallbackEnhance` `## Confirmed Decisions` branch untested (always passes `[]`).
5. **M5 (Task 4):** Abort signal not propagated to `tool.execute()` in explorer — slow tools can't be interrupted.
6. **M6 (Task 4):** Explorer system prompt says "glob", actual tool is "find" — cosmetic only.
7. **M7 (Task 5):** Drafter throws on double-failure instead of returning minimal SpecDraft — by design, orchestrator catches.
8. **M8 (Task 7):** `## Confirmed Decisions` section emitted by `fallbackEnhance` but not by enhancer's `SYSTEM_PROMPT` — format asymmetry.
9. **M9 (Task 8):** `parseFrontmatter` doesn't extract `updatedAt` — loaded docs have `updatedAt === createdAt`.
10. **M10 (Task 8):** `resolveFilename` uses unbounded `while(true)` loop.
11. **M11 (Task 8):** `list(0)` returns all specs instead of zero (falsy check on `limit`).
12. **M12 (Task 8):** No slugification of topic in filename — spaces produce awkward filenames.
13. **M13 (Task 9):** `needsClarification` variable scope wider than necessary — style only.
14. **M14 (Task 9):** `runStageMain` accepts but voids `client`/`profile` params — dead parameters.
15. **M15 (Task 11):** Test #3 `result.content === "done"` doesn't verify enhanced prompt reached the model.
16. **M16 (Task 12):** `mockClient`/`mockClientSequence` leak into public API via `export *`.

### Info

1. `process.cwd()` in spec-engine.ts constructor couples engine to construction-time cwd. Not a boundary violation. Consider accepting `cwd` as a constructor param for testability.
2. `waitForConfirmation` hangs indefinitely if the caller never invokes `resolveDecisions()` or `declineSpec()`. No timeout. Acceptable for interactive use; risky for programmatic use.
3. `currentSpecId` is write-only in agent.ts after Task 11. Presumably consumed by external callers or future tasks. Not dead code in context.
4. `node:crypto` in spec-drafter.ts is NOT a boundary violation — used by 3 sibling modules (`audit-journal.ts`, `media.ts`, `steering.ts`), not on the forbidden token list.
5. Tool name "find" (not "glob") is correctly used in spec-engine.ts — matches actual registry in `tools.ts:347` and `context.ts:85`. The design spec's mention of "glob" is a documentation error.

## Must-Fix Before Merge

1. **I-1: Mixed-severity decision bug** (spec-engine.ts:194-197) — Fix the rebuild to preserve minor decision auto-choices. Add a test with mixed-severity decisions.

2. **I-2: `updateStatus` data loss** (spec-store.ts:67-73) — Fix `updateStatus` to preserve the spec body (rewrite only frontmatter, or parse body in `deserialize`). Add a test asserting body preservation after status update.

**Strongly recommended (not blocking):** 3. **I-3: Emit `spec_skipped` on all skip paths** — At minimum, emit `spec_skipped` so consumers can distinguish "skipped" from "not configured." Emitting `spec_stage` and `spec_draft_ready` can be deferred to a follow-up if the team accepts the observability gap. Alternatively, remove the 3 unused variants from `types.ts` to align the contract with reality.

## Recommendation

**Merge after fixing I-1 and I-2.** Both are real bugs with user-visible impact (incorrect enhanced prompt for mixed-severity specs; data loss on every status update). Each is a localized fix (< 10 LOC) with a clear test to add. I-3 should be addressed in the same PR if possible (emit `spec_skipped` at minimum), but is not blocking — the SpecEngine is an opt-in feature and the missing events are a gap in observability, not a correctness bug.

The 16 Minor findings are all non-blocking and can be addressed in follow-up PRs. The implementation quality is high: boundary compliance is perfect, TypeScript strict mode is correctly handled throughout, the integration is additive and non-breaking, and the 95-test suite provides solid coverage of individual stages. The cross-cutting gaps (mixed-severity test, body-preservation test, skip-event assertion) are the natural blind spots of task-by-task review and are addressed by the must-fix test additions.
