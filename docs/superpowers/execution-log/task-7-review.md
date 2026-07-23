# Task 7 Review: spec-enhancer.ts

## Status: PASS WITH MINOR

## Spec Compliance

- ✅ **Requirement 1: `enhancePrompt` signature** — Implementation at `spec-enhancer.ts:47-51` is `enhancePrompt(client: ModelClient, profile: ModelProfile, params: EnhancePromptParams): Promise<string>` where `EnhancePromptParams = { draft: SpecDraft; confirmedDecisions: SpecKeyDecision[] }`. This matches the plan (`2026-07-23-spec-engine.md:2142-2146`) and design spec (`2026-07-23-spec-engine-design.md:1210`) exactly. **Note:** The review task's stated signature `(client, profile, draft, decisions, confirmations: Record<string, string>, signal?)` does NOT match the plan — the plan uses a single `params` object and has no `confirmations: Record<string, string>` or `signal` parameter. Per the review instruction "verify against plan", the implementation is correct. The `SpecEnhancedPrompt` type does not exist anywhere in the repo; return type is `Promise<string>`, consistent with the plan.
- ⚠️ **Requirement 2: 3B-7B model tier** — Cannot be verified from the implementation. `enhancePrompt` accepts any `ModelProfile` and uses `profile.model`/`profile.temperature`/`profile.maxOutputTokens` generically (lines 54, 58-59). The 3B-7B tier designation is the orchestrator's responsibility (Task 9), which selects and passes the `enhancer` profile. The design spec says "3B-7B 推荐" (recommended, line 948), not enforced in code. Tests use `model: "test-model"` (test file line 9), so the tier is not asserted at this layer.
- ✅ **Requirement 3: Text output (not JSON)** — `spec-enhancer.ts:62` returns `response.content.trim()` directly. No `parseJsonResponse` import or call. No JSON parsing anywhere in the module. Confirmed against design spec line 1014 ("输出：纯文本（非 JSON）").
- ✅ **Requirement 4: No retry, no normalization** — Single `client.complete(request)` call (line 61), no retry loop, no normalization beyond `.trim()`. No `mockClientSequence` usage. Matches plan.
- ✅ **Requirement 5: Fallback is orchestrator's job** — `enhancePrompt` does NOT import or call `fallbackEnhance`. Errors from `client.complete()` propagate uncaught to the caller. Confirmed against plan Task 9 orchestrator pattern (plan lines 3187-3202, design lines 1207-1215) which wraps the call in `try/catch` and invokes `fallbackEnhance` on failure.
- ✅ **Requirement 6: System prompt format aligns with `fallbackEnhance`** — `SYSTEM_PROMPT` (lines 4-40) instructs the model to produce `## Objective` / `## Constraints` / `## Acceptance Criteria` / `## Files` / `## Execution Order`, then "Begin working on the tasks above. Verify each acceptance criterion before claiming completion." `fallbackEnhance` (`spec-pipeline-helpers.ts:35-87`) produces the same five section headers and the same trailing line. The two are interchangeable for the downstream tool loop. **Minor divergence:** `fallbackEnhance` emits a `## Confirmed Decisions` section when `decisions.length > 0` (helpers lines 74-81); the enhancer's `SYSTEM_PROMPT` does not instruct the model to produce this section (it instead embeds decisions in the user message and tells the model "decisions are already confirmed"). Both shapes are self-contained, so this is acceptable, but it is a latent format coupling — see Findings.
- ✅ **Requirement 7: Takes `SpecDraft` + `SpecKeyDecision[]` + user confirmations** — `EnhancePromptParams` (lines 42-45) takes `draft: SpecDraft` and `confirmedDecisions: SpecKeyDecision[]`. User confirmations are embedded in `SpecKeyDecision.chosen` (already populated by the upstream confirmation flow, design lines 1187-1201). There is no separate `confirmations: Record<string, string>` because the plan does not define one — the `chosen` field carries the confirmation. Matches plan and design.

**Spec compliance count: 6 ✅ / 1 ⚠️ / 0 ❌**

## Code Quality

- **TypeScript strict:** Clean. No `any`, no unsafe casts. `d.options[0]?.label` (line 70) uses optional chaining, safe under `noUncheckedIndexedAccess`. Under `exactOptionalPropertyTypes`, the `ModelRequest` object (lines 53-60) omits optional `reasoningEffort` and `signal` entirely rather than setting them to `undefined` — correct. All type-only imports use `import type` (lines 1-2), satisfying `verbatimModuleSyntax`. `isolatedModules` satisfied.
- **Boundary compliance:** Clean. Only imports are `./types.js` and `./spec-types.js` (lines 1-2), both sibling modules inside `agent-runtime/src`. No external npm packages, no `@focuscode/*` cross-package imports, no `node:fs`, no `node:child_process`, no `fetch(`. `.js` extensions on all imports. `node scripts/check-boundaries.mjs` → "Architecture boundary check passed." (exit 0).
- **Prettier:** PASS. Command `npx prettier --check packages/agent-runtime/src/spec-enhancer.ts packages/agent-runtime/test/spec-enhancer.test.ts` → "All matched files use Prettier code style!" (exit 0).

## Test Quality

- **Coverage assessment:** Adequate for the happy path and core invariants (text passthrough, trimming, decision embedding, draft JSON in user message, empty-decisions edge case, raw unformatted output). Two gaps: (a) no test for error propagation when `client.complete()` throws, (b) no test asserting format coupling with `fallbackEnhance`. Gap (a) is notable because requirement 5 explicitly makes "throws on error" a contractual behavior. Gap (b) is cross-task and lower priority.

