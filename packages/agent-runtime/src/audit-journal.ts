import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentEvent } from "./types.js";

export interface AuditJournal {
  record(sessionId: string, event: AgentEvent): Promise<void>;
}

export interface AuditRecord {
  schemaVersion: "focuscode-audit.v1";
  sequence: number;
  timestamp: string;
  sessionId: string;
  /** Key identifier of the signing key; legacy records written before key rotation omit it. */
  keyId?: string;
  event: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

/**
 * Seam between the file journal and key management. The built-in
 * EnvAuditKeyProvider serves a single static key; a KMS-backed implementation
 * can rotate keys and still verify historical records by keyId.
 */
export interface AuditKeyProvider {
  currentKey(): { keyId: string; secret: Uint8Array };
  keyById(keyId: string): Uint8Array | undefined;
}

/** Static key collection for verifying journals that span a rotation. */
export type AuditKeySet = Record<string, string | Uint8Array>;

export type AuditKeySource = string | Uint8Array | AuditKeySet | AuditKeyProvider;

/** Key identifier used for records and verifications that predate explicit keyIds. */
export const DEFAULT_AUDIT_KEY_ID = "env";

/** Single static key (the pre-rotation deployment shape), addressable by keyId. */
export class EnvAuditKeyProvider implements AuditKeyProvider {
  private readonly secret: Uint8Array;

  constructor(
    hmacKey: string | Uint8Array,
    private readonly keyId: string = DEFAULT_AUDIT_KEY_ID,
  ) {
    this.secret = toKey(hmacKey);
    assertKeyStrength(this.secret);
  }

  currentKey(): { keyId: string; secret: Uint8Array } {
    return { keyId: this.keyId, secret: this.secret };
  }

  keyById(keyId: string): Uint8Array | undefined {
    return keyId === this.keyId ? this.secret : undefined;
  }
}

export interface FileAuditJournalOptions {
  directory: string;
  hmacKey?: string | Uint8Array;
  keyProvider?: AuditKeyProvider;
  now?: () => Date;
}

interface ChainState {
  sequence: number;
  hash: string;
}

const GENESIS_HASH = "0".repeat(64);

/**
 * Append-only, HMAC-chained audit log. Content and reasoning deltas are represented by
 * hashes and byte counts so an audit trail does not become a second secret store.
 */
export class FileAuditJournal implements AuditJournal {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly sign: () => { keyId?: string; secret: Uint8Array };
  private readonly verifyWith: AuditKeySource;
  private readonly states = new Map<string, Promise<ChainState>>();

  constructor(options: FileAuditJournalOptions) {
    this.directory = resolve(options.directory);
    this.now = options.now ?? (() => new Date());
    if (options.keyProvider) {
      const provider = options.keyProvider;
      assertKeyStrength(provider.currentKey().secret);
      this.sign = () => provider.currentKey();
      this.verifyWith = provider;
    } else {
      if (options.hmacKey === undefined) {
        throw new Error("Audit journal requires an hmacKey or a keyProvider");
      }
      const key = toKey(options.hmacKey);
      assertKeyStrength(key);
      this.sign = () => ({ secret: key });
      this.verifyWith = key;
    }
  }

  async record(sessionId: string, event: AgentEvent): Promise<void> {
    const path = this.pathFor(sessionId);
    const previous = this.states.get(path) ?? this.loadState(path, sessionId);
    const next = previous.then(async (state) => {
      const active = this.sign();
      const unsigned = {
        schemaVersion: "focuscode-audit.v1" as const,
        sequence: state.sequence + 1,
        timestamp: this.now().toISOString(),
        sessionId,
        ...(active.keyId !== undefined ? { keyId: active.keyId } : {}),
        event: sanitizeEvent(event),
        previousHash: state.hash,
      };
      const hash = signRecord(unsigned, active.secret);
      const record: AuditRecord = { ...unsigned, hash };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Append + fsync before returning, so a chained record survives a crash.
      const handle = await open(path, "a", 0o600);
      try {
        await handle.write(canonicalJson(record) + "\n", null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { sequence: record.sequence, hash };
    });
    this.states.set(path, next);
    await next;
  }

  private async loadState(path: string, sessionId: string): Promise<ChainState> {
    try {
      const result = await verifyAuditJournal(path, this.verifyWith, sessionId);
      return { sequence: result.records, hash: result.finalHash };
    } catch (error) {
      if (isMissingFile(error)) return { sequence: 0, hash: GENESIS_HASH };
      throw error;
    }
  }

  private pathFor(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)) {
      throw new Error("Invalid audit session identifier");
    }
    const path = resolve(this.directory, `${sessionId}.audit.jsonl`);
    const child = relative(this.directory, path);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error("Audit path escapes configured directory");
    }
    return path;
  }
}

/**
 * Verify continuity, chain linkage, and per-record signatures. Accepts a single
 * key (legacy journals without keyId), a key set, or a provider; each record is
 * verified with the key its keyId names, while records without a keyId fall back
 * to the default ("env") key. Unknown keyIds fail closed.
 */
