import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Digest, type FactPort } from "@focuscode/contracts";
import { FileMemoryStore } from "./memory-store.js";

export interface AssetExportManifestV1 {
  schemaVersion: "asset-export.v1";
  taskId: string;
  createdAt: string;
  files: Array<{ path: string; digest: `sha256:${string}`; records: number }>;
  portable: true;
  excluded: string[];
}

export async function exportTaskAssets(options: {
  taskId: string;
  facts: FactPort;
  memory: FileMemoryStore;
  outputDirectory: string;
  now?: () => Date;
}): Promise<AssetExportManifestV1> {
  await mkdir(options.outputDirectory, { recursive: true });
  const events = await options.facts.loadEvents(options.taskId);
  const checkpoint = await options.facts.loadCheckpoint(options.taskId);
  const memories = await options.memory.listRecords();
  const files: AssetExportManifestV1["files"] = [];
  const writeJsonl = async (name: string, records: unknown[]): Promise<void> => {
    const content = records.length
      ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
      : "";
    await writeFile(join(options.outputDirectory, name), content, "utf8");
    files.push({ path: name, digest: sha256Digest(content), records: records.length });
  };
  await writeJsonl("events.jsonl", events);
  await writeJsonl("memory.jsonl", memories);
  await writeJsonl("checkpoint.jsonl", checkpoint ? [checkpoint] : []);
  const manifest: AssetExportManifestV1 = {
    schemaVersion: "asset-export.v1",
    taskId: options.taskId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    files,
    portable: true,
    excluded: ["provider session", "hidden reasoning", "transport cache", "host handles"],
  };
  await writeFile(
    join(options.outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
