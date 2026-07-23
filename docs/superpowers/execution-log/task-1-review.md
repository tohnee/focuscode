# Task 1 Review: SpecEngine Type Definitions

**Reviewer:** Code Review Agent
**Date:** 2026-07-23
**Files reviewed:**

- `packages/agent-runtime/src/spec-types.ts`
- `packages/agent-runtime/test/spec-types.test.ts`
- `docs/superpowers/execution-log/task-1-report.md`

**Verification performed (independent):**

- `pnpm --filter @focuscode/agent-runtime build` — PASS (exit 0)
- `npx vitest run packages/agent-runtime/test/spec-types.test.ts` — 8/8 tests pass
- `node scripts/check-boundaries.mjs` — PASS
- `npx prettier --check` on both files — PASS
- Confirmed `tsconfig.base.json` has `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`
- Confirmed `packages/agent-runtime/tsconfig.json` only includes `src/**/*.ts` (test files not compiled by tsc)
- Confirmed `vitest.config.ts` has no `typecheck.enabled` (vitest runs runtime only)

---

## Spec Compliance: ✅ PASS

Every type defined in the spec design doc (`docs/superpowers/specs/2026-07-23-spec-engine-design.md`) has a corresponding export in `spec-types.ts` with matching property names, types, and optionality:

| Spec type                                                 | Present | Match        |
| --------------------------------------------------------- | ------- | ------------ |
| SpecStatus (7 lifecycle states)                           | ✅      | ✅           |
| SpecTrigger                                               | ✅      | ✅           |
| SpecDocument (13 fields)                                  | ✅      | ✅           |
| SpecUnderstanding (5 fields)                              | ✅      | ✅           |
| SpecConstraint                                            | ✅      | ✅           |
| SpecAcceptanceCriterion                                   | ✅      | ✅           |
| SpecAffectedArea                                          | ✅      | ✅           |
| SpecAmbiguity                                             | ✅      | ✅           |
| SpecTaskNode                                              | ✅      | ✅           |
| SpecKeyDecision                                           | ✅      | ✅           |
| SpecInitialTodo                                           | ✅      | ✅           |
| SpecPipelineTrace                                         | ✅      | ✅           |
| SpecStageTrace (name: 5 stages + "persist" = 6 values)    | ✅      | ✅           |
| SpecClarifyInput                                          | ✅      | ⚠️ see below |
| SpecClarifyResult (discriminated union: skip/abort/apply) | ✅      | ✅           |
| SpecDraft                                                 | ✅      | ✅           |
| ExplorerResult                                            | ✅      | ✅           |
| SpecEngineOptions (§1.5 final version with pipeline)      | ✅      | ✅           |
| SpecPipeline                                              | ✅      | ✅           |
| SpecStageModel                                            | ✅      | ✅           |
| KeyDecisionRule                                           | ✅      | ✅           |
| SpecEngineDeps                                            | ✅      | ✅           |
| SpecStore                                                 | ✅      | ✅           |
| SpecSummary                                               | ✅      | ✅           |

**SpecStageTrace.name** correctly includes all 6 values: `"classify" | "explore" | "draft" | "detect-decisions" | "enhance" | "persist"` — the 5 pipeline stages plus "persist" for trace recording. ✅

**Discriminated union** `SpecClarifyResult` correctly uses `action: "skip" | "abort" | "apply"` per the spec. (Note: the review checklist mentioned `"confirm"` as an action variant — this does not exist in the spec; the checklist itself has an error. The implementation is correct.)

**Checklist type-name note:** The review checklist referenced several type names that do not exist in the spec design doc: `SpecClassification`, `SpecEnhancedPrompt`, `SpecStoreEntry`, `SpecClarifyResponse`, `SpecResult`. These appear to be checklist inaccuracies. The spec defines `SpecClarifyResult` (not `SpecClarifyResponse`), uses `enhancedPrompt: string` as a field (not a standalone type), and never defines `SpecClassification`/`SpecStoreEntry`/`SpecResult` as named types. The implementation correctly matches the actual spec, not the erroneous checklist entries.

---

## Code Quality: ⚠️ ISSUES FOUND

### Finding 1 — `eventSink` type uses `unknown` instead of `AgentEvent` (Important)

**Location:** `spec-types.ts:112`

```typescript
eventSink?: (event: unknown) => void | Promise<void>;
```

**Spec says:** `eventSink?: (event: AgentEvent) => void | Promise<void>;` (§ SpecClarifyInput in design doc)

**Impact:** The `AgentEvent` type is already exported from `./types.ts` (line 171) and the file already imports from `./types.js`. Using `unknown` instead of `AgentEvent` weakens type safety for all consumers of `SpecClarifyInput.eventSink` — the SpecEngine implementation and CLI event handlers would lose type narrowing on spec_* events. This is a deviation from the authoritative spec design doc.

