import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CheckpointFileEntry {
  path: string;
  existed: boolean;
}

export interface CheckpointManifest {
  schemaVersion: "focuscode-checkpoint.v1";
  seq: number;
  label: string;
  createdAt: string;
  files: CheckpointFileEntry[];
}

export interface CheckpointSummary {
  seq: number;
  label: string;
  createdAt: string;
  files: number;
}

const SCHEMA_VERSION = "focuscode-checkpoint.v1";
const DEFAULT_MAX_CHECKPOINTS = 50;

/**
 * File-level undo history for one session: each capture snapshots the listed
 * workspace files (and records which ones did not exist yet) into
 * <rootDir>/<seq>/, so restoreLatest() can roll the most recent batch back.
 */
export class CheckpointStore {
  private readonly rootDir: string;
  private readonly workspaceRoot: string;
  private readonly maxCheckpoints: number;

  constructor(options: { rootDir: string; workspaceRoot: string; maxCheckpoints?: number }) {
    this.rootDir = resolve(options.rootDir);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
  }

  async capture(label: string, files: string[]): Promise<CheckpointManifest | undefined> {
    const targets = [
      ...new Set(files.map((file) => this.normalize(file)).filter((file) => file !== undefined)),
    ];
    if (targets.length === 0) return undefined;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const seq = (await this.latestSeq()) + 1;
    const directory = join(this.rootDir, String(seq));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries: CheckpointFileEntry[] = [];
    for (const path of targets) {
      let existed = false;
      try {
        const source = resolve(this.workspaceRoot, path);
        if ((await stat(source)).isFile()) {
          const destination = join(directory, path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await copyFile(source, destination);
          await chmod(destination, 0o600);
          existed = true;
        }
      } catch {
        existed = false;
      }
      entries.push({ path, existed });
    }
    const manifest: CheckpointManifest = {
      schemaVersion: SCHEMA_VERSION,
      seq,
      label,
      createdAt: new Date().toISOString(),
      files: entries,
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await this.evict();
    return manifest;
  }

  async list(): Promise<CheckpointSummary[]> {
    const summaries: CheckpointSummary[] = [];
    for (const seq of await this.sequences()) {
      const manifest = await this.readManifest(seq);
      if (manifest) {
        summaries.push({
          seq: manifest.seq,
          label: manifest.label,
          createdAt: manifest.createdAt,
          files: manifest.files.length,
        });
      }
    }
    return summaries;
  }

  /** Preview the most recent checkpoint without restoring it. */
  async undo(): Promise<CheckpointManifest | undefined> {
    const seq = await this.latestSeq();
    return seq === 0 ? undefined : this.readManifest(seq);
  }

  /** Restore the most recent checkpoint and remove it from the store. */
  async restoreLatest(): Promise<CheckpointManifest | undefined> {
    const seq = await this.latestSeq();
    if (seq === 0) return undefined;
    const manifest = await this.readManifest(seq);
    if (!manifest) return undefined;
    const directory = join(this.rootDir, String(seq));
    for (const entry of manifest.files) {
      const target = resolve(this.workspaceRoot, entry.path);
      if (entry.existed) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(directory, entry.path), target);
      } else {
        await rm(target, { force: true });
      }
    }
    await rm(directory, { recursive: true, force: true });
    return manifest;
  }

  private normalize(file: string): string | undefined {
    if (!file || file.includes("\0") || isAbsolute(file)) return undefined;
    const candidate = resolve(this.workspaceRoot, file);
    if (candidate !== this.workspaceRoot && !candidate.startsWith(`${this.workspaceRoot}${sep}`)) {
      return undefined;
    }
    const relativePath = relative(this.workspaceRoot, candidate).split(sep).join("/");
    return relativePath || undefined;
  }

  private async sequences(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .sort((left, right) => left - right);
  }

  private async latestSeq(): Promise<number> {
    const sequences = await this.sequences();
    return sequences.at(-1) ?? 0;
  }

  private async readManifest(seq: number): Promise<CheckpointManifest | undefined> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(this.rootDir, String(seq), "manifest.json"), "utf8"),
      );
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as CheckpointManifest).schemaVersion !== SCHEMA_VERSION
      ) {
        return undefined;
      }
      return parsed as CheckpointManifest;
    } catch {
      return undefined;
    }
  }

  private async evict(): Promise<void> {
    const sequences = await this.sequences();
    const overflow = sequences.length - this.maxCheckpoints;
    for (const seq of sequences.slice(0, Math.max(0, overflow))) {
      await rm(join(this.rootDir, String(seq)), { recursive: true, force: true });
    }
  }
}
