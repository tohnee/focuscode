# Local Alpha Runbook

## CLI model endpoint fails

1. Run `focuscode providers` and verify provider/protocol/base URL.
2. Confirm the provider API key environment variable is set in the FocusCode process.
3. Use `--tool-mode prompt-json` only if the endpoint cannot implement native tools.
4. Do not copy API Keys into `.focuscode/agent.json`, prompts or Session files.
5. Reproduce with `pnpm agent:demo` to separate CLI/runtime failure from Provider failure.

## CLI Session cannot resume

1. Run `focuscode sessions --repo /same/workspace`.
2. Confirm `--session-dir` and workspace are the same as the original run.
3. Preserve the JSONL file; do not truncate a partially written final line manually.
4. Export any readable branch before repair.
5. Fork a known Entry when the active leaf is semantically wrong; do not overwrite history.

## Tool was denied

1. Inspect Tool name, arguments, risk and denial reason.
2. Do not change to `full-auto` for protected paths or critical commands; hard denies remain.
3. For a legitimate sensitive operation, perform it manually or narrow the Tool/path.
4. Use a disposable container/worktree before enabling automation for repository scripts.

## CLI process hangs in a command

1. In TUI, use `/interrupt ...` to replace a model generation; use Ctrl+C to abort the whole turn.
2. Run `focuscode sandbox doctor --kind auto` and confirm the reported backend.
3. Docker timeout/abort should force-remove the uniquely named container; inspect `docker ps -a` if the daemon failed.
4. VM mode also uses a remote process-group timeout; expired disposable VMs should be destroyed by the provisioner.
5. Host mode has no cgroup/network boundary; do not use it for code that may daemonize.

## No isolated sandbox is available

1. Install Docker, register runsc, or configure `--vm-host` and `--vm-workspace`.
2. Run `focuscode sandbox doctor --kind docker|gvisor|vm`.
3. Build or select an image containing the repository toolchain.
4. Do not set `--allow-host-fallback` merely to hide a production configuration failure.

## OAuth login fails

1. Verify client ID, scopes and HTTPS endpoints; keep client secret in the provider environment variable.
2. Use `--no-browser` to inspect the authorization URL or `--device` when supported.
3. Confirm the loopback callback is not blocked by local security software.
4. Run `focuscode auth list`; Token values are intentionally never printed.
5. Remove and re-login if the Refresh Token was revoked.

## Task blocked after an invalid/truncated decision

1. Run `focuscode inspect --task-id ...` and locate `ModelDecisionRejected`.
2. Check finish reason and parser diagnostics; do not manually replay a partial tool call.
3. Fix/replace the Model Pack or endpoint.
4. Start a new task in Alpha; resume-from-BLOCKED is intentionally not exposed yet.

## Verification is PARTIAL

1. Confirm `.focuscode/config.json` contains reviewed argv commands.
2. Re-run with `--trust-repo-config` only after Owner review.
3. Do not treat PARTIAL as success; Kernel keeps the completion blocked.

## Tool schema digest changed

1. Stop the task.
2. Rebuild and re-export schemas/Tool manifest.
3. Start from a checkpoint with a newly compiled Model Pack prompt.
4. Never edit the digest in an in-flight intent.

## Event version conflict

1. Stop duplicate local workers.
2. Preserve `events.jsonl` and `checkpoint.json`.
3. Inspect the latest event sequence.
4. Do not truncate facts. Use a new task if the local Alpha cannot reconcile safely.