**Origin:** The plan (`2026-07-23-spec-engine.md` line 332) also had `unknown`, so the implementer followed the plan faithfully. However, the spec design doc is the authoritative source and it specifies `AgentEvent`.

**Fix:** Add `AgentEvent` to the existing import and use it:

```typescript
import type { AgentAttachment, AgentEvent, AgentMessage, ModelClient, ModelProfile } from "./types.js";
// ...
eventSink?: (event: AgentEvent) => void | Promise<void>;
```

The implementer acknowledged this deviation in their report (concern #3) and suggested it may be tightened later. Given that `AgentEvent` is already available and imported from the same module, this should be fixed now rather than deferred.

### All other code-quality checks pass:

- **No `any`:** ✅ No `any` anywhere; the only `unknown` is the `eventSink` deviation above.
- **`exactOptionalPropertyTypes`:** ✅ All optional properties use `?:`, never `| undefined`.
- **`verbatimModuleSyntax`:** ✅ All imports use `import type`.
- **No external package imports:** ✅ Only `./types.js` and `./tools.js`.
- **No `node:fs` / `node:child_process` / `fetch()`:** ✅ None present.
- **`.js` import extensions:** ✅ Both imports use `.js`.
- **Prettier:** ✅ Verified — printWidth 100, double quotes, semicolons, trailing comma "all".
- **Architecture boundaries:** ✅ `check-boundaries.mjs` passes; only imports sibling modules within `agent-runtime/src`.
- **`AgentToolRegistry` import split:** ✅ Correct — `AgentToolRegistry` is a class exported from `./tools.ts` (line 53), not `./types.ts`. The implementer's split import is the right fix for a compilation error that would have occurred had they followed the plan verbatim.

---

## Test Quality: ⚠️ ISSUES FOUND

### Finding 2 — Tests do not type-check (Minor, toolchain limitation)

The test file uses `import type { ... }` which is erased at runtime by esbuild/rollup. Since `vitest.config.ts` does not enable `typecheck.enabled` and `packages/agent-runtime/tsconfig.json` only includes `src/**/*.ts`, the type annotations in the test file are never validated by `tsc`. This means:

- If a type were renamed or removed from `spec-types.ts`, the test would still pass at runtime (it only checks JS values).
- The actual type-safety validation comes from `tsc` compiling `src/spec-types.ts` itself, which passes.

This is a known characteristic of this repo's toolchain for type-only modules (the implementer documented this accurately in their report). It is not a defect in the implementation, but it means the test file's type annotations serve as documentation rather than enforced contracts. Subsequent tasks that import these types from `src/` will fail `pnpm build` if types are wrong.

### Finding 3 — Missing direct tests for SpecStore, SpecEngineDeps, SpecPipeline interfaces (Minor)

The test file does not directly instantiate `SpecStore`, `SpecEngineDeps`, `SpecPipeline`, or `SpecPipelineTrace`. `SpecStore` and `SpecEngineDeps` are forward references for later tasks (as the implementer noted), so their absence is acceptable for Task 1. However, `SpecPipelineTrace` is used in `SpecDocument` (tested) and could have had a dedicated test confirming the `stages`/`totalMs`/`hadFallback` shape.

### What the tests do well:

- ✅ `SpecDocument` test constructs a full document with all 13 fields and asserts on values.
- ✅ `SpecStatus` test enumerates all 7 lifecycle states and asserts length.
- ✅ `SpecClarifyResult` discriminated union test constructs all 3 variants (skip/abort/apply) and asserts on `action`.
- ✅ `SpecStageTrace` test confirms "persist" is a valid `name` value.
- ✅ `SpecStageModel` test confirms `profile`/`client`/`fallback` shape.
- ✅ `ExplorerResult` test constructs all 5 fields.
- ✅ `KeyDecisionRule` test confirms `name`/`description`.
- ✅ `SpecClarifyInput` test constructs required fields for `submit()` integration.
- ✅ Tests assert meaningful values, not just `expect(true).toBe(true)`.

---

## Overall Verdict: NEEDS FIXES

The implementation is high quality and nearly spec-compliant. The build, tests, boundary check, and prettier all pass independently. The only actionable issue is **Finding 1**: `eventSink` should use `AgentEvent` instead of `unknown` to match the spec design doc. This is a one-line fix (add `AgentEvent` to the existing import, change the type). Findings 2 and 3 are minor/toolchain notes that do not block approval.

**Recommended action:** Fix Finding 1, then approve.

### Findings summary

| #   | Severity  | Finding                                                                        | Action                                                 |
| --- | --------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | Important | `eventSink` uses `unknown` instead of `AgentEvent` (spec deviation)            | Change to `AgentEvent`; add to existing import         |
| 2   | Minor     | Test file type annotations not validated by tsc/vitest (toolchain limitation)  | No action needed; document awareness                   |
| 3   | Minor     | No direct tests for SpecStore, SpecEngineDeps, SpecPipeline, SpecPipelineTrace | Acceptable for Task 1; later tasks will exercise these |
