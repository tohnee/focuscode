# SpecEngine Minor Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-v6-subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 9 deferred Minor findings from the SpecEngine final review.

**Architecture:** Localized fixes to existing SpecEngine files — no new modules, no architectural changes.

**Tech Stack:** TypeScript ESM, vitest, prettier, check-boundaries.mjs

## Global Constraints

- TypeScript strict mode: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`
- No external npm packages in agent-runtime
- No `node:fs`, `node:child_process`, `fetch(` in agent-runtime source
- Prettier: printWidth 100, double quotes, semicolon, trailing comma "all"
- Build before test: `pnpm build` required before `npx vitest run`
- Boundary check must pass: `node scripts/check-boundaries.mjs`

## Findings Triage (from final-review.md)

**Defer (will fix — 9 items):** M1, M2, M4, M5, M8, M9, M12, M15, M16
**Accept (no action — 7 items):** M3, M6, M7, M10, M11, M13, M14

---

### Task 1: Fix M1 — eventSink type tightening + M16 — mockClient API leak

**Files:**

- Modify: `packages/agent-runtime/src/spec-types.ts` (M1: line 112, `unknown` → `AgentEvent`)
- Modify: `packages/agent-runtime/src/index.ts` (M16: replace `export *` from spec-pipeline-helpers with named exports)
- Test: `packages/agent-runtime/test/spec-types.test.ts` (verify eventSink type)
- Test: `packages/agent-runtime/test/spec-exports.test.ts` (verify mockClient not in public API)

**Interfaces:**

- Consumes: `AgentEvent` from `./types.js`
- Produces: tightened `SpecClarifyInput.eventSink` type; clean public API surface

**M1 context:** `SpecClarifyInput.eventSink` is `(event: unknown) => void | Promise<void>` but spec design doc says `AgentEvent`. `AgentEvent` is already imported in spec-types.ts (added in Task 1 fix wave). One-line change.

**M16 context:** `index.ts` line 34 does `export * from "./spec-pipeline-helpers.js"` which leaks `mockClient` and `mockClientSequence` (test utilities) into the public API. Replace with named exports of production helpers only: `parseJsonResponse`, `emptyExplorerResult`, `fallbackEnhance`. Keep `mockClient`/`mockClientSequence` as internal (not exported from index.ts). They remain accessible via direct import from `spec-pipeline-helpers.js` in tests.

- [ ] **Step 1: Write failing test for M1**

In `spec-types.test.ts`, add a test that constructs a `SpecClarifyInput` with a typed `eventSink` callback that narrows on `event.type`:

```typescript
test("SpecClarifyInput.eventSink accepts AgentEvent-typed callback", () => {
  const input: SpecClarifyInput = {
    prompt: "test",
    cwd: "/tmp",
    sessionBranch: [],
    modelClient: {} as ModelClient,
    model: { provider: "test", model: "test" },
    toolRegistry: {} as AgentToolRegistry,
    eventSink: (event: AgentEvent) => {
      if (event.type === "spec_start") {
        // Type narrowing must work — this would fail to compile if eventSink were `unknown`
        void event.input;
      }
    },
  };
  expect(typeof input.eventSink).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-types.test.ts`
Expected: The test may pass at runtime (type-only), but `tsc` build should succeed. The real validation is that `eventSink`'s type is `AgentEvent` not `unknown`. Verify via `tsc` that narrowing works.

- [ ] **Step 3: Fix M1 — change eventSink type**

In `spec-types.ts` line 112, change:

```typescript
eventSink?: (event: unknown) => void | Promise<void>;
```

to:

```typescript
eventSink?: (event: AgentEvent) => void | Promise<void>;
```

`AgentEvent` should already be in the import list (from Task 1 fix wave). Verify.

- [ ] **Step 4: Fix M16 — replace export * with named exports**

In `index.ts`, replace:

```typescript
export * from "./spec-pipeline-helpers.js";
```

with:

```typescript
export {
  parseJsonResponse,
  emptyExplorerResult,
  fallbackEnhance,
} from "./spec-pipeline-helpers.js";
```

- [ ] **Step 5: Write failing test for M16**

In `spec-exports.test.ts`, add a test verifying `mockClient` is NOT in the public API:

```typescript
test("mockClient and mockClientSequence are not exported from public API (M16)", async () => {
  const mod = await import("../src/index.js");
  expect("mockClient" in mod).toBe(false);
  expect("mockClientSequence" in mod).toBe(false);
  expect("parseJsonResponse" in mod).toBe(true);
  expect("emptyExplorerResult" in mod).toBe(true);
  expect("fallbackEnhance" in mod).toBe(true);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-types.test.ts packages/agent-runtime/test/spec-exports.test.ts`
Expected: PASS

- [ ] **Step 7: Boundary + format check**

Run: `node scripts/check-boundaries.mjs && npx prettier --check packages/agent-runtime/src/spec-types.ts packages/agent-runtime/src/index.ts`
Expected: PASS

---

### Task 2: Fix M2 — mockClientSequence empty-array guard + M4 — fallbackEnhance decisions branch test

**Files:**

- Modify: `packages/agent-runtime/src/spec-pipeline-helpers.ts` (M2: add empty-array guard to `mockClientSequence`)
- Test: `packages/agent-runtime/test/spec-pipeline-helpers.test.ts` (M2: empty-array test; M4: decisions branch test)

**M2 context:** `mockClientSequence([])` returns `content: undefined` because `responses[-1]!` only silences TS. Add a guard that throws a clear error when the sequence is exhausted.

**M4 context:** `fallbackEnhance` has a `## Confirmed Decisions` branch (`if (d.chosen)`) that is never tested because tests pass `[]` for decisions. Add a test with decisions that have `chosen` set.

- [ ] **Step 1: Write failing test for M2**

```typescript
test("mockClientSequence throws clear error when response array is empty (M2)", async () => {
  const client = mockClientSequence([]);
  await expect(client.complete({ messages: [], model: "test" })).rejects.toThrow(
    /mockClientSequence.*empty|no responses/i,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-pipeline-helpers.test.ts`
Expected: FAIL (current behavior returns undefined content, doesn't throw)

- [ ] **Step 3: Fix M2 — add guard**

In `spec-pipeline-helpers.ts`, in `mockClientSequence`, add at the start of the returned `complete` function:

```typescript
if (responses.length === 0) {
  throw new Error("mockClientSequence: response array is empty — no responses to return");
}
```

- [ ] **Step 4: Write test for M4 — fallbackEnhance decisions branch**

```typescript
test("fallbackEnhance includes Confirmed Decisions section when decisions have chosen (M4)", () => {
  const draft: SpecDraft = {
    id: "spec-test",
    topic: "Test Topic",
    understanding: {
      summary: "Test summary",
      entities: [],
      assumptions: [],
      constraints: [],
      ambiguities: [],
    },
    taskBreakdown: [],
  };
  const decisions: SpecKeyDecision[] = [
    {
      id: "dec1",
      question: "Which library?",
      severity: "minor",
      options: [{ label: "Option A" }, { label: "Option B" }],
      chosen: "Option A",
    },
  ];
  const result = fallbackEnhance(draft, decisions);
  expect(result).toContain("## Confirmed Decisions");
  expect(result).toContain("Option A");
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-pipeline-helpers.test.ts`
Expected: PASS (M2 guard works, M4 test passes — `fallbackEnhance` already has the branch, just untested)

- [ ] **Step 6: Boundary + format check**

Run: `node scripts/check-boundaries.mjs && npx prettier --check packages/agent-runtime/src/spec-pipeline-helpers.ts`
Expected: PASS

---

### Task 3: Fix M5 — explorer abort signal propagation

**Files:**

- Modify: `packages/agent-runtime/src/spec-explorer.ts` (M5: propagate abort signal to `tool.execute()`)
- Test: `packages/agent-runtime/test/spec-explorer.test.ts`

**M5 context:** `exploreCodebase` accepts an optional `signal` but does not pass it to `tool.execute()`. Slow read-only tools can't be interrupted mid-execution. Pass `signal` to the tool execution call.

- [ ] **Step 1: Read spec-explorer.ts to find the tool.execute() call site**

Read `packages/agent-runtime/src/spec-explorer.ts` and locate where `tool.execute()` is called. Check the `AgentTool.execute` signature to see if it accepts an `AbortSignal`.

- [ ] **Step 2: Write failing test for M5**

Write a test that verifies the abort signal is passed to tool execution. Use a mock tool that records whether it received the signal:

```typescript
test("exploreCodebase propagates abort signal to tool.execute (M5)", async () => {
  let receivedSignal: AbortSignal | undefined;
  const mockTool: AgentTool = {
    name: "read",
    description: "mock read",
    inputSchema: { type: "object", properties: {} },
    execute: async (_input: unknown, signal?: AbortSignal) => {
      receivedSignal = signal;
      return { ok: true, result: "mock content" };
    },
  };
  // ... setup registry with mockTool, call exploreCodebase with a signal
  // assert receivedSignal is the same signal passed to exploreCodebase
});
```

Note: Check the actual `AgentTool.execute` signature first — if it doesn't accept a signal parameter, this finding may need to be reclassified as Accept (can't fix without changing the tool interface).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-explorer.test.ts`
Expected: FAIL (signal not propagated)

- [ ] **Step 4: Fix M5 — propagate signal**

In `spec-explorer.ts`, pass `signal` to the `tool.execute()` call. If `AgentTool.execute` doesn't accept a signal, document this as a limitation and check the signal before tool execution instead (abort check point).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-explorer.test.ts`
Expected: PASS

- [ ] **Step 6: Boundary + format check**

Run: `node scripts/check-boundaries.mjs && npx prettier --check packages/agent-runtime/src/spec-explorer.ts`
Expected: PASS

---

### Task 4: Fix M8 — ## Confirmed Decisions format unification

**Files:**

- Modify: `packages/agent-runtime/src/spec-enhancer.ts` (M8: align format with `fallbackEnhance`)
- Modify: `packages/agent-runtime/src/spec-pipeline-helpers.ts` (M8: canonicalize `fallbackEnhance` format if needed)
- Test: `packages/agent-runtime/test/spec-enhancer.test.ts`

**M8 context:** `fallbackEnhance` emits a `## Confirmed Decisions` section but `enhancePrompt`'s `SYSTEM_PROMPT` does not instruct the model to emit the same section. This means downstream tool loop sees different format on fallback vs happy path. Fix: add `## Confirmed Decisions` to the enhancer's SYSTEM_PROMPT instructions, OR remove it from `fallbackEnhance` to match the enhancer. Prefer adding to enhancer (more information is better).

- [ ] **Step 1: Read both files to compare formats**

Read `spec-enhancer.ts` (SYSTEM_PROMPT) and `spec-pipeline-helpers.ts` (`fallbackEnhance`) to identify the exact format divergence.

- [ ] **Step 2: Write failing test for M8**

Write a test that verifies both `enhancePrompt` (when model returns a well-formed response) and `fallbackEnhance` produce output with `## Confirmed Decisions` section when decisions have `chosen`:

```typescript
test("enhancePrompt and fallbackEnhance both emit ## Confirmed Decisions when decisions have chosen (M8)", async () => {
  const decisions: SpecKeyDecision[] = [
    { id: "d1", question: "Q", severity: "minor", options: [{ label: "A" }], chosen: "A" },
  ];
  // Test fallbackEnhance
  const fallbackResult = fallbackEnhance(draft, decisions);
  expect(fallbackResult).toContain("## Confirmed Decisions");
  // Test enhancePrompt (with mock that returns a response containing the section)
  const enhancedResult = await enhancePrompt(mockClient, profile, {
    draft,
    confirmedDecisions: decisions,
  });
  expect(enhancedResult).toContain("## Confirmed Decisions");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-enhancer.test.ts`
Expected: FAIL (enhancePrompt doesn't emit `## Confirmed Decisions`)

- [ ] **Step 4: Fix M8 — add Confirmed Decisions to enhancer SYSTEM_PROMPT**

In `spec-enhancer.ts`, update the `SYSTEM_PROMPT` to instruct the model to include a `## Confirmed Decisions` section when `confirmedDecisions` have `chosen` values. Match the format used by `fallbackEnhance`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-enhancer.test.ts`
Expected: PASS

- [ ] **Step 6: Boundary + format check**

Run: `node scripts/check-boundaries.mjs && npx prettier --check packages/agent-runtime/src/spec-enhancer.ts`
Expected: PASS

---

### Task 5: Fix M9 — parseFrontmatter updatedAt extraction + M12 — filename slugification

**Files:**

- Modify: `packages/agent-runtime/src/spec-store.ts` (M9: extract `updatedAt` in `parseFrontmatter`; M12: slugify topic in `resolveFilename`)
- Test: `packages/agent-runtime/test/spec-store.test.ts`

**M9 context:** `parseFrontmatter` extracts `id`, `topic`, `createdAt`, `status`, `trigger` but not `updatedAt`. Loaded docs have `updatedAt === createdAt`. Fix: extract `updatedAt` from frontmatter.

**M12 context:** `resolveFilename` uses the topic directly in the filename without slugification. Topics with spaces produce awkward filenames like `My Topic-spec-abc123.md`. Fix: slugify the topic (lowercase, replace spaces/special chars with hyphens, limit length).

- [ ] **Step 1: Write failing test for M9**

```typescript
test("parseFrontmatter extracts updatedAt field (M9)", async () => {
  // Save a doc, then load it, verify updatedAt is the saved value not createdAt
  const doc = createTestDoc({ updatedAt: "2026-07-23T12:00:00.000Z" });
  await store.save(doc);
  const loaded = await store.load(doc.id);
  expect(loaded?.updatedAt).toBe("2026-07-23T12:00:00.000Z");
  expect(loaded?.updatedAt).not.toBe(loaded?.createdAt);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-store.test.ts`
Expected: FAIL (updatedAt equals createdAt)

- [ ] **Step 3: Fix M9 — extract updatedAt**

In `spec-store.ts` `parseFrontmatter` method, add `updatedAt` extraction:

```typescript
updatedAt: frontmatter.updatedAt ?? frontmatter.createdAt,
```

- [ ] **Step 4: Write failing test for M12**

```typescript
test("resolveFilename slugifies topic (M12)", async () => {
  const doc = createTestDoc({ topic: "My Complex Topic With Spaces!" });
  const path = await store.save(doc);
  expect(path).toMatch(/my-complex-topic-with-spaces/);
  expect(path).not.toContain("My Complex Topic With Spaces!");
});
```

- [ ] **Step 5: Fix M12 — add slugify helper**

In `spec-store.ts`, add a `slugify` helper function and use it in `resolveFilename`:

```typescript
function slugify(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "untitled"
  );
}
```

Use `slugify(doc.topic)` instead of `doc.topic` in the filename template.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-store.test.ts`
Expected: PASS

- [ ] **Step 7: Boundary + format check**

Run: `node scripts/check-boundaries.mjs && npx prettier --check packages/agent-runtime/src/spec-store.ts`
Expected: PASS

---

### Task 6: Fix M15 — integration test enhanced prompt verification

**Files:**

- Modify: `packages/agent-runtime/test/spec-engine-integration.test.ts` (M15: verify enhanced prompt reaches the model)

**M15 context:** Test #3 (`result.content === "done"`) doesn't verify the enhanced prompt reached the model. The mock returns "done" regardless of input. Fix: use `mockClientSequence` or a recording mock that captures the messages sent to the model, then assert the enhanced prompt content is in the messages.

- [ ] **Step 1: Read the current Test #3**

Read `spec-engine-integration.test.ts` to find the test that asserts `result.content === "done"`.

- [ ] **Step 2: Rewrite the test to verify enhanced prompt**

Replace the simple mock with a recording mock that captures the messages array:

```typescript
test("submit() passes enhanced prompt to model when SpecEngine applies (M15)", async () => {
  let capturedMessages: AgentMessage[] | undefined;
  const recordingClient: ModelClient = {
    complete: async (input: { messages: AgentMessage[] }) => {
      capturedMessages = input.messages;
      return {
        content: "done",
        role: "assistant",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  // ... setup agent with SpecEngine enabled and recordingClient
  // ... call submit() with a prompt that triggers SpecEngine
  // ... assert capturedMessages contains the enhanced prompt content
  expect(capturedMessages).toBeDefined();
  const lastUserMessage = capturedMessages?.findLast((m) => m.role === "user");
  expect(lastUserMessage?.content).toContain(/* enhanced prompt marker */);
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/spec-engine-integration.test.ts`
Expected: PASS

- [ ] **Step 4: Format check**

Run: `npx prettier --check packages/agent-runtime/test/spec-engine-integration.test.ts`
Expected: PASS

---

### Task 7: Full suite verification

- [ ] **Step 1: Run full agent-runtime test suite**

Run: `pnpm build && npx vitest run packages/agent-runtime/`
Expected: All tests pass (101 SpecEngine + 320 existing = 421+ passed, 10 skipped, 0 failed)

- [ ] **Step 2: Run boundary check**

Run: `node scripts/check-boundaries.mjs`
Expected: PASS

- [ ] **Step 3: Run prettier check on all modified files**

Run: `npx prettier --check packages/agent-runtime/src/spec-types.ts packages/agent-runtime/src/spec-pipeline-helpers.ts packages/agent-runtime/src/spec-explorer.ts packages/agent-runtime/src/spec-enhancer.ts packages/agent-runtime/src/spec-store.ts packages/agent-runtime/src/index.ts packages/agent-runtime/test/spec-types.test.ts packages/agent-runtime/test/spec-pipeline-helpers.test.ts packages/agent-runtime/test/spec-explorer.test.ts packages/agent-runtime/test/spec-enhancer.test.ts packages/agent-runtime/test/spec-store.test.ts packages/agent-runtime/test/spec-engine-integration.test.ts packages/agent-runtime/test/spec-exports.test.ts`
Expected: PASS

---

## Accept Findings (no action needed — 7 items)

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

## Self-Review

**1. Spec coverage:** All 9 deferred Minor findings (M1, M2, M4, M5, M8, M9, M12, M15, M16) have corresponding tasks. The 7 Accept findings are documented as accepted.

**2. Placeholder scan:** No placeholders — each step has concrete code or commands.

**3. Type consistency:** All type references match the existing SpecEngine codebase (AgentEvent, SpecDraft, SpecKeyDecision, ModelClient, AgentTool, AgentToolRegistry).

**4. Task dependencies:** Tasks 1-6 are independent (different files). Task 7 is final verification. Can be executed in any order for Tasks 1-6.

**5. Risk assessment:** All fixes are localized (< 20 LOC each). No architectural changes. No new dependencies. All fixes are additive or type-tightening.
