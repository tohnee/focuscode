# Task 7 Report: SpecEngine Enhancer Stage (Stage 5)

## Status: DONE

## Files created

- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-enhancer.ts` — enhancer stage that transforms a confirmed `SpecDraft` + `SpecKeyDecision[]` into an executable text prompt for the coding agent. Exports `enhancePrompt()` and the `EnhancePromptParams` interface.
- `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-enhancer.test.ts` — 6 vitest tests covering text output passthrough, decision embedding, empty decisions, raw content, whitespace trimming, and draft JSON inclusion.

## Test results

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-enhancer.test.ts`

- Test Files: 1 passed (1)
- Tests: 6 passed (6), 0 failed
- Duration: ~147ms

Per-suite breakdown:

- `returns model's text output directly` — model's text content is returned verbatim (trimmed).
- `includes confirmed decisions in user message` — captured user message contains the decision point and `chosen: A`.
- `works with empty decisions` — empty `confirmedDecisions` produces no decisions section; output is the raw model text.
- `returns raw content even if not formatted` — unstructured text (no `## Objective` header) is returned as-is.
- `trims whitespace from output` — leading/trailing whitespace is stripped via `response.content.trim()`.
- `includes spec draft JSON in user message` — captured user message contains the draft's goal (`Add a feature`) and file path (`src/main.ts`).

## Boundary check

Command: `node scripts/check-boundaries.mjs`
Result: **PASS** — "Architecture boundary check passed."

`packages/agent-runtime/src/spec-enhancer.ts` only imports from sibling modules inside `agent-runtime/src`:

- `import type { ModelClient, ModelProfile, ModelRequest } from "./types.js"`
- `import type { SpecDraft, SpecKeyDecision } from "./spec-types.js"`

No forbidden tokens (`@focuscode/harness-core`, `@focuscode/model-gateway`, `@focuscode/persistence`, `@focuscode/sdk`, `@focuscode/auth`, `@focuscode/ecosystem`, `@focuscode/sandbox`, `@focuscode/tui`, `/apps/`) are present. No external npm packages, no `node:fs`, no `node:child_process`, no `fetch(`.

## Format check

Command: `npx prettier --check packages/agent-runtime/src/spec-enhancer.ts packages/agent-runtime/test/spec-enhancer.test.ts`
Result: **PASS** — "All matched files use Prettier code style!"

An initial `prettier --write` was required on both files. Prettier reformatted:

1. In the test file, the `reliability` object and the `decisions` array entry each exceeded `printWidth: 100` when inlined; prettier expanded them to multi-line object literals.
2. In the implementation, the `buildUserMessage` `lines` array initialization was collapsed to a single line (it fit within 100 chars after prettier's bracket handling).

After re-running `pnpm build && npx vitest run`, all 6 tests still pass and the format check is clean.

## Self-review notes

### TDD RED step verified

The test imports **runtime values** (`enhancePrompt`) from `../src/spec-enhancer.js`. The RED step failed correctly and for the expected reason:

```
Error: Cannot find module '../src/spec-enhancer.js' imported from
.../packages/agent-runtime/test/spec-enhancer.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

After writing the implementation, the same command produced 6/6 passing — a true RED → GREEN transition.

### Fallback behavior clarification

The task key notes mention "Uses fallbackEnhance on error." Cross-referencing the design spec (`docs/superpowers/specs/2026-07-23-spec-engine-design.md` lines 1206-1216) and the plan's pipeline orchestrator (`docs/superpowers/plans/2026-07-23-spec-engine.md` lines 3187-3202), the `fallbackEnhance` fallback is orchestrated at the **pipeline level (Task 9)**, not inside `enhancePrompt` itself. The orchestrator wraps the `enhancePrompt` call in a `try/catch`:

```typescript
try {
  enhancedPrompt = await this.runStage("enhance", ..., (client, profile) =>
    enhancePrompt(client, profile, { draft, confirmedDecisions }), trace, input);
} catch {
  hadFallback = true;
  enhancedPrompt = fallbackEnhance(draft, confirmedDecisions);
  trace.push({ name: "enhance", model: "unknown", durationMs: 0, fellBack: true, ... });
}
```

The plan's dependency table (line 3837) confirms: `fallbackEnhance | Task 2 | Task 7 (fallback), Task 9 | ✓` — meaning `fallbackEnhance` is the fallback **for** Task 7's stage, used **by** Task 9's orchestrator. Therefore `enhancePrompt` intentionally does **not** call `fallbackEnhance` internally; it lets errors propagate to the orchestrator. This matches the plan's Task 7 implementation exactly.

### Type correctness verification

The implementation compiles cleanly under:

- `strict: true`
- `noUncheckedIndexedAccess: true` — `d.options[0]?.label` uses optional chaining, safe under this flag.
- `exactOptionalPropertyTypes: true` — the `ModelRequest` object only includes required fields; `reasoningEffort` and `signal` are omitted entirely (correct under this flag).
- `verbatimModuleSyntax: true` — all type-only imports use `import type`.
- `isolatedModules: true`

### Output is text, not JSON

Unlike the drafter (Task 5) and decision detector (Task 6) stages which parse JSON with retry, the enhancer returns the model's raw text content (trimmed). No `parseJsonResponse`, no retry, no normalization. This is intentional: the enhanced prompt is a free-form text prompt consumed directly by the coding agent's tool loop. The system prompt instructs the model to produce a structured markdown format, but the enhancer does not enforce or validate that format — it trusts the model output. This matches the plan exactly.

### Index.ts exports

Consistent with prior spec stage modules (`spec-classifier.ts`, `spec-explorer.ts`, `spec-drafter.ts`, `spec-decision-detector.ts`), `spec-enhancer.ts` is **not** re-exported from `packages/agent-runtime/src/index.ts`. The spec pipeline stages are internal modules consumed by the orchestrator (Task 9) via direct relative imports, not part of the package's public API surface.

## Concerns

1. **No error handling inside `enhancePrompt`.** If `client.complete()` throws (network error, timeout, non-2xx), the error propagates to the caller. This is by design — the pipeline orchestrator (Task 9) is responsible for catching and falling back to `fallbackEnhance`. But it means any direct caller of `enhancePrompt` outside the orchestrator must handle errors themselves.

2. **No format validation of model output.** The enhancer returns whatever text the model produces, even if it doesn't follow the `## Objective` / `## Constraints` / etc. format specified in the system prompt. Test 4 ("returns raw content even if not formatted") explicitly confirms this. If the model produces garbage, the downstream coding agent receives garbage. The `fallbackEnhance` function (Task 2) produces a guaranteed-format prompt, but it's only invoked on exception, not on malformed output. This is the plan's explicit design.

3. **`SYSTEM_PROMPT` format is implicitly contractual.** The system prompt instructs the model to produce sections (`## Objective`, `## Constraints`, `## Acceptance Criteria`, `## Files`, `## Execution Order`) that match the `fallbackEnhance` output format from Task 2. The task-2 report flagged this coupling: "If the enhancer stage produces a different format, `fallbackEnhance` will need to be kept in sync." The enhancer's system prompt and `fallbackEnhance` are now both implemented and their formats align. Future changes to either must keep them in sync to avoid the downstream tool loop seeing inconsistent prompt shapes.

4. **Plan's commit step skipped.** The task constraints say "NEVER commit changes unless explicitly instructed." The plan's Step 5 included a `git commit`, which was not run. The parent agent / user can commit if desired.
