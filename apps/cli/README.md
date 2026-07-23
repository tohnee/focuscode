# @focuscode/cli

Model-neutral terminal coding agent with native provider protocols, OAuth, multimodal input,
full-screen TUI, steering, extension/session sharing, and Docker/gVisor/VM isolation drivers.

```bash
npm install --global @focuscode/cli
focuscode --help
```

The npm package contains a standalone Node.js bundle. Node.js 22.12 or newer is required. The
default command sandbox is `auto` (gVisor, then Docker) with network disabled and no silent host
fallback. Use `focuscode sandbox doctor --kind auto` before the first coding task.

Registry publication requires ownership of the `@focuscode` npm scope. A tarball can always be
installed directly:

```bash
npm install --global ./focuscode-cli-0.4.0-beta.1.tgz
```
