---
id: spec_1784867172_fe7482
createdAt: 2026-07-24T04:28:32.851Z
updatedAt: 2026-07-24T04:28:32.851Z
topic: firecracker microvm sandbox backend
trigger: explicit
status: confirmed
---

# Spec: firecracker microvm sandbox backend

## Goal

Add a Firecracker microVM sandbox backend to packages/sandbox that implements the existing SandboxExecutor interface and integrates into the auto fallback chain between Docker and Host.

## Constraints

- [hard|user] Must implement the existing SandboxExecutor interface
- [hard|user] Must slot into the fallback chain as gVisor -> Docker -> Firecracker -> Host
- [hard|codebase] Must reside within packages/sandbox directory structure
- [hard|convention] Should follow existing sandbox backend patterns for configuration, lifecycle, and error handling
- [hard|convention] Should include tests matching the existing test conventions for sandbox backends
- [hard|codebase] Firecracker requires a Linux host with KVM support; backend must detect availability and gracefully fail to allow fallback
- [soft|codebase] Firecracker binary and jailer must be provisioned or path-configurable via environment/config

## Acceptance Criteria

- [build] FirecrackerSandboxExecutor class implements SandboxExecutor interface with all required methods
- [test] Fallback chain ordering is gVisor -> Docker -> Firecracker -> Host
- [test] Backend gracefully reports unavailable when KVM or Firecracker binary is missing, allowing fallback to Host
- [test] Backend can start a microVM, execute a command, capture stdout/stderr/exit code, and tear down the VM
- [test] Resource limits (CPU, memory) are configurable and enforced via Firecracker machine config
- [test] No regressions in existing gVisor, Docker, or Host backends

## Affected Areas

- [create] packages/sandbox/src/firecracker — New Firecracker sandbox executor implementation
- [create] packages/sandbox/src/firecracker/FirecrackerSandboxExecutor.ts — Main executor class implementing SandboxExecutor
- [create] packages/sandbox/src/firecracker/firecracker-client.ts — Low-level client wrapping Firecracker API socket calls
- [create] packages/sandbox/src/firecracker/vm-config.ts — Configuration builder for machine config, kernel, rootfs, drives
- [create] packages/sandbox/src/firecracker/index.ts — Module exports and availability check function
- [modify] packages/sandbox/src/fallback-chain.ts — Insert Firecracker between Docker and Host in the chain
- [review] packages/sandbox/src/types.ts — Verify SandboxExecutor interface is sufficient or extend if needed
- [modify] packages/sandbox/src/config.ts — Add Firecracker-specific configuration fields (binary path, kernel path, rootfs path, vcpu, mem)
- [create] packages/sandbox/tests/firecracker — Test suite for the new backend
- [modify] packages/sandbox/tests/fallback-chain.test.ts — Update fallback chain tests to include Firecracker
- [modify] packages/sandbox/README.md — Document Firecracker backend setup and configuration

## Task Breakdown

t1. [design] Review existing SandboxExecutor interface and backend implementations to understand the contract and conventions.
t2. [design] Design FirecrackerSandboxExecutor class, VM lifecycle management, and config schema. (dependsOn: t1)
t3. [implement] Implement Firecracker API client for socket-based control of VM lifecycle (boot, exec, shutdown). (dependsOn: t2)
t4. [implement] Implement FirecrackerSandboxExecutor with availability detection, command execution, and resource enforcement. (dependsOn: t3)
t5. [implement] Update fallback chain to insert Firecracker between Docker and Host and add config fields. (dependsOn: t4)
t6. [test] Write unit and integration tests for availability, execution, resources, and fallback chain ordering. (dependsOn: t5)
t7. [doc] Update README with Firecracker setup, configuration, and troubleshooting instructions. (dependsOn: t6)

## Key Decisions

- [critical] Firecracker sandbox security defaults: networking disabled and jailer off by default (auto-resolved decisions affecting sandbox isolation boundary) — Chosen: A
- [major] Rootfs/kernel image provisioning strategy for Firecracker microVMs (auto-resolved to configurable path) — Chosen: A
- [major] Whether to extend the SandboxExecutor interface for Firecracker-specific capabilities or implement against the existing contract (spec marks this as user-resolved but resolution is empty) — Chosen: A
- [major] Structure of Firecracker-specific configuration fields in config.ts (binary path, kernel path, rootfs path, vcpu, mem) — config schema change that existing consumers may depend on — Chosen: A

## Enhanced Prompt

