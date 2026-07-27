---
id: spec_1784854650_e4b933
createdAt: 2026-07-24T00:58:48.516Z
updatedAt: 2026-07-24T00:58:48.516Z
topic: Firecracker microVM sandbox backend
trigger: explicit
status: confirmed
---

# Spec: Firecracker microVM sandbox backend

## Goal

Add a Firecracker microVM-based sandbox backend to packages/sandbox that implements the existing SandboxExecutor interface and participates in the auto fallback chain positioned between Docker and Host.

## Constraints

- [hard|user] Firecracker must implement the existing SandboxExecutor interface used by gVisor and Docker backends
- [hard|user] Fallback chain order must be gVisor -> Docker -> Firecracker -> Host
- [hard|codebase] Firecracker requires a Linux host with /dev/kvm available; availability check must gate selection in fallback chain
- [hard|codebase] Sandbox lifecycle (create, exec, stop, cleanup) must match existing backend contracts including timeout and signal handling
- [soft|convention] New backend should follow the same module structure and naming patterns as existing backends (e.g., gvisor, docker) in packages/sandbox
- [soft|convention] Tests should cover both unit-level logic and integration-level fallback chain behavior

## Acceptance Criteria

- [build] FirecrackerBackend class implements SandboxExecutor interface with all required methods
- [test] Fallback chain includes Firecracker in position 3 (after Docker, before Host)
- [test] Backend gracefully reports unavailable when /dev/kvm or firecracker binary is missing
- [test] Sandbox exec via Firecracker returns stdout/stderr/exitCode consistent with other backends
- [lint] Linting passes on all new and modified files
- [build] Full package build succeeds

## Affected Areas

- [create] packages/sandbox/src/backends/firecracker.ts — New FirecrackerBackend implementation of SandboxExecutor
- [modify] packages/sandbox/src/backends/index.ts — Export new backend and register it in the backend registry
- [modify] packages/sandbox/src/fallback-chain.ts — Insert Firecracker between Docker and Host in the auto fallback order
- [review] packages/sandbox/src/types.ts — Verify SandboxExecutor interface; add Firecracker-specific config types if needed
- [create] packages/sandbox/tests/firecracker-backend.test.ts — Unit tests for availability check, exec, lifecycle, and error handling
- [modify] packages/sandbox/tests/fallback-chain.test.ts — Update fallback chain tests to include Firecracker in the expected order
- [review] packages/sandbox/package.json — Add any Firecracker-related dependencies if a client library is used
- [modify] packages/sandbox/README.md — Document Firecracker backend setup, prerequisites, and fallback position

## Task Breakdown

t1. [design] Review existing SandboxExecutor interface and backend implementations (gVisor, Docker) to understand the contract and patterns to follow.
t2. [implement] Implement FirecrackerBackend class with availability check (/dev/kvm + firecracker binary), microVM lifecycle management, and exec support via the Firecracker API socket. (dependsOn: t1)
t3. [implement] Export FirecrackerBackend from backends index and register it in the fallback chain at position 3 (after Docker, before Host). (dependsOn: t2)
t4. [implement] Add FirecrackerBackendOptions type with configurable vCPU, memory, kernel path, rootfs path, and networking mode. (dependsOn: t1)
t5. [test] Write unit tests for FirecrackerBackend covering availability detection, exec stdout/stderr/exitCode, timeout, signal handling, and cleanup. (dependsOn: t2)
t6. [test] Update fallback chain tests to assert Firecracker is selected when gVisor and Docker are unavailable but Firecracker is available, and that Host is last resort. (dependsOn: t3)
t7. [doc] Update README to document Firecracker prerequisites (KVM, firecracker binary, kernel/rootfs), configuration options, and fallback position. (dependsOn: t2, t3)

## Key Decisions

- [critical] What root filesystem and kernel image to use for the Firecracker microVM, and where they are sourced from — Chosen: A
- [major] Whether to use a Firecracker SDK/client library or spawn the firecracker binary directly via child_process — Chosen: A
- [major] Inserting Firecracker into the existing fallback chain between Docker and Host changes the existing fallback behavior that consumers may depend on — Chosen: A
- [critical] Networking model for the Firecracker microVM — this determines the sandbox isolation boundary — Chosen: A
- [minor] Default resource limits (vCPU count and memory) for the microVM and whether these defaults are appropriate — Chosen: A

## Enhanced Prompt

