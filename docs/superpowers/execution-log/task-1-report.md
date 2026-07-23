# Task 1 Report: SpecEngine Type Definitions

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-types.ts` — type definitions for the SpecEngine pipeline (interfaces, types, discriminated unions; no runtime code)
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-types.test.ts` — 8 vitest tests exercising the type contracts

## Test results

Command: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/spec-types.test.ts`

- Test Files: 1 passed (1)
- Tests: 8 passed (8), 0 failed
- Duration: ~120ms

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

The new file `packages/agent-runtime/src/spec-types.ts` only imports from sibling modules inside `agent-runtime/src` (`./types.js` and `./tools.js`) using `import type`. No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `node:fs`, etc.) are present.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-types.ts packages/agent-runtime/test/spec-types.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

(Note: an initial `prettier --write` was required on `spec-types.ts` to fix minor formatting; the test file was already correctly formatted.)

## Self-review notes

### Deviation from plan (intentional fix)

The plan's implementation code listed:

```typescript
import type {
  AgentAttachment,
  AgentMessage,
  AgentToolRegistry,
  ModelClient,
  ModelProfile,
} from "./types.js";
```

This is incorrect: `AgentToolRegistry` is exported as a class from `./tools.ts`, not from `./types.ts`. Importing it from `./types.js` would fail TypeScript compilation under `pnpm build`. I split the import into two statements:

```typescript
import type { AgentAttachment, AgentMessage, ModelClient, ModelProfile } from "./types.js";
import type { AgentToolRegistry } from "./tools.js";
```

This was verified by `pnpm --filter @focuscode/agent-runtime build` succeeding (exit code 0). Without this fix, `tsc` would have errored with `Module '"./types.js"' has no exported member 'AgentToolRegistry'`.

### TDD RED step observation

The plan expected the test to FAIL before implementation with `Cannot find module '../src/spec-types.js'`. In practice, the test passed even without the source file existing. This is because:

1. The test uses `import type { ... }` which is erased at runtime by esbuild/rollup before module resolution.
2. `vitest.config.ts` does not enable `typecheck.enabled`, so vitest only runs runtime assertions.
3. `packages/agent-runtime/tsconfig.json` only includes `src/**/*.ts` — test files are NOT compiled by `tsc` during `pnpm build`.

The actual type validation therefore comes from `tsc` compiling the source file (`spec-types.ts` IS in `src/**/*.ts`). The real "RED→GREEN" proof for this task is: (a) `pnpm build` fails without `spec-types.ts` existing (if anything actually imports it from `src/`) and (b) `pnpm build` succeeds once `spec-types.ts` is created with the correct types. Since nothing in `src/` imports `spec-types.ts` yet (this is Task 1 of N), the build would pass either way — the meaningful validation is that the source file compiles cleanly under strict mode and the test runtime assertions all hold.

This is a known characteristic of type-only modules in this repo's toolchain, not a defect. Subsequent tasks that import these types from `src/` will fail `pnpm build` if the types are wrong.

### Type correctness verification

All 21 exported types from the plan are present and compile cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `verbatimModuleSyntax: true` (hence `import type` for all type-only imports)
- `isolatedModules: true`

The discriminated union `SpecClarifyResult` (skip/abort/apply) and all literal-union fields (`SpecStatus`, `SpecTrigger`, `SpecStageTrace.name`, etc.) match the test expectations exactly.

## Concerns

1. **No runtime code to test.** Since `spec-types.ts` contains only type definitions, the vitest tests only validate that TypeScript accepts the test fixtures as valid instances of the types (at compile time, via esbuild's transform) and that the runtime assertions on plain JS values hold. The tests do NOT execute any SpecEngine logic. This is expected for a types-only task but means true type-safety validation depends on `tsc` compiling downstream consumers in later tasks.

2. **`SpecStore` and `SpecEngineDeps` are forward references.** These interfaces are defined per the plan but not yet exercised by any test. They will be consumed by later tasks (Store implementation, dependency injection). Their shapes are taken verbatim from the plan and should be revisited if the implementing tasks reveal signature mismatches.

3. **`eventSink?: (event: unknown) => void | Promise<void>` uses `unknown`.** The plan specifies `unknown` rather than a concrete `AgentEvent` type. This is intentionally loose to decouple the SpecEngine pipeline from the agent event stream shape, but later tasks may want to tighten this to `AgentEvent` (or a SpecEngine-specific event subset) once the event flow is concrete.

4. **Plan's commit step skipped.** The task description says "NEVER commit changes unless explicitly instructed." The plan included a `git commit` step, but per the task constraints I did not commit. The parent agent / user can commit if desired.

## Fix: eventSink type

**Status: FIXED**

### What was changed

Resolved code-review finding (Important): `SpecClarifyInput.eventSink` in `packages/agent-runtime/src/spec-types.ts` used `unknown` as the event parameter type instead of `AgentEvent`, contradicting the spec design doc and the existing convention in `packages/agent-runtime/src/types.ts` (line 263, `AgentRuntimeOptions.eventSink`).

Changes to `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-types.ts`:

1. Added `AgentEvent` to the `import type` statement from `./types.js` (split across multiple lines by prettier to respect `printWidth: 100`):
   ```typescript
   import type {
     AgentAttachment,
     AgentEvent,
     AgentMessage,
     ModelClient,
     ModelProfile,
   } from "./types.js";
   ```
2. Tightened the `eventSink` parameter type on line 112 from `unknown` to `AgentEvent`:
   ```typescript
   eventSink?: (event: AgentEvent) => void | Promise<void>;
   ```

The property remains **optional** (`eventSink?`) to (a) match the existing `AgentRuntimeOptions.eventSink?` convention in `types.ts` and (b) preserve compatibility with the existing `spec-types.test.ts` fixture, which constructs a `SpecClarifyInput` without supplying `eventSink` (test "SpecClarifyInput has required fields for submit() integration"). The finding was specifically about the parameter type (`unknown` → `AgentEvent`), not optionality; the example signature in the fix instructions omitted the `?` but making the field required would have broken that test and diverged from the sibling type in `types.ts`. This also resolves concern #3 noted above in "Self-review notes".

### Test results

| Check      | Command                                                         | Result                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format     | `npx prettier --check packages/agent-runtime/src/spec-types.ts` | **PASS** — "All matched files use Prettier code style!" (an initial `prettier --write` was needed because adding `AgentEvent` pushed the single-line import past `printWidth: 100`; prettier reformatted it to the multi-line form shown above) |
| Build      | `pnpm build`                                                    | **PASS** — exit code 0; all 22 workspace projects compiled, including `packages/agent-runtime build: Done`                                                                                                                                      |
| Tests      | `npx vitest run packages/agent-runtime/test/spec-types.test.ts` | **PASS** — 1 file, 8 tests passed (8), 0 failed, ~120ms                                                                                                                                                                                         |
| Boundaries | `node scripts/check-boundaries.mjs`                             | **PASS** — "Architecture boundary check passed." (`spec-types.ts` still only imports from sibling modules via `import type`; `AgentEvent` originates from `./types.js` inside the same package, so no cross-boundary dependency was introduced) |

### Notes

- No other files were modified. The change is type-only; no runtime behavior is affected.
- `AgentEvent` is a discriminated union exported from `packages/agent-runtime/src/types.ts` (line 171) covering `agent_start`, `model_start`, `text_delta`, `reasoning_delta`, `tool_start`, `tool_end`, `approval_required`, etc. Consumers of `SpecClarifyInput.eventSink` now get proper narrowing on `event.type` instead of having to cast from `unknown`.
- `dist/spec-types.d.ts` was regenerated by the `pnpm build` run in this session and now reflects the `AgentEvent` signature.
