# Task 6 Review: SpecEngine Decision Detector Stage (Stage 4)

## Verdict: APPROVED

The decision detector implementation is faithful to the plan, all automated gates pass
(build, tests, boundary check, prettier), and the documented deviations are justified and
improve correctness. No blocking findings.

## Verification Performed

| Check                   | Command                                                                     | Result            |
| ----------------------- | --------------------------------------------------------------------------- | ----------------- |
| Build (strict TS)       | `pnpm --filter @focuscode/agent-runtime build`                              | PASS (exit 0)     |
| Tests                   | `npx vitest run packages/agent-runtime/test/spec-decision-detector.test.ts` | PASS 8/8 (~162ms) |
| Architecture boundaries | `node scripts/check-boundaries.mjs`                                         | PASS              |
| Prettier                | `npx prettier --check` on impl + test                                       | PASS              |

Files reviewed:

- Impl: `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-decision-detector.ts`
- Test: `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/test/spec-decision-detector.test.ts`
- Helpers: `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-pipeline-helpers.ts` (parseJsonResponse / mockClient / mockClientSequence)
- Types: `/Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-types.ts` (`SpecKeyDecision`, `SpecDraft`, `KeyDecisionRule`)
- Plan: `docs/superpowers/plans/2026-07-23-spec-engine.md` lines 1712-1975
- Report: `docs/superpowers/execution-log/task-6-report.md`

## Spec Compliance

| #   | Checklist item                                               | Status | Notes                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `detectDecisions` returns `SpecKeyDecision[]`                | PASS   | Signature `(client, profile, draft, rules) => Promise<SpecKeyDecision[]>`. The "1B-2B model" selection is the orchestrator's responsibility via `SpecStageModel.profile` — the detector correctly takes any `ModelProfile` and does not hardcode a model.                                                                                                            |
| 2   | Uses `parseJsonResponse` for JSON extraction                 | PASS   | `spec-decision-detector.ts:78` calls `parseJsonResponse<unknown>(response.content)`.                                                                                                                                                                                                                                                                                 |
| 3   | Normalization validates/coerces id, point, severity, options | PASS   | `normalizeDecision` validates `id` (non-empty string) and `point` (string); coerces `severity` to `"minor"` when not in `{critical,major,minor}`; validates `options` (missing → `[]`, array → normalized, non-array → reject). (Checklist's "impact" field does not exist on `SpecKeyDecision` — N/A; likely refers to option `tradeoffs`, which defaults to `""`.) |
| 4   | Throws on double failure (orchestrator catches)              | PASS   | `spec-decision-detector.ts:61` throws `"Decision detector failed to produce valid JSON after retry"`. Test `throws on second non-JSON output` asserts `/JSON/`. Matches plan/tests, not the delegation's loose "returns []" summary — correctly resolved per the report's Concern 6.                                                                                 |
| 5   | Severity filtering is upstream (detector returns ALL)        | PASS   | `detectDecisions` returns all severities without filtering. Documented in report Concern 2. Orchestrator splits critical/major vs minor.                                                                                                                                                                                                                             |

## Code Quality

| #   | Checklist item                                             | Status | Notes                                                                                                                                                                                    |
| --- | ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | strict / exactOptionalPropertyTypes / verbatimModuleSyntax | PASS   | Build passes. `normalizeDecision` omits optional `chosen?`/`rationale?` (does not set `undefined`). All type-only imports use `import type`; only runtime import is `parseJsonResponse`. |
| 2   | No external imports, no node:fs/child_process/fetch        | PASS   | Boundary check passes. Only imports are sibling modules `./types.js`, `./spec-types.js`, `./spec-pipeline-helpers.js`.                                                                   |
| 3   | `.js` import extensions + `import type` for type-only      | PASS   | Lines 1-3 correct.                                                                                                                                                                       |
| 4   | Prettier formatting                                        | PASS   | `prettier --check` passes on both files.                                                                                                                                                 |

## Test Quality

| #   | Checklist item                   | Status | Notes                                                                                                            |
| --- | -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Normal detection                 | PASS   | `parses decisions with severity` — asserts severity + options.length.                                            |
| 1   | JSON parse failure + retry       | PASS   | `retries on non-JSON output` — `["not json", "[]"]` sequence → `[]`.                                             |
| 1   | Error/throw                      | PASS   | `throws on second non-JSON output` — `rejects.toThrow(/JSON/)`.                                                  |
| 1   | Malformed decision filtering     | PASS   | `filters out malformed decisions` — empty id + non-array options dropped; only `d1` kept.                        |
| 1   | Severity values                  | PASS   | `parses decisions with severity` (critical) + `normalizes unknown severity to minor`.                            |
| 1   | Options normalization            | PASS   | `defaults missing options to empty array` + options-with-tradeoffs in `parses decisions with severity`.          |
| 2   | Tests assert meaningful behavior | PASS   | Each test asserts concrete, observable outcomes (lengths, field values, thrown error, captured message content). |

Additional tests beyond the checklist: `returns empty array when model outputs []` and `includes rules in user message` (verifies rule names are present in the user-facing prompt). 8 tests total, all passing.

## Findings

### Non-blocking findings (informational)

**F1 — Deviation: malformed-options handling (APPROVED).** The plan's literal `normalizeDecision` defaulted any non-array `options` to `[]`, which contradicted the plan's own `filters out malformed decisions` test (expecting the entry `{ options: "not array" }` to be dropped). The implementation distinguishes missing `options` (→ `[]`, keep) from present-but-non-array `options` (→ reject). This makes both plan tests coherent and is a more conservative, fail-safe parser. Report's "Deviation 1" documents this correctly: "the tests are the spec."

**F2 — Fail-safe semantics: throws, not returns `[]` (APPROVED).** The delegation summary said "fail-safe: returns [] on error" but the plan's code and tests explicitly throw on second parse failure. The implementation follows the plan (throw), and the report's Concern 6 flags the discrepancy for the parent. Correct resolution — plan/tests are authoritative; orchestrator wraps in try/catch if it wants `[]` fallback.

**F3 — No AbortSignal (consistency gap, plan-compliant).** `detectDecisions` does not accept an `AbortSignal`, unlike `classifyIntent` (Task 3) and `exploreCodebase` (Task 4). Up to 2 sequential model calls cannot be cancelled mid-flight. The plan does not specify a signal for Task 6, so this matches the plan; the orchestrator should enforce an overall stage deadline if needed. Flagged for awareness, not a defect.

**F4 — Retry does not bump `maxOutputTokens`.** A model that truncated on the first attempt (stopReason `length`) will likely fail again with the same token budget. Plan-compliant; noted as a future enhancement only.

**F5 — Normalizers silently drop invalid items.** `normalizeDecision` filters out items failing validation without surfacing them. Intentional fail-safe per plan; downstream pipeline trace (later task) should capture degraded-detection signals.

### Positive observations

- Clean, minimal implementation; no over-engineering.
- `normalizeOption` correctly defaults `tradeoffs` to `""` while requiring `label` + `description`.
- Retry profile correctly spreads `profile` and overrides only `temperature: 0`.
- Test for rule-inclusion uses a properly typed `ModelClient` (the plan's untyped literal would not compile under `strict` + `strictFunctionTypes`); report's "Deviation 2" documents this fix.
- `exactOptionalPropertyTypes` handled correctly: optional `chosen`/`rationale` omitted rather than set to `undefined`.

## Recommendation

No changes required. The implementation, tests, and report are consistent with the plan.
The documented deviations improve correctness and are well-justified. Proceed to the next task.
