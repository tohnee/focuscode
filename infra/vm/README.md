# FocusCode disposable VM target

`cloud-init.yaml` creates a non-sudo `focuscode` user and a workspace mount point. Replace the
placeholder public key before provisioning. Attach a per-task disk or virtiofs/9p share at
`/mnt/focuscode-workspace`, and configure network policy outside the guest.

The image must provide POSIX `sh`, `env` and GNU `timeout`. The reference also installs Git,
Node.js/npm, Python and ripgrep.

```bash
focuscode sandbox doctor --kind vm \
  --vm-host focuscode@VM_ADDRESS \
  --vm-workspace /mnt/focuscode-workspace \
  --vm-identity /secure/path/focuscode_vm
```

The orchestrator, not FocusCode v0.3, owns VM creation, host-key enrollment, workspace attachment,
network isolation, lease expiry, disk wipe and destruction. Do not reuse a VM across mutually
untrusted tasks.