export async function verifyAuditJournal(
  path: string,
  keys: AuditKeySource,
  expectedSessionId?: string,
): Promise<{ records: number; finalHash: string; sessionId?: string }> {
  const resolveKey = keyResolver(keys);
  const lines = (await readFile(resolve(path), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  let previousHash = GENESIS_HASH;
  let sessionId = expectedSessionId;
  for (const [index, line] of lines.entries()) {
    const record = parseRecord(line, basename(path), index + 1);
    sessionId ??= record.sessionId;
    if (record.sessionId !== sessionId) throw new Error("Audit journal mixes session IDs");
    if (record.sequence !== index + 1) throw new Error("Audit journal sequence is not contiguous");
    if (record.previousHash !== previousHash) throw new Error("Audit journal chain is broken");
    const key = resolveKey(record.keyId);
    if (!key) {
      throw new Error(`Audit journal references unknown key identifier: ${record.keyId}`);
    }
    assertKeyStrength(key);
    const { hash, ...unsigned } = record;
    const expected = signRecord(unsigned, key);
    if (!equalHex(hash, expected)) throw new Error("Audit journal signature is invalid");
    previousHash = hash;
  }
  return {
    records: lines.length,
    finalHash: previousHash,
    ...(sessionId ? { sessionId } : {}),
  };
}

function keyResolver(
  source: AuditKeySource,
): (keyId: string | undefined) => Uint8Array | undefined {
  if (typeof source === "string" || source instanceof Uint8Array) {
    const key = toKey(source);
    assertKeyStrength(key);
    return (keyId) => (keyId === undefined || keyId === DEFAULT_AUDIT_KEY_ID ? key : undefined);
  }
  if (isKeyProvider(source)) {
    return (keyId) => (keyId === undefined ? source.currentKey().secret : source.keyById(keyId));
  }
  for (const secret of Object.values(source)) assertKeyStrength(toKey(secret));
  return (keyId) => {
    const secret = source[keyId ?? DEFAULT_AUDIT_KEY_ID];
    return secret === undefined ? undefined : toKey(secret);
  };
}

function isKeyProvider(value: unknown): value is AuditKeyProvider {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as AuditKeyProvider).currentKey === "function" &&
    typeof (value as AuditKeyProvider).keyById === "function",
  );
}

function assertKeyStrength(key: Uint8Array): void {
  if (key.byteLength < 32) throw new Error("Audit HMAC key must be at least 32 bytes");
}

function sanitizeEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === "text_delta" || event.type === "reasoning_delta") {
    return { type: event.type, ...digestText(event.delta) };
  }
  if (event.type === "steering_queued") {
    const { text, ...rest } = event;
    return { ...rest, text: digestText(text) };
  }
  if (event.type === "compaction") {
    const { summary, ...rest } = event;
    return { ...rest, summary: digestText(summary) };
  }
  if (event.type === "tool_start") {
    return {
      type: event.type,
      call: {
        id: event.call.id,
        name: event.call.name,
        arguments: digestJson(event.call.arguments),
      },
    };
  }
  if (event.type === "tool_end") {
    const metadata = event.result.metadata ?? {};
    return {
      type: event.type,
      call: {
        id: event.call.id,
        name: event.call.name,
        arguments: digestJson(event.call.arguments),
      },
      result: {
        ...digestText(event.result.content),
        isError: event.result.isError === true,
        // Grant linkage lets the audit trail join session tool effects to the
        // effect spine without recording arguments or output content.
        ...(typeof metadata.grantId === "string" ? { grantId: metadata.grantId } : {}),
        ...(typeof metadata.receiptDigest === "string"
          ? { receiptDigest: metadata.receiptDigest }
          : {}),
      },
      durationMs: event.durationMs,
    };
  }
  if (event.type === "approval_required") {
    return {
      type: event.type,
      request: {
        tool: event.request.tool.name,
        effect: event.request.tool.effect,
        risk: event.request.risk,
        reason: digestText(event.request.reason),
        arguments: digestJson(event.request.arguments),
      },
    };
  }
  if (event.type === "agent_end") {
    const { content, ...response } = event.response;
    return { type: event.type, response: { ...response, content: digestText(content) } };
  }
  if (event.type === "error") {
    // P1-C: preserve severity so audit consumers can distinguish
    // recoverable from fatal errors after digest.
    const entry: Record<string, unknown> = { type: event.type, message: digestText(event.message) };
    if (event.severity) entry.severity = event.severity;
    return entry;
  }
  return structuredClone(event) as unknown as Record<string, unknown>;
}

function digestText(value: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: Buffer.byteLength(value),
  };
}

function digestJson(value: unknown): { sha256: string; bytes: number } {
  return digestText(canonicalJson(value));
}

function signRecord(value: unknown, key: Uint8Array): string {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
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

function parseRecord(line: string, file: string, lineNumber: number): AuditRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid JSON in ${file}:${lineNumber}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid audit record in ${file}:${lineNumber}`);
  }
  const record = value as Partial<AuditRecord>;
  if (
    record.schemaVersion !== "focuscode-audit.v1" ||
    typeof record.sequence !== "number" ||
    typeof record.timestamp !== "string" ||
    typeof record.sessionId !== "string" ||
    (record.keyId !== undefined && typeof record.keyId !== "string") ||
    !record.event ||
    typeof record.event !== "object" ||
    typeof record.previousHash !== "string" ||
    typeof record.hash !== "string"
  ) {
    throw new Error(`Malformed audit record in ${file}:${lineNumber}`);
  }
  return record as AuditRecord;
}

function toKey(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
