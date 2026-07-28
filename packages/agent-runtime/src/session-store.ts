import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { newId } from "@focuscode/contracts";
import { validateImageAttachments } from "./media.js";
import type { AgentMessage, ModelProfile, TokenUsage } from "./types.js";

export interface SessionHeader {
  schemaVersion: "focuscode-session.v1";
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  model: Pick<ModelProfile, "provider" | "model" | "protocol">;
  forkedFrom?: { sessionId: string; entryId?: string };
}

export interface SessionEntry {
  entryId: string;
  parentId?: string;
  createdAt: string;
  message: AgentMessage;
  usage?: TokenUsage;
}

export interface SessionCompactionStructured {
  schemaVersion: "focuscode-compaction.v1";
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  keyDecisions: string[];
  pendingApprovals: string[];
  openQuestions: string[];
  /** Active spec ID from SpecEngine, preserved across compactions. */
  specId?: string;
  /** Active spec topic from SpecEngine, preserved across compactions. */
  specTopic?: string;
}

export interface SessionCompaction {
  summary: string;
  upToEntryId: string;
  createdAt: string;
  structured?: SessionCompactionStructured;
}

export interface SessionSnapshot {
  header: SessionHeader;
  entries: SessionEntry[];
  activeLeafId?: string;
  compaction?: SessionCompaction;
}

export interface SessionListItem {
  sessionId: string;
  name?: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  entries: number;
  preview: string;
}

type SessionFileEvent =
  | { type: "session"; header: SessionHeader }
  | { type: "entry"; entry: SessionEntry }
  | { type: "leaf"; entryId: string; at: string }
  | { type: "metadata"; name?: string; model?: SessionHeader["model"]; at: string }
  | { type: "compaction"; value: SessionCompaction };

interface CreateSessionOptions {
  cwd: string;
  model: ModelProfile;
  name?: string;
  forkedFrom?: SessionHeader["forkedFrom"];
}

interface SessionLockRecord {
  pid: number;
  acquiredAt: string;
  hostname: string;
}

/** Cross-process lock files older than this are preempted as crash leftovers. */
const SESSION_LOCK_TTL_MS = 30_000;
const SESSION_LOCK_MAX_ATTEMPTS = 3;

export class SessionStore {
  private readonly root: string;
  private readonly memory = new Map<string, SessionFileEvent[]>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly heldLocks = new Set<string>();

  constructor(
    directory: string,
    private readonly persistent = true,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(directory);
  }

  async create(options: CreateSessionOptions): Promise<SessionSnapshot> {
    const at = this.now().toISOString();
    const header: SessionHeader = {
      schemaVersion: "focuscode-session.v1",
      sessionId: newId("session"),
      cwd: resolve(options.cwd),
      createdAt: at,
      updatedAt: at,
      model: {
        provider: options.model.provider,
        model: options.model.model,
        protocol: options.model.protocol,
      },
      ...(options.name ? { name: options.name } : {}),
      ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
    };
    await this.write(header.sessionId, { type: "session", header });
    return { header, entries: [] };
  }

  async load(idOrPrefix: string): Promise<SessionSnapshot> {
    const sessionId = await this.resolveId(idOrPrefix);
    const events = await this.readEvents(sessionId);
    return materialize(events, sessionId);
  }

  async appendMessage(
    sessionId: string,
    message: AgentMessage,
    usage?: TokenUsage,
    options?: { expectedLeafId?: string },
  ): Promise<SessionEntry> {
    const validatedMessage = validateMessage(message);
    return this.withSessionLock(sessionId, async () => {
      const snapshot = await this.load(sessionId);
      if (
        options?.expectedLeafId !== undefined &&
        snapshot.activeLeafId !== options.expectedLeafId
      ) {
        throw new Error(
          `Session ${sessionId} active leaf changed concurrently ` +
            `(expected ${options.expectedLeafId}, found ${snapshot.activeLeafId ?? "none"})`,
        );
      }
      const entry: SessionEntry = {
        entryId: newId("entry"),
        ...(snapshot.activeLeafId ? { parentId: snapshot.activeLeafId } : {}),
        createdAt: this.now().toISOString(),
        message: validatedMessage,
        ...(usage ? { usage } : {}),
      };
      await this.write(sessionId, { type: "entry", entry });
      await this.write(sessionId, {
        type: "leaf",
        entryId: entry.entryId,
        at: this.now().toISOString(),
      });
      return entry;
    });
  }

