---
id: spec_1784821602_c5be32
createdAt: 2026-07-23T15:48:23.041Z
updatedAt: 2026-07-23T15:48:23.041Z
topic: Firecracker microVM sandbox backend
trigger: explicit
status: confirmed
---

# Spec: Firecracker microVM sandbox backend

## Goal

Add a Firecracker microVM sandbox backend to packages/sandbox that implements the existing SandboxExecutor interface and participates in the auto fallback chain (gVisor -> Docker -> Firecracker -> Host).

## Constraints

- [hard|user] Must implement the existing SandboxExecutor interface
- [hard|user] Must integrate into the fallback chain in the order: gVisor -> Docker -> Firecracker -> Host
- [hard|codebase] Must follow existing backend structure in packages/sandbox (likely mirroring gVisor/Docker backends)
- [soft|codebase] Existing backends may expose a registration or factory pattern that the new backend must use
- [soft|convention] Firecracker binary must be discoverable on PATH or via config; availability check used for fallback eligibility
- [hard|convention] Sandbox lifecycle (create, start, exec, stop, destroy) must match existing backends

## Acceptance Criteria

- [lint] FirecrackerSandboxExecutor class implements SandboxExecutor interface
- [test] Backend is registered in the fallback chain after Docker and before Host
- [test] Availability check returns false when firecracker binary is absent so fallback proceeds
- [test] Executes a simple command inside a Firecracker microVM and returns stdout/stderr/exitCode
- [test] Sandbox is destroyed and VM resources (socket, pid) are cleaned up after stop
- [build] Package builds without errors

## Affected Areas

- [create] packages/sandbox/src/backends/firecracker/index.ts — New FirecrackerSandboxExecutor implementation
- [create] packages/sandbox/src/backends/firecracker/firecracker-vm.ts — VM lifecycle management (boot, configure, stop)
- [create] packages/sandbox/src/backends/firecracker/api-client.ts — HTTP client for Firecracker API socket
- [create] packages/sandbox/src/backends/firecracker/availability.ts — Binary/config availability check for fallback eligibility
- [modify] packages/sandbox/src/backends/index.ts — Register Firecracker backend in backend registry
- [modify] packages/sandbox/src/fallback-chain.ts — Insert Firecracker after Docker in chain order
- [review] packages/sandbox/src/types.ts — Check SandboxExecutor interface and SandboxConfig for Firecracker-specific fields
- [create] packages/sandbox/**tests**/firecracker-exec.test.ts — Integration/exec test for Firecracker backend
- [modify] packages/sandbox/**tests**/fallback-chain.test.ts — Update fallback chain test to include Firecracker
- [modify] packages/sandbox/README.md — Document Firecracker backend and prerequisites

## Task Breakdown

t1. [design] Review existing SandboxExecutor interface and Docker/gVisor backend structure to confirm contract
t2. [implement] Implement Firecracker API HTTP client for the unix socket (dependsOn: t1)
t3. [implement] Implement VM lifecycle manager (boot config, start, stop, resource cleanup) (dependsOn: t2)
t4. [implement] Implement FirecrackerSandboxExecutor satisfying the SandboxExecutor interface, including availability check (dependsOn: t3)
t5. [refactor] Register backend and insert Firecracker into fallback chain after Docker (dependsOn: t4)
t6. [test] Add unit/integration tests for availability, exec, cleanup, and updated fallback chain (dependsOn: t5)
t7. [doc] Update README with Firecracker prerequisites and config (dependsOn: t5)

## Key Decisions

- [major] How Firecracker kernel image and rootfs are supplied to the microVM — Chosen: A
- [critical] Whether networking is enabled inside the microVM or it runs in detached/vsock-only mode — Chosen: A
- [major] Whether SandboxConfig or SandboxExecutor interface needs Firecracker-specific fields, which would break existing consumers — Chosen: A
- [major] VM lifecycle strategy: spawn a new microVM per exec call versus pool/reuse VMs across execs — Chosen: A
- [major] Inserting Firecracker into the fallback chain between Docker and Host changes existing consumer behavior when Docker is unavailable — Chosen: A

