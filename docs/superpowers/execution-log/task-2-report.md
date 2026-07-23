# Task 2 Report: SpecEngine Pipeline Helper Utilities

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-pipeline-helpers.ts` — runtime helpers for the SpecEngine pipeline: `parseJsonResponse`, `emptyExplorerResult`, `fallbackEnhance`, plus test utilities `mockClient` and `mockClientSequence`
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-pipeline-helpers.test.ts` — 10 vitest tests covering all five exported helpers

## Test results

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-pipeline-helpers.test.ts`

- Test Files: 1 passed (1)
- Tests: 10 passed (10), 0 failed
- Duration: ~120ms

Per-suite breakdown:

- `parseJsonResponse` — 5 tests (valid JSON, markdown fences, plain fences, non-JSON → null, partial JSON → null)
- `emptyExplorerResult` — 1 test (all fields empty)
- `fallbackEnhance` — 1 test (builds prompt with Objective / Constraints / Acceptance Criteria / Execution Order sections)
- `mockClient` — 1 test (returns fixed response with `stopReason: "stop"`, empty `toolCalls`)
- `mockClientSequence` — 2 tests (in-order responses; repeats last when exhausted)

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

`packages/agent-runtime/src/spec-pipeline-helpers.ts` only imports from sibling modules inside `agent-runtime/src`:

- `import type { ModelClient, ModelResponse } from "./types.js"`
- `import type { ExplorerResult, SpecDraft, SpecKeyDecision } from "./spec-types.js"`

No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `@focuscode/persistence`, `@focuscode/sdk`, `@focuscode/auth`, `@focuscode/ecosystem`, `@focuscode/sandbox`, `@focuscode/tui`, `/apps/`) are present. No external npm packages, no `node:fs`, no `node:child_process`, no `fetch(`.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-pipeline-helpers.ts packages/agent-runtime/test/spec-pipeline-helpers.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

An initial `prettier --write` was required on both files. Prettier wrapped two long lines to respect `printWidth: 100`:

1. In the test file, the `constraints` array entry and the `taskBreakdown` entry in the `fallbackEnhance` draft fixture were each inlined on one line exceeding 100 chars; prettier expanded them to multi-line object literals.
2. In the implementation, the final `lines.push("Begin working on the tasks above. Verify each acceptance criterion before claiming completion.")` call exceeded 100 chars; prettier wrapped it across multiple lines.

After re-running `pnpm build && npx vitest run`, all 10 tests still pass and the format check is clean.

## Self-review notes

### TDD RED step verified

Unlike Task 1 (type-only module, where the test passed even without the source file because `import type` is erased at runtime), Task 2's test imports **runtime values** (`parseJsonResponse`, `emptyExplorerResult`, etc.) from `../src/spec-pipeline-helpers.js`. The RED step failed correctly and for the expected reason:

```
Error: Cannot find module '../src/spec-pipeline-helpers.js' imported from
.../packages/agent-runtime/test/spec-pipeline-helpers.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

This confirms the test actually exercises the implementation (not just type-checks). After writing the implementation, the same command produced 10/10 passing — a true RED → GREEN transition.

### Deviation from plan (intentional cleanup)

The plan's implementation code listed:

```typescript
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";
```

`ModelRequest` is imported but never used anywhere in the helper module (the `mockClient` / `mockClientSequence` `complete()` methods omit the `request` parameter entirely, which is valid TS). Since `tsconfig.base.json` does not set `noUnusedLocals`, the build would pass with the unused import. However, to keep the implementation minimal and avoid a dangling import, I removed `ModelRequest`:

```typescript
import type { ModelClient, ModelResponse } from "./types.js";
```

This is a strict subset of the plan's imports and changes no behavior. `pnpm build` succeeds (exit code 0).

### Type correctness verification

The implementation compiles cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true` — the regex match group `fenceMatch[1]` is accessed with `!` (non-null assertion) only inside the `fenceMatch ?` truthy branch, which is sound; `responses[idx]!` is guarded by `Math.min(i, responses.length - 1)` ensuring `idx` is always a valid index.
- `exactOptionalPropertyTypes: true` — the returned `ModelResponse` objects only include required fields (`content`, `stopReason`, `toolCalls`, `usage`); optional fields like `reasoning` / `providerState` / `systemFingerprint` are omitted entirely, which is correct under this flag.
- `verbatimModuleSyntax: true` — all type-only imports use `import type`.
- `isolatedModules: true`

### `mockClient` / `mockClientSequence` parameter omission

Both mock factories implement `ModelClient` whose `complete` signature is `complete(request: ModelRequest, onEvent?: ...): Promise<ModelResponse>`. The mock implementations declare `async complete(): Promise<ModelResponse>` — omitting both parameters. TypeScript permits this: a method implementation may have fewer parameters than the interface it satisfies. The mocks intentionally ignore the request and event callback since they return canned responses. This matches the plan exactly.

## Concerns

1. **Test utilities exported from `src/`.** `mockClient` and `mockClientSequence` are test helpers but live in `packages/agent-runtime/src/spec-pipeline-helpers.ts` (a `src/` file) and are therefore compiled into `dist/spec-pipeline-helpers.js`. They are exported so test files can import them via `../src/spec-pipeline-helpers.js`. This is the plan's explicit design ("Test utilities (exported for test files)"). A side effect is that they become part of the package's compiled output; since `packages/agent-runtime/package.json` only exposes `dist/index.js` as the public entry point and `index.ts` does not re-export these helpers, they are not part of the package's public API surface — but they do ship in `dist/`. If this is undesirable, a later task could move them to a `test/`-only utility module; I did not deviate from the plan here.

2. **`parseJsonResponse` uses `JSON.parse` without schema validation.** It returns `T | null` with a bare `as T` cast. Callers are responsible for validating the parsed shape against any expected schema. This is intentional per the plan (the comment says "caller decides retry/fallback") and is appropriate for a pipeline helper; downstream stages should validate before consuming.

3. **`fallbackEnhance` output format is implicitly contractual.** The test asserts on substrings (`## Objective`, `## Constraints`, `## Acceptance Criteria`, `## Execution Order`, `t1: implement`). The plan notes this format "matches the enhancer's expected output format so the downstream tool loop is unaffected." If the enhancer stage (a later task) produces a different format, `fallbackEnhance` will need to be kept in sync. This coupling is by design but worth flagging.

4. **Plan's commit step skipped.** The task constraints say "NEVER commit changes unless explicitly instructed." The plan's Step 5 included a `git commit`, which I did not run. The parent agent / user can commit if desired.