```
## Objective
Add a Firecracker microVM-based sandbox backend to `packages/sandbox` that implements the existing `SandboxExecutor` interface and participates in the auto fallback chain positioned between Docker and Host (position 3 of 4).

## Constraints
- `FirecrackerBackend` must implement the exact `SandboxExecutor` interface used by gVisor and Docker backends — no method signature deviations
- Fallback chain order must be exactly: gVisor → Docker → Firecracker → Host
- Availability check must verify both `/dev/kvm` exists and the `firecracker` binary is on PATH; absence of either must cause `isAvailable()` to return `false`
- Sandbox lifecycle (`create`, `exec`, `stop`, `cleanup`) must match existing backend contracts including timeout propagation and signal handling
- Interact with Firecracker by spawning the `firecracker` CLI binary directly via `child_process`; no SDK or client library dependency
- Use a temporary Unix socket as the Firecracker API control endpoint per microVM instance
- Default networking mode is isolated loopback (no external network); must be overridable via configuration
- Default resource limits are 1 vCPU and 256 MiB memory; must be overridable via configuration
- New module structure and naming must follow the same patterns as `gvisor.ts` and `docker.ts` in `packages/sandbox/src/backends/`

## Acceptance Criteria
- [ ] `FirecrackerBackend` class implements `SandboxExecutor` with all required methods — verified by `tsc --noEmit`
- [ ] Fallback chain includes Firecracker at position 3 (after Docker, before Host) — verified by `packages/sandbox/tests/fallback-chain.test.ts`
- [ ] `isAvailable()` returns `false` when `/dev/kvm` or the `firecracker` binary is missing — verified by `packages/sandbox/tests/firecracker-backend.test.ts`
- [ ] `exec()` returns an object containing `stdout`, `stderr`, and `exitCode` fields consistent with other backends — verified by `packages/sandbox/tests/firecracker-backend.test.ts`
- [ ] Timeout and signal handling are exercised in tests — verified by `packages/sandbox/tests/firecracker-backend.test.ts`
- [ ] Linting passes on all new and modified files — verified by `eslint packages/sandbox/src/backends/firecracker.ts`
- [ ] Full package build succeeds — verified by `pnpm --filter sandbox build`

## Files
- `packages/sandbox/src/types.ts`: Review `SandboxExecutor` interface for exact method signatures; add `FirecrackerBackendOptions` type with fields for `vcpuCount`, `memoryMb`, `kernelPath`, `rootfsPath`, `networkMode`
- `packages/sandbox/src/backends/gvisor.ts`: Read-only reference for interface patterns, lifecycle conventions, and error handling
- `packages/sandbox/src/backends/docker.ts`: Read-only reference for interface patterns, lifecycle conventions, and error handling
- `packages/sandbox/src/backends/firecracker.ts`: Create `FirecrackerBackend` class implementing `SandboxExecutor` — includes availability check, microVM lifecycle (spawn firecracker process, create API socket, configure boot source, start instance), exec support, stop/cleanup with resource teardown
- `packages/sandbox/src/backends/index.ts`: Export `FirecrackerBackend` and register it in the backend registry
- `packages/sandbox/src/fallback-chain.ts`: Insert Firecracker between Docker and Host in the ordered fallback array/registry
- `packages/sandbox/tests/firecracker-backend.test.ts`: Create unit tests covering availability detection (both kvm and binary present/absent), exec stdout/stderr/exitCode, timeout behavior, signal handling, and cleanup verification
- `packages/sandbox/tests/fallback-chain.test.ts`: Update to assert Firecracker is selected when gVisor and Docker are unavailable but Firecracker is available; assert Host remains last resort
- `packages/sandbox/package.json`: Review for needed dependencies (expected: none — using `child_process` only)
- `packages/sandbox/README.md`: Document Firecracker prerequisites (KVM enabled, `firecracker` binary, kernel image, rootfs), configuration options, and fallback position

## Execution Order
1. Review `types.ts`, `gvisor.ts`, and `docker.ts` to extract exact `SandboxExecutor` method signatures, lifecycle conventions, and module structure patterns
2. Add `FirecrackerBackendOptions` type to `types.ts` (after 1)
3. Implement `FirecrackerBackend` class in `backends/firecracker.ts` (after 1 and 2)
4. Export from `backends/index.ts` and insert into `fallback-chain.ts` at position 3 (after 3)
5. Write unit tests in `tests/firecracker-backend.test.ts` (after 3)
6. Update fallback chain tests in `tests/fallback-chain.test.ts` (after 4)
7. Update `README.md` with Firecracker documentation (after 3 and 4)

## Confirmed Decisions
- Root filesystem and kernel image source: User-confirmed option A — kernel and rootfs paths are user-supplied and configurable via `FirecrackerBackendOptions`
- Firecracker interaction method: Spawn the `firecracker` CLI binary directly via `child_process` using a temp Unix socket for API control — no SDK/library dependency
- Fallback chain modification: Insert Firecracker between Docker and Host, accepting this changes existing fallback behavior for consumers
- Networking model: Default to isolated loopback (no external network) for security; configurable override via `FirecrackerBackendOptions.networkMode`
- Default resource limits: 1 vCPU and 256 MiB memory; configurable via `FirecrackerBackendOptions.vcpuCount` and `FirecrackerBackendOptions.memoryMb`

Begin working on the tasks above. Verify each acceptance criterion before claiming completion.
```