## Enhanced Prompt

```
## Objective
Add a Firecracker microVM sandbox backend to `packages/sandbox` that implements the existing `SandboxExecutor` interface and participates in the auto fallback chain in the order gVisor → Docker → Firecracker → Host. The backend spawns a fresh microVM per exec call, uses vsock-only networking, and sources kernel/rootfs images via environment configuration without modifying the shared `SandboxExecutor` interface.

## Constraints
- Must implement the existing `SandboxExecutor` interface without adding new required methods or fields to it
- Must integrate into the fallback chain in the exact order: gVisor → Docker → Firecracker → Host
- Must follow the existing backend directory/structure pattern established by gVisor and Docker backends under `packages/sandbox/src/backends/`
- Firecracker binary must be discoverable on `PATH` or via a config env var; the availability check must return `false` when absent so the fallback chain proceeds to Host
- Sandbox lifecycle methods (create, exec, stop, destroy) must match the signatures and return shapes of existing backends
- Kernel image and rootfs paths are supplied via environment variables (e.g., `FIRECRACKER_KERNEL_PATH`, `FIRECRACKER_ROOTFS_PATH`); if unset, the backend reports as unavailable
- MicroVMs run in detached/vsock-only mode with no network interface configured inside the guest
- A new microVM is spawned per `exec` call and torn down afterward; no VM pooling or reuse in this iteration
- Firecracker API is communicated with over its Unix socket using HTTP PUT requests
- All new files must be TypeScript and pass existing `tsc` and `eslint` configurations for `packages/sandbox`
- Tests must not require an actual Firecracker binary or kernel image to run; mock or stub the subprocess and HTTP client layer in unit tests

## Acceptance Criteria
- [ ] `FirecrackerSandboxExecutor` class in `packages/sandbox/src/backends/firecracker/index.ts` implements every method of the `SandboxExecutor` interface; `tsc --noEmit` and `eslint` pass on `packages/sandbox`
- [ ] Fallback chain in `packages/sandbox/src/fallback-chain.ts` lists Firecracker after Docker and before Host; `packages/sandbox/__tests__/fallback-chain.test.ts` asserts this order
- [ ] `isAvailable()` returns `false` when the `firecracker` binary is not found on PATH or when env vars are unset; `packages/sandbox/__tests__/firecracker-availability.test.ts` covers both cases
- [ ] `exec()` spawns a microVM, runs a command inside it, and returns an object containing `stdout`, `stderr`, and `exitCode`; `packages/sandbox/__tests__/firecracker-exec.test.ts` verifies this with mocked Firecracker API responses
- [ ] `stop()` / `destroy()` terminates the VM process and removes the Unix socket file and PID file; `packages/sandbox/__tests__/firecracker-cleanup.test.ts` confirms resources are gone after cleanup
- [ ] `pnpm build --filter @sage/sandbox` completes with zero errors
- [ ] `packages/sandbox/README.md` documents Firecracker prerequisites (binary, kernel image, rootfs), required environment variables, and the vsock-only networking constraint

## Files
- `packages/sandbox/src/types.ts`: Review to confirm exact `SandboxExecutor` interface shape and `SandboxConfig` fields. Do NOT add new required fields to the interface. If Firecracker-specific config is needed, extend via an optional field or pass through environment variables only.
- `packages/sandbox/src/backends/firecracker/api-client.ts`: Create. HTTP client that communicates with the Firecracker API over a Unix socket. Must support `PUT` requests for `/boot-source`, `/drives`, `/machine-config`, `/vsock`, `/actions`, and `/logger`.
- `packages/sandbox/src/backends/firecracker/firecracker-vm.ts`: Create. VM lifecycle manager: generates a unique VM ID, creates a temp directory for socket/pid, builds boot configuration (kernel path, kernel cmdline for vsock-only console=ttyS0, rootfs drive), starts the Firecracker process, waits for API readiness, issues boot via API client, and handles stop/destroy with resource cleanup.
- `packages/sandbox/src/backends/firecracker/availability.ts`: Create. Exports a function that checks for the `firecracker` binary on PATH (via `which`/`command -v`) and for required env vars (`FIRECRACKER_KERNEL_PATH`, `FIRECRACKER_ROOTFS_PATH`); returns `boolean`.
- `packages/sandbox/src/backends/firecracker/index.ts`: Create. `FirecrackerSandboxExecutor` class implementing `SandboxExecutor`. Uses `availability` for `isAvailable()`, `firecracker-vm` for lifecycle, `api-client` for API calls. Each `exec` call creates a new VM, runs the command via vsock serial console or API exec mechanism, collects output, then destroys the VM.
- `packages/sandbox/src/backends/index.ts`: Modify. Import and export `FirecrackerSandboxExecutor` alongside existing backends, following the same registration/factory pattern used by gVisor and Docker.
- `packages/sandbox/src/fallback-chain.ts`: Modify. Insert `FirecrackerSandboxExecutor` in the chain array after Docker and before Host.
- `packages/sandbox/__tests__/firecracker-exec.test.ts`: Create. Test that `exec()` returns `stdout`/`stderr`/`exitCode` using mocked Firecracker API client and mocked child process. Verify the VM is destroyed after exec completes.
- `packages/sandbox/__tests__/fallback-chain.test.ts`: Modify. Add assertion that the chain contains Firecracker at index after Docker and before Host. Verify that when gVisor and Docker are unavailable and Firecracker is available, Firecracker is selected.
- `packages/sandbox/README.md`: Modify. Add a "Firecracker Backend" section covering: binary installation, kernel/rootfs image acquisition, required env vars, vsock-only mode explanation, and fallback chain position.
- `packages/sandbox/src/backends/gvisor/` and `packages/sandbox/src/backends/docker/`: Read-only reference. Study their structure, method signatures, return types, and registration pattern to mirror in the Firecracker backend.

## Execution Order
1. Review `packages/sandbox/src/types.ts` and existing gVisor/Docker backends to confirm the `SandboxExecutor` interface contract, return shapes, and registration pattern
2. Implement `api-client.ts` — Firecracker HTTP-over-Unix-socket client (after 1)
3. Implement `firecracker-vm.ts` — VM lifecycle manager (after 2)
4. Implement `availability.ts` and `index.ts` — `FirecrackerSandboxExecutor` class with availability check (after 3)
5. Register backend in `backends/index.ts` and insert into `fallback-chain.ts` (after 4)
6. Write tests: `firecracker-exec.test.ts`, update `fallback-chain.test.ts` (after 5)
7. Update `README.md` with Firecracker documentation (after 5)
8. Run `pnpm build --filter @sage/sandbox`, `tsc --noEmit`, `eslint`, and the test suite to verify all acceptance criteria (after 6, 7)

## Confirmed Decisions
- Kernel image and rootfs supply: Provided via environment variables (`FIRECRACKER_KERNEL_PATH`, `FIRECRACKER_ROOTFS_PATH`); the backend checks these in `isAvailable()` and reports unavailable if either is missing
- Networking mode: Vsock-only / detached mode — no network interface is configured inside the microVM; communication uses vsock for command I/O
- Interface compatibility: No new required fields added to `SandboxExecutor` or `SandboxConfig`; Firecracker-specific configuration is passed entirely through environment variables to avoid breaking existing consumers
- VM lifecycle strategy: Spawn a new microVM per `exec` call and destroy it immediately after; no VM pooling or reuse in this iteration
- Fallback chain insertion: Firecracker is inserted between Docker and Host; this is accepted as a behavior change for consumers where Docker is unavailable — they will now attempt Firecracker before falling back to Host

Begin working on the tasks above. Verify each acceptance criterion before claiming completion.
```
