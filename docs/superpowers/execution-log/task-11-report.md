# Task 11 Report: Integrate SpecEngine into CodingAgent.submit()

**Status:** DONE

## Files Modified/Created

| File                                                          | Action   | Lines                        |
| ------------------------------------------------------------- | -------- | ---------------------------- |
| `packages/agent-runtime/src/agent.ts`                         | Modified | 1051 total (added ~45 lines) |
| `packages/agent-runtime/test/spec-engine-integration.test.ts` | Created  | 210 lines                    |

## TDD Evidence

### RED (before implementation)

After writing the test file (with 6 tests), 3 tests passed (baseline no-SpecEngine
tests) and 3 failed (the tests requiring `specEngine` option, `specEngineInstance`
getter, and the `specEngineDeps` validation):

```
Test Files  1 failed (1)
     Tests  3 failed | 3 passed (6)
```

Failures:

1. `emits spec_* events and applies enhanced prompt when SpecEngine pipeline runs` — `specEngine` option silently ignored
2. `exposes the SpecEngine instance via getter when configured` — `specEngineInstance` getter did not exist
3. `throws when specEngine option is set without specEngineDeps` — no validation in `create()`

### GREEN (after implementation)

```
Test Files  1 passed (1)
     Tests  6 passed (6)
```

All 6 tests pass.

### Full Suite Regression

```
Test Files  49 passed | 1 skipped (50)
     Tests  411 passed | 10 skipped (421)
```

Previous baseline was 405 passed + 10 skipped. The 6 new tests bring the pass
count to 411. No regressions.

## Integration Points Implemented (all 6)

1. **Import** (agent.ts lines 24-25): Added `import { SpecEngine } from "./spec-engine.js";`
   and `import type { SpecEngineOptions, SpecEngineDeps } from "./spec-types.js";`

2. **CodingAgentOptions** (agent.ts lines 110-120): Added `specEngine?: SpecEngineOptions`
   and `specEngineDeps?: SpecEngineDeps` fields with JSDoc comments.

3. **Private fields** (agent.ts lines 139-140): Added `private specEngine: SpecEngine | undefined;`
   and `private currentSpecId: string | undefined;`

4. **In `create()`** (agent.ts lines 248-253): Added validation + instantiation of
   `SpecEngine` after checkpoints setup, before `return agent;`.

5. **Getter** (agent.ts lines 261-263): Added `get specEngineInstance(): SpecEngine | undefined`.

6. **In `submit()`** (agent.ts lines 281-319): Inserted SpecEngine preprocessing block
   between prompt parsing and `if (this.running)` check. Handles `abort`, `apply`
   (enhanced prompt + initial todos), and `skip` results.

## Deviations from the Plan

1. **SessionStore class name**: The plan's test code referenced `InMemorySessionStore`
   which does not exist in this codebase. The actual in-memory session store is
   `SessionStore` constructed with `(directory, false)` for non-persistent mode.
   Fixed in the test file.

2. **`activeBranch` return type**: The plan passed `activeBranch(this.session)` directly
   to `SpecClarifyInput.sessionBranch`, but `activeBranch` returns `SessionEntry[]`
   while `sessionBranch` expects `AgentMessage[]`. Fixed by mapping:
   `activeBranch(this.session).map((e) => e.message)`.

3. **`eventSink` exactOptionalPropertyTypes**: The plan passed `eventSink: this.eventSink`
   directly, but `this.eventSink` is `... | undefined` and `exactOptionalPropertyTypes`
   forbids assigning `undefined` to an optional property. Fixed by conditional spread:
   `...(this.eventSink ? { eventSink: this.eventSink } : {})`.

4. **Expanded test coverage**: The plan's baseline test had 2 tests. Per the plan's
   instructions ("EXPAND the test file with at least one test that exercises the
   SpecEngine pipeline through submit()"), the final test file has 6 tests:
   - 2 baseline tests from the plan
   - 1 pipeline-triggering test (verifies `spec_start` + `spec_completed` events emitted,
     enhanced prompt applied, result content is "done")
   - 1 getter-present test
   - 1 getter-absent test
   - 1 missing-deps validation test

## Boundary Check Result

```
Architecture boundary check passed.
```

No forbidden tokens introduced. `agent-runtime` does not import external npm packages,
`node:fs`, `node:child_process`, or `fetch(`.

## Prettier Check Result

Initial check flagged the test file. After running `prettier --write` on the test file:

```
Checking formatting...
All matched files use Prettier code style!
```

Both `agent.ts` and `spec-engine-integration.test.ts` pass prettier.

## Test Summary

- **New tests added:** 6 (in `spec-engine-integration.test.ts`)
- **Full agent-runtime suite:** 411 passed, 10 skipped, 0 failed (49 test files passed, 1 skipped)