```
## Objective
Add a Firecracker microVM sandbox backend to `packages/sandbox` that implements the existing `SandboxExecutor` interface and integrates into the auto fallback chain between Docker and Host, with availability detection that gracefully fails when KVM or the Firecracker binary is absent.

## Constraints
- Must implement the existing `SandboxExecutor` interface without extending it — Firecracker-specific capabilities are handled internally, not through interface changes
- Must slot into the fallback chain as gVisor → Docker → Firecracker → Host
- Must reside within the `packages/sandbox/src/firecracker` directory structure
- Must follow existing sandbox backend patterns for configuration, lifecycle, and error handling (mirror gVisor and Docker implementations)
- Must include tests matching existing test conventions for sandbox backends
- Must detect Linux/KVM availability and Firecracker binary presence at runtime; report unavailable gracefully to allow fallback
- Firecracker binary and jailer paths must be configurable via environment/config
- Rootfs and kernel images are expected at a configurable path with sensible defaults — no auto-download or network fetching
- Networking inside the microVM must default to disabled (no network device attached) for isolation
- Jailer must be optional via config flag, defaulting to off to reduce initial complexity
- Resource limits (vCPU count, memory in MiB) must be configurable and enforced via Firecracker machine configuration
- Config schema additions (`firecracker.binaryPath`, `firecracker.kernelPath`, `firecracker.rootfsPath`, `firecracker.vcpu`, `firecracker.mem`, `firecracker.jailerEnabled`, `firecracker.networkEnabled`) must not break existing consumers — all new fields must be optional with defaults

## Acceptance Criteria
- [ ] `FirecrackerSandboxExecutor` class implements `SandboxExecutor` interface with all required methods
- [ ] `packages/sandbox/build` succeeds without TypeScript errors
- [ ] Fallback chain ordering is gVisor → Docker → Firecracker → Host (verified in `packages/sandbox/tests/fallback-chain.test.ts`)
- [ ] Backend gracefully reports unavailable when KVM or Firecracker binary is missing, allowing fallback to Host (verified in `packages/sandbox/tests/firecracker-availability.test.ts`)
- [ ] Backend can start a microVM, execute a command, capture stdout/stderr/exit code, and tear down the VM (verified in `packages/sandbox/tests/firecracker-execution.test.ts`)
- [ ] Resource limits (CPU, memory) are configurable and enforced via Firecracker machine config (verified in `packages/sandbox/tests/firecracker-resources.test.ts`)
- [ ] No regressions in existing gVisor, Docker, or Host backend tests (`packages/sandbox/tests/`)
- [ ] README documents Firecracker setup, configuration fields, and troubleshooting for missing KVM/binary

## Files
- `packages/sandbox/src/types.ts`: Review existing `SandboxExecutor` interface to confirm it is sufficient; do not modify unless a required method is missing for basic lifecycle (in which case, extend the interface and update all backends)
- `packages/sandbox/src/gvisor/`: Read-only reference for backend implementation patterns, config access, availability checks, and lifecycle management
- `packages/sandbox/src/docker/`: Read-only reference for backend implementation patterns, config access, availability checks, and lifecycle management
- `packages/sandbox/src/firecracker/`: Create directory for all Firecracker backend source files
- `packages/sandbox/src/firecracker/vm-config.ts`: Create configuration builder that assembles Firecracker machine config JSON (vcpu, mem, kernel, rootfs, drives) from config fields; network device omitted by default; jailer config constructed separately when enabled
- `packages/sandbox/src/firecracker/firecracker-client.ts`: Create low-level client that communicates with the Firecracker API Unix socket — methods for boot VM, execute command (via vsock or API actions), and shutdown; handle socket connection errors and timeouts
- `packages/sandbox/src/firecracker/FirecrackerSandboxExecutor.ts`: Create main executor class implementing `SandboxExecutor` — `isAvailable()` checks for `/dev/kvm`, Firecracker binary existence, and Linux host; `execute()` boots VM, runs command, captures stdout/stderr/exitCode, tears down VM; resource limits read from config and passed to VM config builder
- `packages/sandbox/src/firecracker/index.ts`: Create module barrel exports — export `FirecrackerSandboxExecutor` class and an `isFirecrackerAvailable()` helper function
- `packages/sandbox/src/config.ts`: Add optional `firecracker` section to config schema with fields: `binaryPath` (default `firecracker`), `kernelPath` (default `/var/lib/firecracker/vmlinux`), `rootfsPath` (default `/var/lib/firecracker/rootfs.ext4`), `vcpu` (default `1`), `mem` (default `512` MiB), `jailerEnabled` (default `false`), `networkEnabled` (default `false`)
- `packages/sandbox/src/fallback-chain.ts`: Modify to insert Firecracker executor between Docker and Host in the ordered fallback list; import from `./firecracker`
- `packages/sandbox/tests/firecracker/`: Create test directory with: `firecracker-availability.test.ts`, `firecracker-execution.test.ts`, `firecracker-resources.test.ts` — mock the Firecracker API client socket calls; follow existing test framework and mocking conventions used by gVisor/Docker tests
- `packages/sandbox/tests/fallback-chain.test.ts`: Modify to assert the four-level ordering gVisor → Docker → Firecracker → Host and that Firecracker is skipped when unavailable
- `packages/sandbox/README.md`: Add section covering: prerequisites (Linux, KVM, Firecracker binary), config fields table, security defaults (no network, no jailer), how to enable networking/jailer, and troubleshooting unavailable backend

## Execution Order
1. Review `packages/sandbox/src/types.ts` and existing gVisor/Docker backend implementations to understand the `SandboxExecutor` contract, config access patterns, availability check patterns, and test framework/mocking conventions
2. Design `FirecrackerSandboxExecutor` class shape, VM lifecycle state machine, and `vm-config.ts` schema (after 1)
3. Implement `firecracker-client.ts` with Unix socket API calls for VM boot, action calls, and shutdown (after 2)
4. Implement `FirecrackerSandboxExecutor.ts` and `index.ts` with availability detection, command execution, resource enforcement, and module exports (after 3)
5. Update `fallback-chain.ts` to insert Firecracker between Docker and Host, and update `config.ts` with Firecracker config fields (after 4)
6. Write tests in `packages/sandbox/tests/firecracker/` and update `packages/sandbox/tests/fallback-chain.test.ts` (after 5)
7. Update `packages/sandbox/README.md` with Firecracker setup, configuration, and troubleshooting documentation (after 6)

## Confirmed Decisions
- Sandbox security defaults: Networking disabled by default (no network device attached); jailer off by default — both opt-in via config flags
- Rootfs/kernel image provisioning: Expected at configurable path with sensible defaults; no auto-download or network fetching
- SandboxExecutor interface: Implement against the existing contract without extending it for Firecracker-specific capabilities
- Config schema: Add optional `firecracker` section with fields `binaryPath`, `kernelPath`, `rootfsPath`, `vcpu`, `mem`, `jailerEnabled`, `networkEnabled` — all optional with defaults, preserving backward compatibility for existing consumers
```
