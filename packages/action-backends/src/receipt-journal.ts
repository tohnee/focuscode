import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { EffectReceiptV1 } from "@focuscode/contracts";

/**
 * Durable sink for effect receipts. The runtime appends every receipt before
 * returning it to the caller (receipt-before-result), so a crash after the
 * side effect but before the model observes the tool result still leaves the
 * receipt on disk for audit and manual reconciliation.
 */
export interface ReceiptJournal {
  append(receipt: EffectReceiptV1): Promise<void>;
  load(): Promise<EffectReceiptV1[]>;
}

/**
 * Append-only JSONL receipt journal with fsync on every append. Torn tails are
 * tolerated only on the final line (a crash mid-write); a corrupt line anywhere
 * else fails closed, matching the persistence hardening rules.
 *
 * Note: this is the durability floor, not full exactly-once reconciliation.
 * It guarantees receipts survive a crash so recovery can inspect what ran;
 * classifying UNKNOWN effects and auto-retrying idempotent actions is deferred
 * to the unified EffectBroker sprint.
 */
export class FileReceiptJournal implements ReceiptJournal {
  constructor(private readonly filePath: string) {}

  async append(receipt: EffectReceiptV1): Promise<void> {
    // Receipts carry tool arguments, commands and outputs: the journal must be
    // private to the user (0o600, matching the session store and fact store).
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(receipt) + "\n";
    const handle = await open(this.filePath, "a", 0o600);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async load(): Promise<EffectReceiptV1[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = text.split("\n");
    const receipts: EffectReceiptV1[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        receipts.push(JSON.parse(line) as EffectReceiptV1);
      } catch (error) {
        const isLastLine =
          index === lines.length - 1 || !lines.slice(index + 1).some((l) => l.trim());
        if (isLastLine) break; // torn tail from a crash mid-append
        throw new Error(
          `Corrupt receipt journal line ${index + 1} in ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return receipts;
  }
}
