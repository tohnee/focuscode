# Contributing

## Required local gate

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm demo
pnpm agent:demo
```

All canonical contract changes must also run:

```bash
pnpm schemas
```

Commit the regenerated files under `docs/schemas/`.

## Architecture rules

- `contracts` has no dependency on other FocusCode packages or Provider SDKs.
- `harness-core` only uses canonical ports; no file, process, network or model implementation.
- `model-gateway` never grants permissions or decides task success.
- `agent-runtime` does not import `harness-core`, `model-gateway`, persistence or SDK composition.
- `action-backends` never compile prompts or own task state.
- `protocols` map edge semantics and never write facts directly.
- Audit Model Packs remain declarative; CLI JavaScript Extensions are explicit trusted code and must
  never be described as sandboxed.
- Add abstractions only after a second implementation demonstrates a real difference.

## Test expectations

- Contract/schema changes: golden and backward-compatibility tests.
- Parser changes: arbitrary chunk differential, truncation and invalid schema tests.
- Conversational Provider changes: SSE arbitrary chunk, JSON fallback, tool-argument and usage tests.
- Tool changes: path/property, approval, observed effect and reconciliation tests.
- Session changes: JSONL reload, tree/fork, compaction and export tests.
- Extension changes: project trust, reload and permission-path tests.
- Kernel changes: deterministic state and crash-boundary tests.
- Security changes: threat path and fail-closed test.
- Model Pack changes: generic-vs-specific ablation fixture.

Coverage thresholds are repository floors, not a target to game. High-risk modules may require higher
local coverage even when the global Gate passes.

## Pull request scope

Keep Harness code, Model Pack, Tool Registry, Policy and schema changes separable where possible.
Describe the compatibility impact, trust-boundary impact, rollback and evidence. Do not combine an
unrelated dependency upgrade with a security-sensitive runtime change.
