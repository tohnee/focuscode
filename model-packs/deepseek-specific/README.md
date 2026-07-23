# DeepSeek-specific Model Pack

Family-specific counterpart to `../generic-openai` for the DeepSeek `deepseek-v4-pro` line. It keeps
the same canonical JSON `ModelDecision` contract but tunes the knobs the generic baseline leaves
neutral:

- the system prompt pins DeepSeek's `reasoning_content` boundary (provider-side state, never
  re-emitted in decisions);
- `maxToolIntentsPerTurn` drops to 2, matching the conservative tool-use behavior of the reasoning
  models;
- the context envelope is resized for the 1M-token window with a higher stable-prefix ratio for
  prompt-cache hits.

This pack exists as the ablation pair of the generic pack: conformance and eval suites should run
both packs against the same tasks so a family-specific regression is attributable to the pack, not
the harness. The development certificate emitted by the local SDK remains explicitly `sandbox-only`.
