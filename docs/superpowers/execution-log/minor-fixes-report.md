# SpecEngine Minor Fixes Report

> **Date:** 2026-07-23
> **Plan:** `docs/superpowers/plans/2026-07-23-spec-engine-minor-fixes.md`
> **Goal:** Resolve 9 deferred Minor findings (M1, M2, M4, M5, M8, M9, M12, M15, M16) from the SpecEngine final review.
> **Method:** TDD (write failing test → verify RED → implement → verify GREEN → boundary check → prettier check).

## Summary

| Task       | Finding(s) | Status  | Tests Added | Verification                     |
| ---------- | ---------- | ------- | ----------- | -------------------------------- |
| Task 1     | M1, M16    | ✅ DONE | 2 passed    | boundary + prettier PASS         |
| Task 2     | M2, M4     | ✅ DONE | 2 passed    | boundary + prettier PASS         |
| Task 3     | M5         | ✅ DONE | 1 passed    | boundary + prettier PASS         |
| Task 4     | M8         | ✅ DONE | 1 passed    | boundary + prettier PASS         |
| Task 5     | M9, M12    | ✅ DONE | 2 passed    | boundary + prettier PASS         |
| Task 6     | M15        | ✅ DONE | 1 passed    | prettier PASS                    |
| **Task 7** | —          | ✅ DONE | Full suite  | 428 passed, 10 skipped, 0 failed |

**Total findings resolved:** 9/9 Minor findings fixed.
**Accept findings (no action):** 7 (M3, M6, M7, M10, M11, M13, M14).

---

## Task Details

### Task 1: M1 + M16 — eventSink type tightening + mockClient API leak

**Findings:**

- **M1:** `SpecClarifyInput.eventSink` was typed `(event: unknown) => void | Promise<void>` but the design doc specifies `AgentEvent`. Prevents type-safe narrowing in callbacks.
- **M16:** `index.ts` used `export * from "./spec-pipeline-helpers.js"`, leaking test utilities (`mockClient`, `mockClientSequence`) into the public API.

**Files modified:**

- `packages/agent-runtime/src/spec-types.ts` (line 118: `unknown` → `AgentEvent`)
- `packages/agent-runtime/src/index.ts` (lines 34-38: replaced `export *` with named exports of `parseJsonResponse`, `emptyExplorerResult`, `fallbackEnhance`)

**Test files:**

- `packages/agent-runtime/test/spec-types.test.ts` — verifies `eventSink` accepts `AgentEvent`-typed callback with type narrowing on `event.type`.
- `packages/agent-runtime/test/spec-exports.test.ts` — verifies `mockClient`/`mockClientSequence` are NOT exported from public API, while production helpers ARE.

**Changes:**

```typescript
// spec-types.ts (M1)
eventSink?: (event: AgentEvent) => void | Promise<void>;

// index.ts (M16)
export {
  parseJsonResponse,
  emptyExplorerResult,
  fallbackEnhance,
} from "./spec-pipeline-helpers.js";
```

**Test results:** 2/2 passed.
**Deviations from plan:** M1 was already partially fixed (AgentEvent was imported). Only the type annotation needed updating.

---

### Task 2: M2 + M4 — mockClientSequence guard + fallbackEnhance decisions branch

**Findings:**

- **M2:** `mockClientSequence([])` returned `content: undefined` because `responses[-1]!` only silenced TypeScript. No clear error for callers.
- **M4:** `fallbackEnhance`'s `## Confirmed Decisions` branch (`if (d.chosen)`) was never exercised by tests — tests always passed `[]` for decisions.

**Files modified:**

