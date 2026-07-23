import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const checkMode = process.argv.includes("--check");

const contractsEntryUrl = new URL("../packages/contracts/dist/index.js", import.meta.url);
try {
  await access(fileURLToPath(contractsEntryUrl));
} catch {
  // `pnpm lint` runs before any build on a clean checkout; build contracts on demand.
  const build = spawnSync("pnpm", ["--filter", "@focuscode/contracts", "build"], {
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const {
  ActionIntentSchema,
  CapabilityGrantSchema,
  DomainEventSchema,
  EffectReceiptSchema,
  ExecutionContextSchema,
  KernelCheckpointSchema,
  MemoryRecordSchema,
  ModelDecisionSchema,
  TaskSpecSchema,
  TurnInputSchema,
  VerificationReportSchema,
} = await import(contractsEntryUrl.href);

const directory = fileURLToPath(new URL("../docs/schemas", import.meta.url));
const schemas = new Map([
  ["task-spec.v1", TaskSpecSchema],
  ["execution-context.v1", ExecutionContextSchema],
  ["model-decision.v1", ModelDecisionSchema],
  ["action-intent.v1", ActionIntentSchema],
  ["capability-grant.v1", CapabilityGrantSchema],
  ["effect-receipt.v1", EffectReceiptSchema],
  ["domain-event.v1", DomainEventSchema],
  ["kernel-checkpoint.v1", KernelCheckpointSchema],
  ["memory-record.v1", MemoryRecordSchema],
  ["turn-input.v1", TurnInputSchema],
  ["verification-report.v1", VerificationReportSchema],
]);

function schemaDocument(id, schema) {
  return { $schema: "http://json-schema.org/draft-07/schema#", $id: id, ...schema };
}

if (!checkMode) {
  await mkdir(directory, { recursive: true });
  for (const [id, schema] of schemas) {
    const document = schemaDocument(id, schema);
    await writeFile(
      resolve(directory, `${id}.schema.json`),
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }
  process.stdout.write(`Exported ${schemas.size} canonical schemas to ${directory}\n`);
} else {
  const generated = await mkdtemp(join(tmpdir(), "focus-schemas-check-"));
  try {
    const drifted = [];
    for (const [id, schema] of schemas) {
      const document = schemaDocument(id, schema);
      await writeFile(
        join(generated, `${id}.schema.json`),
        `${JSON.stringify(document, null, 2)}\n`,
      );
      let committed;
      try {
        committed = JSON.parse(await readFile(resolve(directory, `${id}.schema.json`), "utf8"));
      } catch {
        committed = undefined;
      }
      // Parsed deep comparison ignores formatting-only differences such as line wraps.
      // The generated document is normalized through JSON because TypeBox schemas carry
      // symbol properties (Symbol(TypeBox.Kind)) that JSON serialization drops.
      const normalized = JSON.parse(await readFile(join(generated, `${id}.schema.json`), "utf8"));
      if (!isDeepStrictEqual(normalized, committed)) drifted.push(`${id}.schema.json`);
    }
    if (drifted.length > 0) {
      process.stderr.write(
        `Schema drift detected in ${drifted.length} file(s):\n` +
          `${drifted.map((name) => `- docs/schemas/${name}`).join("\n")}\n` +
          "Run `pnpm schemas` and commit the regenerated docs/schemas/.\n",
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`All ${schemas.size} canonical schemas are in sync with ${directory}\n`);
    }
  } finally {
    await rm(generated, { recursive: true, force: true });
  }
}
