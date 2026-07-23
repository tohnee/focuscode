import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const rules = [
  {
    directory: "packages/contracts/src",
    forbidden: ["@focuscode/", "fastify", "dockerode", "openai", "@anthropic-ai"],
  },
  {
    directory: "packages/harness-core/src",
    forbidden: [
      "node:fs",
      "node:child_process",
      "@focuscode/action-backends",
      "@focuscode/model-gateway",
      "fetch(",
    ],
  },
  {
    directory: "packages/model-gateway/src",
    forbidden: ["@focuscode/action-backends", "@focuscode/action-domain"],
  },
  {
    directory: "packages/agent-runtime/src",
    forbidden: [
      "@focuscode/harness-core",
      "@focuscode/model-gateway",
      "@focuscode/persistence",
      "@focuscode/sdk",
      "@focuscode/auth",
      "@focuscode/ecosystem",
      "@focuscode/sandbox",
      "@focuscode/tui",
      "/apps/",
    ],
  },
  {
    directory: "packages/auth/src",
    forbidden: ["@focuscode/", "/apps/"],
  },
  {
    directory: "packages/ecosystem/src",
    forbidden: ["@focuscode/", "/apps/"],
  },
  {
    directory: "packages/sandbox/src",
    forbidden: ["@focuscode/", "/apps/"],
  },
  {
    directory: "packages/tui/src",
    forbidden: ["@focuscode/", "/apps/"],
  },
  {
    directory: "packages/protocols/src",
    forbidden: ["@focuscode/persistence", "@focuscode/action-backends", "@focuscode/harness-core"],
  },
];

const failures = [];
for (const rule of rules) {
  for (const path of await sourceFiles(join(root, rule.directory))) {
    const content = await readFile(path, "utf8");
    for (const token of rule.forbidden) {
      if (content.includes(token))
        failures.push(`${relative(root, path)} imports/uses forbidden token ${token}`);
    }
    if (/from\s+["'][^"']*\/apps\//.test(content)) {
      failures.push(`${relative(root, path)} imports an application package`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Architecture boundary violations:\n${failures.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Architecture boundary check passed.\n");
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}
