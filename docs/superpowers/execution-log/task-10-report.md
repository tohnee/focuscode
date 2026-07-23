# Task 10 Report: types.ts AgentEvent extension

## Status: DONE

## Files Modified/Created

- `packages/agent-runtime/src/types.ts` — Removed `import type { SpecKeyDecision } from "./spec-types.js"` (line 2, eliminated circular type dependency). Changed `decisions: SpecKeyDecision[]` → `decisions: unknown[]` in both `spec_confirmation_required` and `spec_confirmed` variants. Added 3 missing variants: `spec_stage`, `spec_draft_ready`, `spec_skipped`. Union now has all 7 spec_* variants per plan.
- `packages/agent-runtime/test/spec-events.test.ts` — 62 lines. Created with 8 tests verbatim from plan (lines 3374-3425). Prettier reformatted the `spec_draft_ready` literal across multiple lines (line exceeded printWidth 100); semantics unchanged.

## TDD Evidence

- RED phase: `tsc --noEmit` on the test file produced 3 type errors:
  - `test/spec-events.test.ts(12,7): error TS2820: Type '"spec_stage"' is not assignable to type '"error" | ... | "spec_completed"'. Did you mean '"spec_start"'?`
  - `test/spec-events.test.ts(22,33): error TS2322: Type '"spec_draft_ready"' is not assignable to type ...`
  - `test/spec-events.test.ts(41,33): error TS2322: Type '"spec_skipped"' is not assignable to type ...`
  - Note: vitest uses esbuild (no type-checking), so the 8 tests passed at runtime even in RED. The true RED signal was the `tsc --noEmit` failure on the test file for the 3 missing variants.
- GREEN phase: 8/8 tests pass; `tsc --noEmit` on test file exits 0 with no errors.

## Variants added

Final state of the spec_* section in `AgentEvent` union (`packages/agent-runtime/src/types.ts` lines 198-208):

```typescript
| { type: "spec_start"; input: string; trigger: "auto" | "explicit" }
| { type: "spec_stage"; stage: string; model: string; durationMs: number; fellBack: boolean }
| { type: "spec_draft_ready"; specId: string; topic: string; understanding: unknown }
| {
    type: "spec_confirmation_required";
    specId: string;
    decisions: unknown[];
  }
| { type: "spec_confirmed"; specId: string; decisions: unknown[] }
| { type: "spec_skipped"; reason: string }
| { type: "spec_completed"; specId: string; enhancedPrompt: string };
```

## Circular dependency check

- types.ts imports from spec-types.ts? **NO** — `import type { SpecKeyDecision } from "./spec-types.js"` removed. Grep for `spec-types|SpecKeyDecision|SpecUnderstanding` in types.ts returns no matches.
- SpecKeyDecision import removed? **YES**.
- Confirmed `spec-types.ts` still imports `AgentEvent` from `./types.js` (one-directional: spec-types → types), so the dependency direction is now acyclic as the plan intended.
- `spec-engine.ts` (which emits these events) compiled cleanly with `decisions: unknown[]` — no type assertion was needed because `SpecKeyDecision[]` is assignable to `unknown[]` (covariant array assignment). Build of `packages/agent-runtime` succeeded.

## Regression check

- Full suite (`npx vitest run packages/agent-runtime/`): **405 passed, 10 skipped, 0 failed** across 48 test files passed | 1 skipped (`live-providers.test.ts` — 10 tests skipped, requires live API keys, pre-existing skip).
- `pnpm build` (full monorepo `pnpm -r build`): all packages compiled successfully, exit code 0.

## Boundary & Prettier

- `node scripts/check-boundaries.mjs`: **"Architecture boundary check passed."** (exit 0). No forbidden tokens introduced; types.ts remains a leaf-level module with no `@focuscode/*` imports beyond `@focuscode/action-domain` (which was already present).
- `npx prettier --check packages/agent-runtime/src/types.ts packages/agent-runtime/test/spec-events.test.ts`: **"All matched files use Prettier code style!"** (after running `--write` on the test file once to fix the long `spec_draft_ready` line).

## Deviations

- The `spec_draft_ready` test literal `{ type: "spec_draft_ready", specId: "spec_1", topic: "test", understanding: {} }` exceeded prettier printWidth 100, so prettier reformatted it to multi-line. This is a formatting-only change; the test source was copied verbatim from the plan first, then formatted.
- RED phase was verified via `tsc --noEmit` rather than via vitest run, because vitest uses esbuild which strips types without checking them. The plan's "Expected: FAIL" for Step 2 is satisfied by the tsc type errors quoted above.
- No changes were needed to `spec-engine.ts` — the `SpecKeyDecision[]` → `unknown[]` widening is structurally compatible with existing emit call sites (array covariance).

## Test summary

- spec-events.test.ts: **8 passed, 0 failed**
- Full agent-runtime suite: **405 passed, 0 failed, 10 skipped** (pre-existing live-providers skips)
