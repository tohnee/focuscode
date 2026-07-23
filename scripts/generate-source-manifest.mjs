import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const outputName = "SOURCE_MANIFEST.sha256";
// Directories that are build artifacts, local-only state, or otherwise not part
// of the distributed source tree. Kept in sync with .gitignore / .prettierignore
// so the manifest attests the source tree, not generated or machine-specific output.
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  ".tmp",
  ".git",
  "coverage",
  "bundle", // apps/cli/bundle (built npm artifact)
  "model-packs", // apps/cli/model-packs (generated pack)
  ".focuscode", // local user/agent config, machine-specific
  ".focuscode-state",
]);
const ignoredFiles = new Set([".DS_Store"]);
const ignoredFilePatterns = [/\.log$/i, /\.tgz$/i];
const files = await walk(root);
const rows = [];
for (const path of files.sort()) {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  if (relativePath === outputName) continue;
  if (
    relativePath.startsWith("reports/coverage/") &&
    relativePath !== "reports/coverage/coverage-summary.json"
  ) {
    continue;
  }
  // reports/npm holds generated tarballs and machine-specific absolute-path logs.
  if (relativePath.startsWith("reports/npm/")) continue;
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  rows.push(`${digest}  ${relativePath}`);
}
await writeFile(join(root, outputName), `${rows.join("\n")}\n`, "utf8");
process.stdout.write(`Wrote ${rows.length} entries to ${outputName}\n`);

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path)));
    else if (entry.isFile()) {
      if (ignoredFiles.has(entry.name)) continue;
      if (ignoredFilePatterns.some((pattern) => pattern.test(entry.name))) continue;
      output.push(path);
    }
  }
  return output;
}
