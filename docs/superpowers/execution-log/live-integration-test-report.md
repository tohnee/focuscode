# SpecEngine Live Integration Test Report

- **Date**: 2026-07-23
- **Script**: `tests/spec-engine-live-test.ts`
- **Target**: GLM (智谱) API — `glm-5.2` via OpenAI-compatible protocol
- **Endpoint**: `https://open.bigmodel.cn/api/coding/paas/v4`
- **Status**: Script verified (load + skip path); live API run pending API key

## Summary

The live integration test script for the SpecEngine 5-stage clarification pipeline
(classifier → explorer → drafter → decision-detector → enhancer) has been created
and verified for correct loading. The script could not be executed against the real
GLM API because `ZAI_API_KEY` was not present in the environment; the script
correctly detected this and exited with code 2 (skip), which is the designed
CI-gating behavior.

## Verification Performed

### 1. Syntax and Import Verification ✅

Command: `npx tsx tests/spec-engine-live-test.ts` (without `ZAI_API_KEY`)

Result: All imports resolved successfully, no syntax errors. The script:

- Imported `createModelClient`, `createCodingToolRegistry`, `SpecEngine` and
  related types from `@focuscode/agent-runtime`
- Executed `main()` → `runLiveTest()`
- Reached the API key check, printed the SKIP guidance, and exited with code 2

Output:

```
[SKIP] ZAI_API_KEY is not set. Set it to run the live GLM integration test.
        export ZAI_API_KEY=<your-glm-api-key>
        npx tsx tests/spec-engine-live-test.ts
EXIT=2
```

### 2. Package Resolution Fix

During verification, a package resolution issue was discovered: the root
`package.json` did not list `@focuscode/agent-runtime` as a devDependency, so
`tsx` (which uses Node's native ESM resolver) could not find the package from
`tests/`.

Fix applied: added `"@focuscode/agent-runtime": "workspace:*"` to the root
`devDependencies` in `package.json`, following the same pattern already used
for `@focuscode/testkit`. After `pnpm install`, the script resolved all
imports correctly.

### 3. Live API Run ⏳ (Pending)

Not executed — `ZAI_API_KEY` is absent from the current environment. To run
the full live test:

```bash
export ZAI_API_KEY=<your-glm-api-key>
npx tsx tests/spec-engine-live-test.ts
```

## Script Design

The script (`tests/spec-engine-live-test.ts`) is a standalone diagnostic, not a
vitest test. It is gated by `ZAI_API_KEY` so it can sit in CI without failing
when the key is absent (exit 2 = skip).

### GLM Provider Configuration

- Provider: `glm-cn`
- Model: `glm-5.2`
- Protocol: `openai-chat` (OpenAI-compatible)
- Base URL: `https://open.bigmodel.cn/api/coding/paas/v4`
- API key env: `ZAI_API_KEY`
- Context window: 1,000,000 tokens
- Max output tokens: 8,192
- Temperature: 0.2
- Reasoning effort: `high`
- Compatibility flags: `thinkingFormat: "zai"`, `supportsReasoningEffort`, `zaiToolStream`
- Reliability: 120s timeout, 2 retries, 500ms–10s backoff

### Pipeline Configuration

All five stages use the same GLM model with `fallback: "primary"`:

| Stage             | Model   | Fallback |
| ----------------- | ------- | -------- |
| classifier        | glm-5.2 | primary  |
| explorer          | (main)  | —        |
| drafter           | glm-5.2 | primary  |
| decision-detector | glm-5.2 | primary  |
| enhancer          | glm-5.2 | primary  |

Key decision rules configured:

1. `api-surface` — Any change to a public API or export signature
2. `security-boundary` — Changes touching sandbox isolation or permission model
3. `data-persistence` — Schema or format changes to stored data

### Test Prompt

A realistic multi-file feature request designed to exercise all pipeline stages:

```
/spec Add a Firecracker microVM sandbox backend to packages/sandbox,
integrating with the existing SandboxExecutor interface and supporting
the auto fallback chain (gVisor → Docker → Firecracker → Host).
```

### Decision Auto-Resolution

When the pipeline emits `spec_confirmation_required`, the event sink schedules
a deferred (`setTimeout`, 100ms) auto-resolution that picks the first option
for each decision. This ensures the blocking confirmation doesn't deadlock the
script while still exercising the full enhancer stage.

### Validation Checks

The script validates:

1. `clarify()` returns `action: "apply"` (not `skip` or `abort`)
2. All five `spec_stage` events are emitted: `classify`, `explore`, `draft`,
   `detect-decisions`, `enhance`
3. The spec document file exists on disk and contains frontmatter
4. `specPath` is non-empty when action is `apply`
5. Enhanced prompt length and initial todo count are captured

### Exit Codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | All checks passed, pipeline returned `apply` |
| 1    | Errors occurred or action was not `apply`    |
| 2    | Skipped — `ZAI_API_KEY` not set              |

## Files Changed

| File                                                             | Change                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| `tests/spec-engine-live-test.ts`                                 | Created — live integration test script                   |
| `package.json`                                                   | Added `@focuscode/agent-runtime` workspace devDependency |
| `docs/superpowers/execution-log/live-integration-test-report.md` | Created — this report                                    |

## Next Steps

1. **Run the live test**: Set `ZAI_API_KEY` and execute the script to obtain
   real pipeline timings, stage coverage, and spec document output.
2. **Inspect the generated spec**: After a successful run, review the spec file
   written to `docs/specs/` for content quality.
3. **Iterate on prompt/config**: If any stage falls back or returns malformed
   output, tune the GLM compatibility flags or stage prompts.