- `packages/agent-runtime/src/spec-pipeline-helpers.ts` (added empty-array guard at start of `mockClientSequence`'s `complete` function)

**Test files:**

- `packages/agent-runtime/test/spec-pipeline-helpers.test.ts` — M2: verifies `mockClientSequence([])` throws a clear error matching `/mockClientSequence.*empty|no responses/i`; M4: verifies `fallbackEnhance` emits `## Confirmed Decisions` section when decisions have `chosen` set.

**Changes:**

```typescript
// spec-pipeline-helpers.ts (M2)
async complete(): Promise<ModelResponse> {
  if (responses.length === 0) {
    throw new Error("mockClientSequence: response array is empty — no responses to return");
  }
  // ...
}
```

**Test results:** 2/2 passed.
**Deviations from plan:** M4 required no production code change — `fallbackEnhance` already had the branch; only the missing test was added.

---

### Task 3: M5 — explorer abort signal propagation

**Finding:**

- **M5:** `exploreCodebase` accepted an optional `AbortSignal` but did not pass it to `tool.execute()`. Slow read-only tools couldn't be interrupted mid-execution.

**Files modified:**

- `packages/agent-runtime/src/spec-explorer.ts` (propagated `params.signal` to `tool.execute` via `ToolExecutionContext`)

**Test files:**

- `packages/agent-runtime/test/spec-explorer.test.ts` — uses a mock tool that records whether it received the signal; asserts the same signal passed to `exploreCodebase` reaches `tool.execute`.

**Changes:**

```typescript
// spec-explorer.ts (M5)
const result = await tool.execute(call.arguments, {
  cwd: params.cwd,
  ...(params.signal ? { signal: params.signal } : {}),
});
```

**Test results:** 1/1 passed.
**Deviations from plan:** None. Confirmed that `AgentTool.execute` accepts `AbortSignal` via `ToolExecutionContext`, so the signal could be propagated directly without reclassifying as Accept.

---

### Task 4: M8 — ## Confirmed Decisions format unification

**Finding:**

- **M8:** `fallbackEnhance` emitted a `## Confirmed Decisions` section but `enhancePrompt`'s `SYSTEM_PROMPT` did not instruct the model to emit the same section. Downstream tool loop saw different format on fallback vs happy path.

**Files modified:**

- `packages/agent-runtime/src/spec-enhancer.ts` (added `## Confirmed Decisions` section to `SYSTEM_PROMPT` format instructions)

**Test files:**

- `packages/agent-runtime/test/spec-enhancer.test.ts` — captures the system prompt sent to the model and asserts it contains `## Confirmed Decisions`; also verifies `fallbackEnhance` emits the same header (format parity).

**Changes:**

```
// spec-enhancer.ts SYSTEM_PROMPT (M8) — added section:
## Confirmed Decisions
- <decision point>: <chosen option>
- <decision point>: <chosen option>
```

**Test results:** 1/1 passed.
**Deviations from plan:** Chose to add the section to the enhancer (more information is better) rather than removing it from `fallbackEnhance`, matching the plan's preferred approach.

---

### Task 5: M9 + M12 — parseFrontmatter updatedAt + filename slugification

**Findings:**

- **M9:** `parseFrontmatter` extracted `id`, `topic`, `createdAt`, `status`, `trigger` but not `updatedAt`. Loaded docs had `updatedAt === createdAt`.
- **M12:** `resolveFilename` used the topic directly in the filename without slugification. Topics with spaces produced awkward filenames like `My Topic-spec-abc123.md`.

**Files modified:**

- `packages/agent-runtime/src/spec-store.ts` (M9: `parseFrontmatter` now extracts `updatedAt` with fallback to `createdAt`; M12: added `slugify` helper and used it in `resolveFilename`)

**Test files:**

- `packages/agent-runtime/test/spec-store.test.ts` — M9: saves a doc with distinct `updatedAt`, loads it, asserts `updatedAt` is preserved and not equal to `createdAt`; M12: saves a doc with topic `"My Complex Topic With Spaces!"`, asserts the filename contains `my-complex-topic-with-spaces` and no spaces.

**Changes:**

```typescript
// spec-store.ts (M12)
function slugify(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "untitled"
  );
}

// spec-store.ts resolveFilename (M12)
const topic = slugify(doc.topic);

// spec-store.ts parseFrontmatter (M9)
updatedAt: map.updatedAt ?? map.createdAt,
```

**Test results:** 2/2 passed.
**Deviations from plan:** M9 was already partially implemented (`parseFrontmatter` already extracted `updatedAt` with fallback). Only a test was needed to verify correct extraction. The `slugify` helper was added for M12 as planned.

---

### Task 6: M15 — integration test enhanced prompt verification

**Finding:**

- **M15:** Test #3 (`result.content === "done"`) didn't verify the enhanced prompt reached the model. The mock returned "done" regardless of input, so the test would pass even if the enhanced prompt was swallowed by the pipeline.

**Files modified:**

- `packages/agent-runtime/test/spec-engine-integration.test.ts` (replaced simple mock with a recording mock that captures messages sent to the model; added assertions on the captured user message content)

**Changes:**

```typescript
// spec-engine-integration.test.ts (M15)
const capturedMessages: AgentMessage[] = [];
const recordingClient = {
  protocol: "openai-chat",
  async complete(request: { messages: AgentMessage[] }): Promise<ModelResponse> {
    capturedMessages.push(...request.messages);
    return {
      content: "done",
      stopReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};
// ... after submit():
const userMessages = capturedMessages.filter((m) => m.role === "user");
const lastUserMessage = userMessages.at(-1);
expect(lastUserMessage!.content).toContain("implement test feature");
```

**Test results:** 1/1 passed.
**Deviations from plan:** Removed `totalTokens` from the mock `usage` object because it is not part of the `TokenUsage` interface (type error). The recording mock captures all messages and verifies the enhanced prompt content (`"implement test feature"`) appears in the last user message sent to the main model.

---

## Final Verification (Task 7)

### Step 1: Full agent-runtime test suite

Command: `pnpm build && npx vitest run packages/agent-runtime/`

Result: **PASS**

```
Test Files  50 passed | 1 skipped (51)
     Tests  428 passed | 10 skipped (438)
  Duration  13.65s
```

- 0 failures.
- 10 skipped tests are in `live-providers.test.ts` (require real API keys; skipped by design).

### Step 2: Architecture boundary check

Command: `node scripts/check-boundaries.mjs`

Result: **PASS**

```
Architecture boundary check passed.
```

### Step 3: Prettier check on all modified files

Command: `npx prettier --check` on 13 modified files (6 source + 7 test).

Result: **PASS**

```
All matched files use Prettier code style!
```

---

## Modified Files Summary

**Source files (6):**

1. `packages/agent-runtime/src/spec-types.ts` — M1: eventSink type `unknown` → `AgentEvent`
2. `packages/agent-runtime/src/index.ts` — M16: replaced `export *` with named exports
3. `packages/agent-runtime/src/spec-pipeline-helpers.ts` — M2: empty-array guard in `mockClientSequence`
4. `packages/agent-runtime/src/spec-explorer.ts` — M5: abort signal propagation to `tool.execute`
5. `packages/agent-runtime/src/spec-enhancer.ts` — M8: `## Confirmed Decisions` in `SYSTEM_PROMPT`
6. `packages/agent-runtime/src/spec-store.ts` — M9: `updatedAt` extraction + M12: `slugify` helper

**Test files (7):**

1. `packages/agent-runtime/test/spec-types.test.ts` — M1 test
2. `packages/agent-runtime/test/spec-exports.test.ts` — M16 test
3. `packages/agent-runtime/test/spec-pipeline-helpers.test.ts` — M2 + M4 tests
4. `packages/agent-runtime/test/spec-explorer.test.ts` — M5 test
5. `packages/agent-runtime/test/spec-enhancer.test.ts` — M8 test
6. `packages/agent-runtime/test/spec-store.test.ts` — M9 + M12 tests
7. `packages/agent-runtime/test/spec-engine-integration.test.ts` — M15 test

---

## Accept Findings (no action — 7 items)

| #   | Finding                                                  | Reason for Accept                     |
| --- | -------------------------------------------------------- | ------------------------------------- |
| M3  | `parseJsonResponse` regex anchored at `^`````            | Plan-faithful, retry path compensates |
| M6  | Explorer prompt says "glob", actual tool is "find"       | Cosmetic only, no behavioral impact   |
| M7  | Drafter throws instead of returning minimal SpecDraft    | By design, orchestrator catches       |
| M10 | `resolveFilename` unbounded `while(true)` loop           | Internal tool, low risk               |
| M11 | `list(0)` returns all specs instead of zero              | Edge case, unlikely call              |
| M13 | `needsClarification` variable scope wider than necessary | Style only                            |
| M14 | `runStageMain` accepts but voids client/profile params   | Plan-faithful, dead parameters        |

---

## Conclusion

All 9 deferred Minor findings have been resolved following TDD methodology. The SpecEngine module now has:

- Tighter type safety (M1: `AgentEvent` instead of `unknown`)
- Clean public API surface (M16: no test utility leaks)
- Clearer error messages (M2: empty mock sequence guard)
- Proper abort signal propagation (M5: tools can be interrupted)
- Consistent output format between happy path and fallback (M8: `## Confirmed Decisions`)
- Correct metadata extraction (M9: `updatedAt` preserved)
- Safe filenames (M12: slugified topics)
- Stronger integration test coverage (M15: enhanced prompt verified reaching model)
- Untested branch coverage (M4: `fallbackEnhance` decisions branch)

Full verification passes: 428 tests passed, 0 failed, boundary check PASS, prettier check PASS.
