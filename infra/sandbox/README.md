# FocusCode isolated command image

Build locally:

```bash
docker build -t focuscode/sandbox:node22 infra/sandbox
focuscode sandbox doctor --kind docker --image focuscode/sandbox:node22
```

For gVisor, install `runsc` as a Docker runtime and run:

```bash
focuscode sandbox doctor --kind gvisor --image focuscode/sandbox:node22
focuscode --sandbox gvisor --sandbox-image focuscode/sandbox:node22
```

The driver uses a read-only container root, isolated `/tmp`, all capabilities dropped,
`no-new-privileges`, bounded processes/memory/CPU, and network disabled by default. The
workspace bind mount remains writable unless configured read-only because coding tasks must
persist edits.
