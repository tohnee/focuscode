# Task 8 Review: spec-store.ts

## Status: PASS WITH MINOR

## Spec Compliance

- ✅ **Requirement 1**: `SpecStoreImpl implements ISpecStore` (spec-types.ts line 190-195). All 4 methods (`save`, `load`, `list`, `updateStatus`) present with correct signatures.
- ✅ **Requirement 2**: `save()` returns `join(dir, filename)` where `dir = join(cwd, specDirectory)` and `filename = ${date}-${topic}.md`. Test confirms path contains spec directory, topic, and date.
- ✅ **Requirement 3**: `load(specId)` iterates `listDir`, parses frontmatter, returns `SpecDocument | undefined` by matching frontmatter ID. Returns `undefined` when not found.
- ✅ **Requirement 4**: `list(limit?)` returns `SpecSummary[]`, sorts via `b.createdAt.localeCompare(a.createdAt)` (desc), respects limit via `slice(0, limit)`.
- ✅ **Requirement 5**: `updateStatus(specId, status)` loads doc, sets `doc.status` and `doc.updatedAt`, calls `save(doc)`. Throws if not found.
- ✅ **Requirement 6**: `resolveFilename` handles same-topic+date: same ID overwrites, different ID appends `-2.md`, `-3.md`, etc. Test confirms `-2.md` suffix.
- ✅ **Requirement 7**: Frontmatter starts with `---\n`, contains id/createdAt/updatedAt/topic/trigger/status, ends with `\n---\n`. Verified in `serialize` and `parseFrontmatter`.
- ✅ **Requirement 8**: Uses `SpecEngineDeps` (`writeFile`/`readFile`/`listDir`) exclusively. No `node:fs`/`node:child_process`/`fetch(` (grep confirmed). Only import is `node:path`.

## Deviation Assessment

- **Deviation 1 (conflict handling)**: **Sound.** The plan's sync `buildFilename()` could not satisfy the "appends suffix on filename conflict" test nor the "updates status" test (which re-saves the same spec and needs overwrite-not-suffix). The async `resolveFilename()` correctly handles three cases: (a) no existing file → base name, (b) same ID → overwrite, (c) different ID → `-N` suffix starting at N=2. Logic is correct and well-documented. The `listDir().catch(() => [])` in `save()` is a reasonable guard for first-write-when-dir-missing.
- **Deviation 2 (SpecTrigger)**: **Sound.** `SpecTrigger` is exported from spec-types.ts (line 15) as `"auto" | "explicit"`. Using the type alias instead of the inline literal is behaviorally identical and more consistent with the source of truth. Preferable to the plan's inline literal.
- **Deviation 3 (deserialize)**: **Sound.** The plan's `deserialize(content, fm)` had an unused `content` parameter (the body is not parsed). Dropping it is a clean simplification with no behavioral impact. The call site in `load()` was updated accordingly.

## Code Quality

- **TypeScript strict**: Compliant. No `any`. Type assertions (`map.status as SpecStatus`, `map.trigger as SpecTrigger`) are guarded by a prior truthiness check (`if (!map.id || !map.status || !map.trigger) return null`). Non-null assertions (`match[1]!`, `match[2]!`) are safe because the regex `^(\w+):\s*(.*)$` always captures both groups on match. `existing.includes(candidate)` and array accesses in tests use `!` appropriately. `exactOptionalPropertyTypes` is respected — `list(limit?: number)` uses `limit ? ... : ...` which handles `undefined` correctly.
- **Boundary compliance**: ✅ Grep confirmed no `node:fs`, `node:child_process`, `fetch(`, or `require(`. Only import is `node:path` (allowed). All ESM imports use `.js` extensions (`./spec-types.js`). `node scripts/check-boundaries.mjs` → "Architecture boundary check passed."
- **Prettier**: ✅ `npx prettier --check packages/agent-runtime/src/spec-store.ts packages/agent-runtime/test/spec-store.test.ts` → "All matched files use Prettier code style!"

## Test Quality

- **Coverage**: 8 tests covering all 4 public methods plus conflict handling and frontmatter format. All tests assert meaningful properties (no no-op tests). Test fixture (`makeDeps`) correctly simulates `SpecEngineDeps` with in-memory `Map`s and tracks directory listings.
- Test list:
  1. ✅ "saves spec and returns path" — verifies path contains spec dir, topic, date.
  2. ✅ "loads saved spec by ID" — verifies round-trip of id and topic.
  3. ✅ "returns undefined for non-existent ID" — verifies `undefined` return.
  4. ✅ "lists specs sorted by createdAt desc" — verifies 3 specs sorted correctly (11:00, 10:00, 09:00).
  5. ✅ "respects limit parameter" — verifies `list(1)` returns 1 item.
  6. ✅ "updates status" — verifies `status: executing` persisted and loadable.
  7. ✅ "appends suffix on filename conflict" — verifies `-2.md` suffix for different ID, same topic+date.
  8. ✅ "writes frontmatter with metadata" — verifies `---\n` prefix and id/topic/status fields.

## Test Execution