  async moveLeaf(sessionId: string, entryId: string): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const snapshot = await this.load(sessionId);
      if (!snapshot.entries.some((entry) => entry.entryId === entryId)) {
        throw new Error(`Session entry not found: ${entryId}`);
      }
      await this.write(sessionId, { type: "leaf", entryId, at: this.now().toISOString() });
    });
  }

  async setName(sessionId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Session name must not be empty");
    await this.withSessionLock(sessionId, async () => {
      await this.load(sessionId);
      await this.write(sessionId, {
        type: "metadata",
        name: trimmed,
        at: this.now().toISOString(),
      });
    });
  }

  async setModel(sessionId: string, model: ModelProfile): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      await this.load(sessionId);
      await this.write(sessionId, {
        type: "metadata",
        model: { provider: model.provider, model: model.model, protocol: model.protocol },
        at: this.now().toISOString(),
      });
    });
  }

  async saveCompaction(
    sessionId: string,
    summary: string,
    upToEntryId: string,
    options?: { structured?: SessionCompactionStructured },
  ): Promise<SessionCompaction> {
    return this.withSessionLock(sessionId, async () => {
      const snapshot = await this.load(sessionId);
      if (!snapshot.entries.some((entry) => entry.entryId === upToEntryId)) {
        throw new Error(`Cannot compact through unknown entry: ${upToEntryId}`);
      }
      const value: SessionCompaction = {
        summary: summary.trim(),
        upToEntryId,
        createdAt: this.now().toISOString(),
        ...(options?.structured ? { structured: options.structured } : {}),
      };
      await this.write(sessionId, { type: "compaction", value });
      return value;
    });
  }

  async fork(
    sourceId: string,
    atEntryId: string | undefined,
    model: ModelProfile,
    name?: string,
  ): Promise<SessionSnapshot> {
    return this.withSessionLock(sourceId, async () => {
      const source = await this.load(sourceId);
      const branch = activeBranch(source, atEntryId);
      const target = await this.create({
        cwd: source.header.cwd,
        model,
        ...(name ? { name } : {}),
        forkedFrom: {
          sessionId: source.header.sessionId,
          ...(atEntryId ? { entryId: atEntryId } : {}),
        },
      });
      for (const entry of branch) {
        await this.appendMessage(target.header.sessionId, entry.message, entry.usage);
      }
      return this.load(target.header.sessionId);
    });
  }

  async importSnapshot(
    snapshot: Pick<SessionSnapshot, "header" | "entries" | "activeLeafId" | "compaction">,
    options: { cwd: string; model: ModelProfile; name?: string },
  ): Promise<SessionSnapshot> {
    const target = await this.create({
      cwd: options.cwd,
      model: options.model,
      name: options.name ?? snapshot.header.name ?? "Imported session",
      forkedFrom: { sessionId: snapshot.header.sessionId || "shared" },
    });
    const source = activeBranch(snapshot as SessionSnapshot);
    for (const entry of source) {
      await this.appendMessage(target.header.sessionId, entry.message, entry.usage);
    }
    if (
      snapshot.compaction &&
      source.some((entry) => entry.entryId === snapshot.compaction?.upToEntryId)
    ) {
      const imported = await this.load(target.header.sessionId);
      const sourceIndex = source.findIndex(
        (entry) => entry.entryId === snapshot.compaction?.upToEntryId,
      );
      const targetBranch = activeBranch(imported);
      const targetEntry = targetBranch[sourceIndex];
      if (targetEntry) {
        await this.saveCompaction(
          target.header.sessionId,
          snapshot.compaction.summary,
          targetEntry.entryId,
          snapshot.compaction.structured
            ? { structured: snapshot.compaction.structured }
            : undefined,
        );
      }
    }
    return this.load(target.header.sessionId);
  }

  async list(cwd?: string): Promise<SessionListItem[]> {
    const ids = await this.ids();
    const normalizedCwd = cwd ? resolve(cwd) : undefined;
    const items: SessionListItem[] = [];
    for (const id of ids) {
      try {
        const snapshot = await this.load(id);
        if (normalizedCwd && snapshot.header.cwd !== normalizedCwd) continue;
        const branch = activeBranch(snapshot);
        const firstUser = branch.find((entry) => entry.message.role === "user");
        items.push({
          sessionId: snapshot.header.sessionId,
          ...(snapshot.header.name ? { name: snapshot.header.name } : {}),
          cwd: snapshot.header.cwd,
          model: `${snapshot.header.model.provider}/${snapshot.header.model.model}`,
          createdAt: snapshot.header.createdAt,
          updatedAt: snapshot.header.updatedAt,
          entries: snapshot.entries.length,
          preview: firstUser?.message.content.replace(/\s+/g, " ").slice(0, 100) ?? "",
        });
      } catch {
        // A partially written or externally modified session is isolated from other sessions.
      }
    }
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async latest(cwd: string): Promise<SessionListItem | undefined> {
    return (await this.list(cwd))[0];
  }

  private async resolveId(idOrPrefix: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(idOrPrefix)) throw new Error("Invalid session id");
    const ids = await this.ids();
    if (ids.includes(idOrPrefix)) return idOrPrefix;
    const matches = ids.filter((id) => id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new Error(`Session not found: ${idOrPrefix}`);
    if (matches.length > 1) throw new Error(`Session id is ambiguous: ${idOrPrefix}`);
    return matches[0]!;
  }

  private async ids(): Promise<string[]> {
    if (!this.persistent) return [...this.memory.keys()];
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(0, -6));
  }

  private async readEvents(sessionId: string): Promise<SessionFileEvent[]> {
    if (!this.persistent) {
      const events = this.memory.get(sessionId);
      if (!events) throw new Error(`Session not found: ${sessionId}`);
      return structuredClone(events);
    }
    const path = this.pathFor(sessionId);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const events: SessionFileEvent[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line) as SessionFileEvent);
      } catch {
        if (index === lines.length - 1) {
          // Torn tail: a crash mid-append can leave a partial final line that was
          // never fully committed. It is dropped; corruption of any earlier line
          // stays fail-closed.
          console.warn(`Dropping torn final session line at ${path}:${index + 1}`);
          continue;
        }
        throw new Error(`Invalid session JSON at ${path}:${index + 1}`);
      }
    }
    return events;
  }

  private async write(sessionId: string, event: SessionFileEvent): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session id");
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (!this.persistent) {
        const events = this.memory.get(sessionId) ?? [];
        events.push(structuredClone(event));
        this.memory.set(sessionId, events);
        return;
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      // Append + fsync before returning, so a committed entry survives a crash.
      const handle = await open(this.pathFor(sessionId), "a", 0o600);
      try {
        await handle.write(`${JSON.stringify(event)}\n`, null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.queues.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.root, `${sessionId}.jsonl`);
  }

  private lockPathFor(sessionId: string): string {
    return join(this.root, `${sessionId}.lock`);
  }

  /**
   * Second mutual-exclusion layer after the in-process `queues` promise chain:
   * an exclusive lock file next to the session JSONL so concurrent CLI
   * processes cannot interleave read-modify-write on the same session.
   * The in-memory backend has no on-disk state to race over and skips it.
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.persistent) return fn();
    await this.acquireSessionLock(sessionId);
    try {
      return await fn();
    } finally {
      await this.releaseSessionLock(sessionId);
    }
  }

  private async acquireSessionLock(sessionId: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = this.lockPathFor(sessionId);
    for (let attempt = 0; attempt < SESSION_LOCK_MAX_ATTEMPTS; attempt += 1) {
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const record = await this.readLockRecord(lockPath);
        if (!record) continue; // The holder released between open and read; retry.
        if (this.isLockLive(record)) {
          throw new Error(
            record.pid > 0
              ? `Session ${sessionId} is locked by pid ${record.pid}`
              : `Session ${sessionId} is locked (unreadable lock file)`,
          );
        }
        // Crash leftover: the recorded pid is gone or the lock outlived its TTL.
        await rm(lockPath, { force: true });
        continue;
      }
      try {
        const record: SessionLockRecord = {
          pid: process.pid,
          acquiredAt: this.now().toISOString(),
          hostname: hostname(),
        };
        await handle.write(JSON.stringify(record), null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.heldLocks.add(sessionId);
      return;
    }
    throw new Error(`Session ${sessionId} lock could not be acquired (contention)`);
  }

  private async releaseSessionLock(sessionId: string): Promise<void> {
    if (!this.heldLocks.has(sessionId)) return;
    try {
      await rm(this.lockPathFor(sessionId), { force: true });
    } finally {
      this.heldLocks.delete(sessionId);
    }
  }

  private async readLockRecord(lockPath: string): Promise<SessionLockRecord | undefined> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as SessionLockRecord).pid === "number" &&
        typeof (parsed as SessionLockRecord).acquiredAt === "string"
      ) {
        const record = parsed as SessionLockRecord;
        return {
          pid: record.pid,
          acquiredAt: record.acquiredAt,
          hostname: typeof record.hostname === "string" ? record.hostname : "",
        };
      }
      // Unreadable content: fall back to the file mtime for the TTL check only.
      const info = await stat(lockPath);
      return { pid: -1, acquiredAt: info.mtime.toISOString(), hostname: "" };
    } catch {
      return undefined;
    }
  }

  private isLockLive(record: SessionLockRecord): boolean {
    const ageMs = this.now().getTime() - Date.parse(record.acquiredAt);
    if (Number.isNaN(ageMs) || ageMs > SESSION_LOCK_TTL_MS) return false;
    if (record.pid <= 0) return true; // Fresh but unreadable lock: assume alive.
    try {
      process.kill(record.pid, 0);
      return true;
    } catch (error) {
      // ESRCH: the pid is gone and the lock is a crash leftover. EPERM: alive.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}

export function activeBranch(
  snapshot: SessionSnapshot,
  leafId = snapshot.activeLeafId,
): SessionEntry[] {
  if (!leafId) return [];
  const byId = new Map(snapshot.entries.map((entry) => [entry.entryId, entry]));
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = leafId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error("Session contains an entry cycle");
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) throw new Error(`Session leaf references missing entry: ${cursor}`);
    branch.push(entry);
    cursor = entry.parentId;
  }
  return branch.reverse();
}

export function renderSessionHtml(snapshot: SessionSnapshot): string {
  const messages = activeBranch(snapshot)
    .map((entry) => {
      const role = escapeHtml(entry.message.role);
      const tool = entry.message.toolName
        ? `<span class="tool">${escapeHtml(entry.message.toolName)}</span>`
        : "";
      const attachments = (entry.message.attachments ?? [])
        .map((attachment) => {
          const source =
            attachment.source.type === "url"
              ? escapeHtml(attachment.source.url)
              : "data:" + attachment.mediaType + ";base64," + attachment.source.data;
          return (
            '<figure><img referrerpolicy="no-referrer" loading="lazy" src="' +
            source +
            '" alt="' +
            escapeHtml(attachment.name) +
            '"><figcaption>' +
            escapeHtml(attachment.name) +
            "</figcaption></figure>"
          );
        })
        .join("");
      return `<article class="${role}"><header>${role} ${tool}<time>${escapeHtml(entry.createdAt)}</time></header><pre>${escapeHtml(entry.message.content)}</pre>${attachments}</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(snapshot.header.name ?? snapshot.header.sessionId)}</title>
<style>body{max-width:960px;margin:2rem auto;padding:0 1rem;background:#101418;color:#e5e7eb;font:15px/1.5 system-ui}h1{font-size:1.35rem}article{margin:1rem 0;padding:1rem;border:1px solid #30363d;border-radius:8px}article.user{border-color:#2563eb}article.tool{border-color:#a16207;background:#17140c}header{font-weight:700;text-transform:uppercase;font-size:.75rem;color:#93c5fd}time{float:right;text-transform:none;color:#9ca3af;font-weight:400}.tool{color:#fbbf24;margin-left:.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}figure{margin:1rem 0}img{max-width:100%;max-height:640px;border-radius:6px}figcaption{color:#9ca3af;font-size:.8rem}</style>
</head><body><h1>${escapeHtml(snapshot.header.name ?? "FocusCode session")}</h1><p>${escapeHtml(snapshot.header.sessionId)} · ${escapeHtml(snapshot.header.model.provider)}/${escapeHtml(snapshot.header.model.model)} · ${escapeHtml(snapshot.header.cwd)}</p>${messages}</body></html>\n`;
}

function materialize(events: SessionFileEvent[], sessionId: string): SessionSnapshot {
  const first = events[0];
  if (!first || first.type !== "session") throw new Error(`Session ${sessionId} has no header`);
  const header = structuredClone(first.header);
  const entries: SessionEntry[] = [];
  let activeLeafId: string | undefined;
  let compaction: SessionCompaction | undefined;
  for (const event of events.slice(1)) {
    if (event.type === "entry") {
      entries.push({ ...event.entry, message: validateMessage(event.entry.message) });
    }
    if (event.type === "leaf") {
      activeLeafId = event.entryId;
      header.updatedAt = event.at;
    }
    if (event.type === "metadata") {
      if (event.name !== undefined) header.name = event.name;
      if (event.model) header.model = event.model;
      header.updatedAt = event.at;
    }
    if (event.type === "compaction") {
      compaction = event.value;
      header.updatedAt = event.value.createdAt;
    }
  }
  return {
    header,
    entries,
    ...(activeLeafId ? { activeLeafId } : {}),
    ...(compaction ? { compaction } : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateMessage(value: AgentMessage): AgentMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session message must be an object");
  }
  if (!["user", "assistant", "tool"].includes(value.role)) {
    throw new Error("Invalid session message role");
  }
  if (typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > 10_000_000) {
    throw new Error("Invalid or oversized session message content");
  }
  if (value.toolCallId !== undefined && typeof value.toolCallId !== "string") {
    throw new Error("Invalid session tool call id");
  }
  if (value.toolName !== undefined && typeof value.toolName !== "string") {
    throw new Error("Invalid session tool name");
  }
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls) || value.toolCalls.length > 16) {
      throw new Error("Invalid session tool calls");
    }
    for (const call of value.toolCalls) {
      if (
        !call ||
        typeof call !== "object" ||
        typeof call.id !== "string" ||
        typeof call.name !== "string" ||
        !call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments)
      ) {
        throw new Error("Invalid session tool call");
      }
    }
  }
  return {
    role: value.role,
    content: value.content,
    ...(value.attachments?.length
      ? { attachments: validateImageAttachments(value.attachments) }
      : {}),
    ...(value.toolCalls?.length ? { toolCalls: structuredClone(value.toolCalls) } : {}),
    ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}),
    ...(value.toolName ? { toolName: value.toolName } : {}),
    ...(value.providerState ? { providerState: validateProviderState(value.providerState) } : {}),
  };
}

function validateProviderState(value: unknown): NonNullable<AgentMessage["providerState"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session provider state");
  }
  const state = value as NonNullable<AgentMessage["providerState"]>;
  if (
    state.reasoningContent !== undefined &&
    (typeof state.reasoningContent !== "string" ||
      Buffer.byteLength(state.reasoningContent, "utf8") > 10_000_000)
  ) {
    throw new Error("Invalid or oversized provider reasoning state");
  }
  if (state.thinkingBlocks !== undefined) {
    if (!Array.isArray(state.thinkingBlocks) || state.thinkingBlocks.length > 64) {
      throw new Error("Invalid provider thinking blocks");
    }
    let bytes = 0;
    for (const block of state.thinkingBlocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        throw new Error("Invalid provider thinking block");
      }
      if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        (block.signature === undefined || typeof block.signature === "string")
      ) {
        bytes += Buffer.byteLength(block.thinking, "utf8");
        bytes += Buffer.byteLength(block.signature ?? "", "utf8");
        continue;
      }
      if (block.type === "redacted_thinking" && typeof block.data === "string") {
        bytes += Buffer.byteLength(block.data, "utf8");
        continue;
      }
      throw new Error("Invalid provider thinking block");
    }
    if (bytes > 10_000_000) throw new Error("Oversized provider thinking blocks");
  }
  return {
    ...(state.reasoningContent !== undefined ? { reasoningContent: state.reasoningContent } : {}),
    ...(state.thinkingBlocks !== undefined
      ? { thinkingBlocks: structuredClone(state.thinkingBlocks) }
      : {}),
  };
}
