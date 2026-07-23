import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "apps", "cli", "bundle");
const output = resolve(outputDirectory, "focuscode.mjs");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "apps", "cli", "src", "index.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  sourcemap: false,
  legalComments: "none",
});
await chmod(output, 0o755);

// The audited-kernel path loads its default Model Pack at runtime; ship it
// alongside the bundle so `focuscode run` works from the published tarball.
const packAssets = resolve(root, "apps", "cli", "model-packs");
await rm(packAssets, { recursive: true, force: true });
await cp(resolve(root, "model-packs", "generic-openai"), resolve(packAssets, "generic-openai"), {
  recursive: true,
});
process.stdout.write("Built standalone npm CLI: " + output + "\n");