- Command: `pnpm build && npx vitest run packages/agent-runtime/test/spec-store.test.ts`
- Result: **8 passed, 0 failed** (141ms duration).
- Build: succeeded (all packages compiled).

## Findings

### Important: `updateStatus` silently destroys spec body content

- **Location**: `spec-store.ts:67-73` (`updateStatus`) combined with `spec-store.ts:194-225` (`deserialize`).
- **Issue**: `updateStatus` does `load(specId)` → mutate status → `save(doc)`. But `deserialize` returns a minimal doc with empty body fields (`goal: ""`, `enhancedPrompt: ""`, `taskBreakdown: []`, `keyDecisions: []`, `constraints: []`, etc.). After `updateStatus` re-saves, the file's body is wiped — `## Goal` becomes empty, `## Enhanced Prompt` becomes empty, and all conditional sections (Constraints, Acceptance Criteria, Affected Areas, Task Breakdown, Key Decisions) are dropped because their arrays are empty. The frontmatter survives, but the human-readable body and all structured content is lost.
- **Test gap**: The "updates status" test only asserts `content.toContain("status: executing")` and `loaded!.status === "executing"`. It does NOT assert that `goal`, `enhancedPrompt`, or `taskBreakdown` are preserved, so the test passes despite the data loss.
- **Root cause**: This is a plan-level design flaw — the plan's `deserialize` also returns minimal data and the plan's `updateStatus` also does load → modify → save. The implementer followed the plan faithfully and flagged the `updatedAt` aspect, but the broader body-loss issue is more severe than flagged.
- **Recommendation**: Either (a) have `updateStatus` read the raw file text and rewrite only the frontmatter lines (preserving the body), or (b) parse the body in `deserialize` so round-tripping is lossless, or (c) at minimum add a test that asserts body preservation after `updateStatus` to make the limitation explicit. Option (a) is the lowest-effort fix.

### Minor: `parseFrontmatter` does not extract `updatedAt`

- **Location**: `spec-store.ts:165-192`.
- **Issue**: `serialize` writes `updatedAt: ${doc.updatedAt}` to frontmatter, but `parseFrontmatter` does not parse it. `deserialize` returns `updatedAt: fm.createdAt`, so any loaded doc has `updatedAt === createdAt`. A caller relying on `updatedAt` after `load()` gets the wrong value.
- **Recommendation**: Add `updatedAt` to the parsed frontmatter object and return it from `deserialize`. One-line fix in `parseFrontmatter` + one-line in `deserialize`.

### Minor: `resolveFilename` uses unbounded `while(true)` loop

- **Location**: `spec-store.ts:89-101`.
- **Issue**: The loop has no upper bound. In practice the number of same-topic/same-date specs is small, but a pathological or adversarial directory listing could cause many `readFile` probes.
- **Recommendation**: Add a safety cap (e.g., `n < 1000`) that throws on overflow. Low priority — flagged by implementer as acceptable for an internal tool.

### Low: No slugification of topic in filename

- **Location**: `spec-store.ts:90`.
- **Issue**: `${date}-${topic}.md` uses the raw topic. A topic with spaces (e.g., "add feature") produces `2026-07-23-add feature.md` with a space, which is awkward on some shells/filesystems. The tests use hyphenated topics ("add-feature", "first", "second"), so this is untested.
- **Recommendation**: Consider sanitizing the topic (replace spaces/special chars with hyphens) in `resolveFilename`. Low priority — topics are likely already slug-like by convention upstream.

### Low: `list(0)` returns all specs instead of zero

- **Location**: `spec-store.ts:64`.
- **Issue**: `return limit ? summaries.slice(0, limit) : summaries` — when `limit === 0`, the falsy check returns all summaries. A caller expecting `list(0)` to return an empty array would be surprised.
- **Recommendation**: Use `limit !== undefined ? summaries.slice(0, limit) : summaries` if the zero-case matters. Low priority — `list(0)` is an unlikely call.

### Info: Type assertions on `status`/`trigger` lack runtime validation

- **Location**: `spec-store.ts:189-190`.
- **Issue**: `map.status as SpecStatus` and `map.trigger as SpecTrigger` assume the string is a valid union member. A corrupted or hand-edited file with `status: bogus` would type-check but produce an invalid `SpecStatus`.
- **Recommendation**: Acceptable for an internal tool where files are self-authored. If robustness against external input is needed, add a runtime check against the valid union values. Info only — no action required for Task 8.

## Verdict

The implementation is faithful to the plan, all 8 spec requirements are met, all 8 tests pass, and boundary/prettier/TypeScript-strict checks are clean. The three reported deviations are all sound and well-justified. The most significant issue is that `updateStatus` silently destroys the spec body content because `deserialize` returns minimal data and `updateStatus` round-trips through load → save — this is a plan-level design flaw that the implementer inherited, but it warrants a follow-up fix or an explicit test documenting the limitation. The `updatedAt` round-trip loss and the unbounded loop are minor concerns. I recommend **PASS WITH MINOR**: approve the task, but file a follow-up to make `updateStatus` non-lossy (preferably by rewriting only frontmatter lines in-place) and to extract `updatedAt` in `parseFrontmatter`.
