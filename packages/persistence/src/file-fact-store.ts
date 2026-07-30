import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DomainEventSchema,
  KernelCheckpointSchema,
  assertSchema,
  newId,
  sha256Digest,
  type AppendAckV1,
  type AppendRequestV1,
  type DomainEventV1,
  type FactPort,
  type KernelCheckpointV1,
} from "@focuscode/contracts";

const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function assertTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Appends `content` and fsyncs before returning, so a committed record survives a crash. */
async function appendFileDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(content, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best-effort directory fsync so a rename stays durable across a crash. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms (e.g. Windows); the
    // rename is still atomic, so durability degrades gracefully there.
  }
}

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Event version conflict: expected ${expected}, actual ${actual}`);
    this.name = "VersionConflictError";
  }
}

export interface FileFactStoreOptions {
  /** Age after which an orphaned append lock is treated as stale and stolen. */
  lockTtlMs?: number;
  lockRetryAttempts?: number;
  lockRetryDelayMs?: number;
}

export class FileFactStore implements FactPort {
  private readonly lockTtlMs: number;
  private readonly lockRetryAttempts: number;
  private readonly lockRetryDelayMs: number;

  constructor(
    readonly rootDirectory: string,
    options: FileFactStoreOptions = {},
  ) {
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.lockRetryAttempts = options.lockRetryAttempts ?? 200;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? 10;
  }

  private taskDirectory(taskId: string): string {
    assertTaskId(taskId);
    return join(this.rootDirectory, "tasks", taskId);
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const directory = this.taskDirectory(taskId);
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, ".append.lock");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < this.lockRetryAttempts && !handle; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await this.tryStealStaleLock(lockPath))) {
          await new Promise((resolve) => setTimeout(resolve, this.lockRetryDelayMs));
        }
      }
    }
    if (!handle) throw new Error(`Timed out acquiring event lock for ${taskId}`);
    try {
      // The lock records its owner and acquisition time so a later process can
      // reclaim it after a crash (the lock file itself survives process death).
      await handle.write(
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
        null,
        "utf8",
      );
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  /**
   * Steals the lock only when it is provably stale (acquiredAt older than the
   * TTL). An unparseable lock is left alone: fail safe and keep waiting.
   */
  private async tryStealStaleLock(lockPath: string): Promise<boolean> {
    let owner: unknown;
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch {
      return false;
    }
    const acquiredAtRaw = (owner as { acquiredAt?: unknown } | null)?.acquiredAt;
    const acquiredAt = typeof acquiredAtRaw === "string" ? Date.parse(acquiredAtRaw) : Number.NaN;
    if (!Number.isFinite(acquiredAt)) return false;
    if (Date.now() - acquiredAt <= this.lockTtlMs) return false;
    await unlink(lockPath).catch(() => undefined);
    return true;
  }

  async append(request: AppendRequestV1): Promise<AppendAckV1> {
    if (request.events.length === 0) {
      return { firstSeq: request.expectedVersion, lastSeq: request.expectedVersion, events: [] };
    }
    return this.withTaskLock(request.taskId, async () => {
      const existing = await this.loadEvents(request.taskId);
      if (existing.length !== request.expectedVersion) {
        throw new VersionConflictError(request.expectedVersion, existing.length);
      }
      const committed = request.events.map((event, offset): DomainEventV1 => {
        if (event.taskId !== request.taskId) {
          throw new Error(`Event ${event.eventId} belongs to a different task`);
        }
        const eventWithoutDigest = { ...event, seq: request.expectedVersion + offset + 1 };
        const committedEvent = {
          ...eventWithoutDigest,
          digest: sha256Digest(eventWithoutDigest),
        };
        assertSchema(DomainEventSchema, committedEvent, "domain event");
        return committedEvent;
      });
      const eventPath = join(this.taskDirectory(request.taskId), "events.jsonl");
      await appendFileDurable(
        eventPath,
        `${committed.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      return {
        firstSeq: committed[0]?.seq ?? request.expectedVersion,
        lastSeq: committed.at(-1)?.seq ?? request.expectedVersion,
        events: committed,
      };
    });
  }

  async loadEvents(taskId: string, afterSeq = 0): Promise<DomainEventV1[]> {
    const path = join(this.taskDirectory(taskId), "events.jsonl");
    if (!(await exists(path))) return [];
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const events: DomainEventV1[] = [];
    for (const [index, line] of lines.entries()) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        if (index === lines.length - 1) {
          // Torn tail: a crash mid-append can leave a partial final line that was
          // never fully committed. Drop it and truncate the file back to the last
          // valid newline so a subsequent append does not bury the partial line in
          // the middle of the log (which would turn it into a non-tail corruption
          // and fail-closed on the next read). Corruption of any earlier line
          // stays fail-closed. When called from append() the task lock is already
          // held, so the truncation is performed under the lock.
          console.warn(`Repairing torn final event line ${index + 1} in ${path}`);
          const validLines = lines.slice(0, index);
          const validText = validLines.length > 0 ? `${validLines.join("\n")}\n` : "";
          const offset = Buffer.byteLength(validText, "utf8");
          await truncate(path, offset);
          const syncHandle = await open(path, "r");
          try {
            await syncHandle.sync();
          } finally {
            await syncHandle.close();
          }
          continue;
        }
        throw new Error(`Invalid event JSON at ${path}:${index + 1}`);
      }
      assertSchema(DomainEventSchema, event, `event line ${index + 1}`);
      const committed = event as DomainEventV1;
      const { digest, ...unsigned } = committed;
      if (sha256Digest(unsigned) !== digest) {
        throw new Error(
          `Event digest mismatch at seq ${committed.seq} in ${path}: event log is corrupt or tampered`,
        );
      }
      events.push(committed);
    }
    return events.filter((event) => event.seq > afterSeq);
  }

  async loadCheckpoint(taskId: string): Promise<KernelCheckpointV1 | undefined> {
    const path = join(this.taskDirectory(taskId), "checkpoint.json");
    if (!(await exists(path))) return undefined;
    const checkpoint: unknown = JSON.parse(await readFile(path, "utf8"));
    assertSchema(KernelCheckpointSchema, checkpoint, "kernel checkpoint");
    return checkpoint;
  }

  async saveCheckpoint(checkpoint: KernelCheckpointV1): Promise<void> {
    assertSchema(KernelCheckpointSchema, checkpoint, "kernel checkpoint");
    const directory = this.taskDirectory(checkpoint.taskId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, "checkpoint.json");
    const temporary = join(directory, `checkpoint.${newId("tmp")}.json`);
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.write(`${JSON.stringify(checkpoint, null, 2)}\n`, null, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(directory);
  }

  async listTaskIds(): Promise<string[]> {
    const directory = join(this.rootDirectory, "tasks");
    if (!(await exists(directory))) return [];
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && TASK_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }
}
