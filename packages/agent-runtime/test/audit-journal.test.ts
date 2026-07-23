import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  EnvAuditKeyProvider,
  FileAuditJournal,
  verifyAuditJournal,
  type AuditKeyProvider,
} from "../src/index.js";

describe("enterprise audit journal", () => {
  it("writes a redacted HMAC chain and detects tampering", async () => {
    const directory = await createTestDirectory("agent-audit");
    const key = "k".repeat(48);
    const journal = new FileAuditJournal({
      directory,
      hmacKey: key,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    await journal.record("session_fixture", { type: "text_delta", delta: "secret response" });
    await journal.record("session_fixture", {
      type: "tool_end",
      call: { id: "c1", name: "bash", arguments: { command: "echo secret" } },
      result: { content: "credential=secret" },
      durationMs: 4,
    });
    const path = join(directory, "session_fixture.audit.jsonl");
    const source = await readFile(path, "utf8");
    expect(source).not.toContain("secret response");
    expect(source).not.toContain("credential=secret");
    await expect(verifyAuditJournal(path, key)).resolves.toMatchObject({ records: 2 });
    await writeFile(path, source.replace('"durationMs":4', '"durationMs":5'));
    await expect(verifyAuditJournal(path, key)).rejects.toThrow("signature");
  });

  it("requires a strong audit key", () => {
    expect(() => new FileAuditJournal({ directory: "/tmp/focus-audit", hmacKey: "short" })).toThrow(
      "32 bytes",
    );
    expect(() => new FileAuditJournal({ directory: "/tmp/focus-audit" })).toThrow(
      "hmacKey or a keyProvider",
    );
    expect(() => new EnvAuditKeyProvider("short")).toThrow("32 bytes");
  });

  it("stamps provider-backed records with the keyId", async () => {
    const directory = await createTestDirectory("agent-audit-keyid");
    const key = "k".repeat(48);
    const journal = new FileAuditJournal({
      directory,
      keyProvider: new EnvAuditKeyProvider(key),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    await journal.record("session_keyid", { type: "text_delta", delta: "hello" });
    const path = join(directory, "session_keyid.audit.jsonl");
    const record = JSON.parse((await readFile(path, "utf8")).trim()) as { keyId?: string };
    expect(record.keyId).toBe("env");
    await expect(verifyAuditJournal(path, key)).resolves.toMatchObject({ records: 1 });
    await expect(verifyAuditJournal(path, new EnvAuditKeyProvider(key))).resolves.toMatchObject({
      records: 1,
    });
  });

  it("verifies a journal that spans a key rotation", async () => {
    const directory = await createTestDirectory("agent-audit-rotation");
    const keys = { primary: "p".repeat(48), successor: "s".repeat(48) };
    const provider = new RotatingKeyProvider(keys, "primary");
    const journal = new FileAuditJournal({
      directory,
      keyProvider: provider,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    await journal.record("session_rotation", { type: "text_delta", delta: "before rotation" });
    provider.rotate("successor");
    await journal.record("session_rotation", { type: "text_delta", delta: "after rotation" });
    const path = join(directory, "session_rotation.audit.jsonl");
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { keyId?: string });
    expect(records.map((record) => record.keyId)).toEqual(["primary", "successor"]);
    await expect(verifyAuditJournal(path, provider)).resolves.toMatchObject({ records: 2 });
    await expect(verifyAuditJournal(path, keys)).resolves.toMatchObject({ records: 2 });
    // A single retired key cannot vouch for records written after the rotation.
    await expect(verifyAuditJournal(path, keys.primary)).rejects.toThrow("unknown key identifier");
  });

  it("rejects records that reference an unknown keyId", async () => {
    const directory = await createTestDirectory("agent-audit-unknown-key");
    const key = "k".repeat(48);
    const journal = new FileAuditJournal({
      directory,
      hmacKey: key,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    await journal.record("session_unknown", { type: "text_delta", delta: "first" });
    const path = join(directory, "session_unknown.audit.jsonl");
    const [first] = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const forged: Record<string, unknown> = {
      ...first,
      sequence: 2,
      keyId: "decommissioned-key",
      previousHash: first!.hash,
    };
    delete forged.hash;
    const line = JSON.stringify({ ...forged, hash: signRecord(forged, key) });
    await writeFile(path, `${JSON.stringify(first)}\n${line}\n`);
    await expect(verifyAuditJournal(path, key)).rejects.toThrow("unknown key identifier");
    await expect(verifyAuditJournal(path, { env: key })).rejects.toThrow("unknown key identifier");
  });

  it("detects a gap when a record is deleted from the middle", async () => {
    const directory = await createTestDirectory("agent-audit-gap");
    const key = "k".repeat(48);
    const journal = new FileAuditJournal({
      directory,
      hmacKey: key,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    for (const delta of ["one", "two", "three"]) {
      await journal.record("session_gap", { type: "text_delta", delta });
    }
    const path = join(directory, "session_gap.audit.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    await writeFile(path, [lines[0], lines[2]].join("\n") + "\n");
    await expect(verifyAuditJournal(path, key)).rejects.toThrow("sequence is not contiguous");
  });

  it("detects a re-signed sequence jump", async () => {
    const directory = await createTestDirectory("agent-audit-jump");
    const key = "k".repeat(48);
    const journal = new FileAuditJournal({
      directory,
      hmacKey: key,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    await journal.record("session_jump", { type: "text_delta", delta: "one" });
    await journal.record("session_jump", { type: "text_delta", delta: "two" });
    const path = join(directory, "session_jump.audit.jsonl");
    const [first, second] = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // A forger with the key still cannot renumber records: the chain stays valid
    // but the sequence no longer matches the line position.
    const jumped: Record<string, unknown> = { ...second, sequence: 3 };
    delete jumped.hash;
    const line = JSON.stringify({ ...jumped, hash: signRecord(jumped, key) });
    await writeFile(path, `${JSON.stringify(first)}\n${line}\n`);
    await expect(verifyAuditJournal(path, key)).rejects.toThrow("sequence is not contiguous");
  });

  it("verifies legacy records without keyId against providers and key sets", async () => {
    const directory = await createTestDirectory("agent-audit-legacy");
    const key = "k".repeat(48);
    const journal = new FileAuditJournal({
      directory,
      hmacKey: key,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    await journal.record("session_legacy", { type: "text_delta", delta: "legacy" });
    const path = join(directory, "session_legacy.audit.jsonl");
    const record = JSON.parse((await readFile(path, "utf8")).trim()) as { keyId?: string };
    expect(record.keyId).toBeUndefined();
    await expect(verifyAuditJournal(path, key)).resolves.toMatchObject({ records: 1 });
    await expect(verifyAuditJournal(path, new EnvAuditKeyProvider(key))).resolves.toMatchObject({
      records: 1,
    });
    await expect(verifyAuditJournal(path, { env: key })).resolves.toMatchObject({ records: 1 });
  });
});

class RotatingKeyProvider implements AuditKeyProvider {
  constructor(
    private readonly keys: Record<string, string>,
    private active: string,
  ) {}

  rotate(keyId: string): void {
    this.active = keyId;
  }

  currentKey(): { keyId: string; secret: Uint8Array } {
    return { keyId: this.active, secret: Buffer.from(this.keys[this.active]!, "utf8") };
  }

  keyById(keyId: string): Uint8Array | undefined {
    const secret = this.keys[keyId];
    return secret === undefined ? undefined : Buffer.from(secret, "utf8");
  }
}

// Mirrors the canonical JSON the journal signs, so forged records isolate the
// check under test (sequence/keyId) instead of tripping the signature check.
function signRecord(value: unknown, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}
