# Task 8 Report: spec-store.ts

## Status: DONE

## Files Created

- `packages/agent-runtime/src/spec-store.ts` — 226 lines
- `packages/agent-runtime/test/spec-store.test.ts` — 144 lines

## TDD Evidence

- RED phase: `npx vitest run packages/agent-runtime/test/spec-store.test.ts` — FAIL (Cannot find module '../src/spec-store.js')
- GREEN phase: `npx vitest run packages/agent-runtime/test/spec-store.test.ts` — PASS, 8 tests

## Boundary & Prettier

- Boundary check: `node scripts/check-boundaries.mjs` — PASSED ("Architecture boundary check passed.")
- Prettier check: initial run flagged `spec-store.test.ts`; ran `npx prettier --write` on it; re-check PASSED ("All matched files use Prettier code style!")

## Deviations from plan

- **Conflict-handling logic added (required by task brief):** The plan's `save()` + `buildFilename()` did not handle filename conflicts, but the test "appends suffix on filename conflict" requires the second save of a same-topic/same-date spec to end in `-2.md`. Replaced the sync `buildFilename(doc)` with an async `resolveFilename(doc, dir, existing)` that:
  - Calls `this.deps.listDir(dir).catch(() => [])` in `save()` to get existing filenames.
  - Tries the base name `${date}-${topic}.md` first.
  - If the candidate name already exists, reads its frontmatter; if the existing file's spec ID matches `doc.id`, the same name is returned (overwrite — needed by the "updates status" test, which re-saves the same spec). If the ID differs, a `-N` suffix (starting at N=2) is appended until a free name is found.
- **Type adaptation:** Used `SpecTrigger` (the exported type alias from `spec-types.ts`) instead of the plan's inline literal `"auto" | "explicit"` in `parseFrontmatter`/`deserialize` return types, for consistency with the source of truth. Behavior is identical (`SpecTrigger = "auto" | "explicit"`).
- **`deserialize` signature simplified:** Dropped the unused `content: string` first parameter from the plan's `deserialize(content, fm)` since the body is not parsed — now `deserialize(fm)`.
- Skipped the `git add`/`git commit` step (Step 5) per task instructions (not a git repo).

## Concerns

- `resolveFilename` uses an unbounded `while (true)` loop. In practice the number of same-topic/same-date specs is small, but a malicious or pathological directory listing could cause many `readFile` probes. Acceptable for an internal tool; flagging for completeness.
- `deserialize` returns `updatedAt: fm.createdAt` (frontmatter's `updatedAt` is not extracted by `parseFrontmatter`), so a round-tripped doc loses the real `updatedAt`. This matches the plan and the tests only assert on `status`/`id`/`topic`, but a future caller relying on `updatedAt` after `load()` would get the `createdAt` value instead.

## Test summary

- 8 passed, 0 failed

## Fix: updateStatus lossy + parseFrontmatter updatedAt

### Tests added (2 new)

- `updateStatus preserves spec body content` — saves a doc with non-empty `enhancedPrompt` and `taskBreakdown`, calls `updateStatus`, then asserts the raw file content still contains the body text (`MY_ENHANCED_PROMPT_BODY`, `MY_TASK_DESCRIPTION`, `## Enhanced Prompt`, `## Task Breakdown`) and the new `status: executing` line.
- `load returns correct updatedAt` — saves a doc with distinct `createdAt`/`updatedAt`, loads it, and asserts `loaded.updatedAt` equals the saved `updatedAt` (not `createdAt`).

### RED evidence

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-store.test.ts`
Both new tests failed:

- `updateStatus preserves spec body content` — `AssertionError: expected '---\nid: ...\n...' to contain 'MY_ENHANCED_PROMPT_BODY'` (body was wiped by deserialize → serialize round-trip; only empty `## Enhanced Prompt` section remained).
- `load returns correct updatedAt` — `AssertionError: expected '2026-07-23T10:25:51Z' to be '2026-07-23T11:30:00Z'` (`deserialize` set `updatedAt: fm.createdAt`).
  Result: `Tests  2 failed | 8 passed (10)`.

### Fix description (changes in `packages/agent-runtime/src/spec-store.ts`)

1. **`updateStatus` rewritten** to do in-place frontmatter editing instead of `load → mutate → save`. It iterates the spec directory (same file-discovery pattern as `load`), reads each `.md` file, parses frontmatter to match the spec ID, then replaces only the `status:` and `updatedAt:` lines inside the frontmatter block and writes the content back to the same path. The markdown body is never touched, so no data loss occurs. Throws `Spec not found: <id>` if no match is found.
2. **New private helper `replaceFrontmatterField(content, field, value)`** — replaces a single `field: value` line within the YAML frontmatter block (delimited by `---\n` … `\n---\n`, consistent with `serialize`/`parseFrontmatter`). Leaves the body untouched. Only the first matching line is replaced; returns content unchanged if frontmatter delimiters are absent.
3. **`parseFrontmatter` extended** — return type now includes `updatedAt: string`; extraction reads `map.updatedAt` and falls back to `map.createdAt` for legacy files that may lack the field. `updatedAt` is NOT added to the required-field guard, so existing files without `updatedAt` still parse successfully (backward compatible).
4. **`deserialize` updated** — signature now accepts `updatedAt: string` and assigns `updatedAt: fm.updatedAt` (previously hardcoded to `fm.createdAt`).

### GREEN evidence

Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-store.test.ts`
Result: `Test Files  1 passed (1)` / `Tests  10 passed (10)` — all 8 original tests + 2 new tests pass.

### Prettier + boundary check

- `npx prettier --check packages/agent-runtime/src/spec-store.ts packages/agent-runtime/test/spec-store.test.ts` → `All matched files use Prettier code style!` (no `--write` needed).
- `node scripts/check-boundaries.mjs` → `Architecture boundary check passed.`
