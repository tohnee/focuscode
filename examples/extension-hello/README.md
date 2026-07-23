# Hello FocusCode extension

Pack and install the example locally:

```bash
focuscode extension pack examples/extension-hello --out ./dist
focuscode extension install ./dist/focuscode-example-hello-extension-0.1.0.tgz --allow-unsigned
```

Unsigned local extensions are intentionally not loaded while
`requireExtensionSignatures` is true. For development only, set that configuration to false,
then start FocusCode and use `/hello Ada`.