- **Test list:**
  1. `returns model's text output directly` — ✅ Asserts `result` contains `## Objective` and the goal text. Non-trivial; verifies text passthrough.
  2. `includes confirmed decisions in user message` — ✅ Captures the user message via a hand-rolled client and asserts it contains the decision point and `chosen: A`. Verifies decision incorporation (requirement 7).
  3. `works with empty decisions` — ✅ Asserts empty `confirmedDecisions` produces raw model text. Edge case coverage.
  4. `returns raw content even if not formatted` — ✅ Asserts unstructured text passes through unchanged. Verifies no format validation/enforcement (requirement 4).
  5. `trims whitespace from output` — ✅ Asserts leading/trailing whitespace stripped. Verifies `.trim()` behavior.
  6. `includes spec draft JSON in user message` — ✅ Captures user message, asserts it contains goal and file path. Verifies draft serialization.
  - **Missing:** Error propagation test (when `client.complete` rejects, `enhancePrompt` should reject with the same error).
  - **Missing:** Format coupling test (SYSTEM_PROMPT section headers should match `fallbackEnhance` section headers).

## Test Execution

- Command: `cd /Users/tohnee/Trae/Code/focuscode && pnpm build && npx vitest run packages/agent-runtime/test/spec-enhancer.test.ts`
- Result: **6 passed, 0 failed** (1 test file, ~139ms). Build succeeded (all packages). Boundary check passed. Prettier check passed.

## Findings

### Minor — Missing error propagation test

- Location: `packages/agent-runtime/test/spec-enhancer.test.ts` (absent test)
- Issue: Requirement 5 makes "may throw on error — the orchestrator catches" an explicit contractual behavior of `enhancePrompt`. No test asserts that a rejecting `client.complete()` causes `enhancePrompt` to reject (rather than swallow, retry, or fall back internally). A regression that wrapped the call in a silent try/catch would not be caught.
- Recommendation: Add a test with a client whose `complete()` rejects with a sentinel `Error`, asserting `enhancePrompt` rejects with the same error.

### Minor — Missing format coupling test with `fallbackEnhance`

- Location: `packages/agent-runtime/test/spec-enhancer.test.ts` (absent test)
- Issue: Requirement 6 requires the enhancer's output format to align with `fallbackEnhance` so the two are interchangeable. No test asserts this coupling. A future edit to either `SYSTEM_PROMPT` or `fallbackEnhance` could silently break alignment.
- Recommendation: Add a test asserting the `SYSTEM_PROMPT`'s documented section headers (`## Objective`, `## Constraints`, `## Acceptance Criteria`, `## Files`, `## Execution Order`) are a superset of `fallbackEnhance`'s emitted headers, or assert both end with the same trailing line.

### Low — `## Confirmed Decisions` section divergence between enhancer and fallback

- Location: `spec-enhancer.ts:4-40` (SYSTEM_PROMPT) vs `spec-pipeline-helpers.ts:74-81` (`fallbackEnhance`)
- Issue: `fallbackEnhance` emits a `## Confirmed Decisions` section when `decisions.length > 0`; the enhancer's `SYSTEM_PROMPT` does not instruct the model to produce this section (it embeds decisions in the user message and says "decisions are already confirmed"). The downstream tool loop will see a `## Confirmed Decisions` block on fallback but not on the happy path. Both prompts remain self-contained, so this is not a functional break, but it is a latent format asymmetry.
- Recommendation: Either add `## Confirmed Decisions` to the enhancer's `SYSTEM_PROMPT` format spec, or remove it from `fallbackEnhance` — pick one canonical shape. Low priority since both paths are functional.

### Info — Review task signature vs. plan signature discrepancy

- Location: Review task description (Requirement 1) vs. plan `2026-07-23-spec-engine.md:2142-2146`
- Issue: The review task's stated signature `(client, profile, draft, decisions, confirmations: Record<string, string>, signal?: AbortSignal) => Promise<SpecEnhancedPrompt>` does not match the plan's actual signature `(client, profile, params: { draft, confirmedDecisions }) => Promise<string>`. The `confirmations` map and `signal` parameter do not exist in the plan or design. The implementation correctly follows the plan.
- Recommendation: No action on the implementation. Note for the review harness: the review task's Requirement 1 text should be aligned with the plan to avoid confusion in future reviews.

### Info — `signal` (AbortSignal) not threaded through

- Location: `spec-enhancer.ts:47-63`
- Issue: `enhancePrompt` does not accept or forward an `AbortSignal` to `client.complete()`. The plan's signature does not include `signal`, so this is plan-compliant. However, `ModelRequest.signal` exists (`types.ts:81`) and sibling stages may eventually want cancellation. This is out of scope for Task 7.
- Recommendation: None for Task 7. If cancellation support is added later, it should be added uniformly across all five stages via a plan amendment.

## Verdict

The `spec-enhancer.ts` implementation is correct, plan-compliant, and matches the design spec's system prompt and user-message format verbatim. It returns trimmed text output with no retry, no JSON parsing, and no internal fallback — exactly the Stage 5 contract. TypeScript strict, boundary, and Prettier checks all pass; all 6 tests pass. The two test gaps (error propagation, format coupling with `fallbackEnhance`) and the minor `## Confirmed Decisions` format divergence are non-blocking and can be addressed in a follow-up. No critical or important issues. **PASS WITH MINOR.**
