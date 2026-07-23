import { join } from "node:path";
import type {
  SpecDocument,
  SpecEngineDeps,
  SpecStatus,
  SpecStore as ISpecStore,
  SpecSummary,
  SpecTrigger,
} from "./spec-types.js";

/**
 * Slugify a topic for use in a filename: lowercase, replace runs of
 * non-alphanumeric characters with a single hyphen, trim leading/trailing
 * hyphens, and cap length. Falls back to "untitled" when the result is empty.
 */
function slugify(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "untitled"
  );
}

export class SpecStoreImpl implements ISpecStore {
  constructor(
    private readonly cwd: string,
    private readonly specDirectory: string,
    private readonly deps: SpecEngineDeps,
  ) {}

  async save(doc: SpecDocument): Promise<string> {
    const dir = join(this.cwd, this.specDirectory);
    const existing = await this.deps.listDir(dir).catch(() => []);
    const filename = await this.resolveFilename(doc, dir, existing);
    const path = join(dir, filename);
    const content = this.serialize(doc);
    await this.deps.writeFile(path, content);
    return path;
  }

  async load(specId: string): Promise<SpecDocument | undefined> {
    const dir = join(this.cwd, this.specDirectory);
    const files = await this.deps.listDir(dir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      const content = await this.deps.readFile(path).catch(() => undefined);
      if (content === undefined) continue;
      const parsed = this.parseFrontmatter(content);
      if (parsed?.id === specId) {
        return this.deserialize(parsed);
      }
    }
    return undefined;
  }

  async list(limit?: number): Promise<SpecSummary[]> {
    const dir = join(this.cwd, this.specDirectory);
    const files = await this.deps.listDir(dir).catch(() => []);
    const summaries: SpecSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await this.deps.readFile(join(dir, file)).catch(() => undefined);
      if (content === undefined) continue;
      const parsed = this.parseFrontmatter(content);
      if (parsed) {
        summaries.push({
          id: parsed.id,
          topic: parsed.topic,
          createdAt: parsed.createdAt,
          status: parsed.status,
          trigger: parsed.trigger,
        });
      }
    }
    summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return limit ? summaries.slice(0, limit) : summaries;
  }

  async updateStatus(specId: string, status: SpecStatus): Promise<void> {
    // Edit the frontmatter in place rather than load → mutate → save.
    // Going through deserialize/serialize would wipe the markdown body
    // (deserialize returns a minimal doc with empty body fields).
    const dir = join(this.cwd, this.specDirectory);
    const files = await this.deps.listDir(dir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      const content = await this.deps.readFile(path).catch(() => undefined);
      if (content === undefined) continue;
      const parsed = this.parseFrontmatter(content);
      if (parsed?.id === specId) {
        const newUpdatedAt = new Date().toISOString();
        const withStatus = this.replaceFrontmatterField(content, "status", status);
        const finalContent = this.replaceFrontmatterField(withStatus, "updatedAt", newUpdatedAt);
        await this.deps.writeFile(path, finalContent);
        return;
      }
    }
    throw new Error(`Spec not found: ${specId}`);
  }

  /**
   * Replace a single `field: value` line within the YAML frontmatter block,
   * leaving the markdown body untouched. Mirrors the frontmatter delimiter
   * convention used by `serialize` (`---\n` … `\n---\n`).
   */
  private replaceFrontmatterField(content: string, field: string, value: string): string {
    if (!content.startsWith("---\n")) return content;
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx === -1) return content;
    const fmStart = 4;
    const fmText = content.slice(fmStart, endIdx);
    const fmLines = fmText.split("\n");
    const prefix = `${field}:`;
    for (let i = 0; i < fmLines.length; i++) {
      if (fmLines[i]!.startsWith(prefix)) {
        fmLines[i] = `${field}: ${value}`;
        break;
      }
    }
    return content.slice(0, fmStart) + fmLines.join("\n") + content.slice(endIdx);
  }

  /**
   * Resolve a non-conflicting filename for `doc`. If a file with the candidate
   * name already exists and belongs to the same spec ID, the same name is
   * returned (overwrite). If it belongs to a different spec ID, a `-N` suffix
   * (starting at 2) is appended until a free name is found.
   */
  private async resolveFilename(
    doc: SpecDocument,
    dir: string,
    existing: string[],
  ): Promise<string> {
    const date = doc.createdAt.slice(0, 10);
    const topic = slugify(doc.topic);
    let n = 0;
    while (true) {
      const candidate = n === 0 ? `${date}-${topic}.md` : `${date}-${topic}-${n + 1}.md`;
      if (!existing.includes(candidate)) {
        return candidate;
      }
      // File exists — if it belongs to the same spec ID, overwrite it.
      const content = await this.deps.readFile(join(dir, candidate)).catch(() => undefined);
      const parsed = content ? this.parseFrontmatter(content) : null;
      if (parsed?.id === doc.id) {
        return candidate;
      }
      n++;
    }
  }

  private serialize(doc: SpecDocument): string {
    const fm: string[] = [
      "---",
      `id: ${doc.id}`,
      `createdAt: ${doc.createdAt}`,
      `updatedAt: ${doc.updatedAt}`,
      `topic: ${doc.topic}`,
      `trigger: ${doc.trigger}`,
      `status: ${doc.status}`,
      "---",
      "",
      `# Spec: ${doc.topic}`,
      "",
      "## Goal",
      doc.understanding.goal,
      "",
    ];
    if (doc.understanding.constraints.length > 0) {
      fm.push("## Constraints");
      for (const c of doc.understanding.constraints) {
        fm.push(`- [${c.severity}|${c.source}] ${c.description}`);
      }
      fm.push("");
    }
    if (doc.understanding.acceptanceCriteria.length > 0) {
      fm.push("## Acceptance Criteria");
      for (const ac of doc.understanding.acceptanceCriteria) {
        fm.push(`- [${ac.verification}] ${ac.description}`);
      }
      fm.push("");
    }
    if (doc.understanding.affectedAreas.length > 0) {
      fm.push("## Affected Areas");
      for (const area of doc.understanding.affectedAreas) {
        fm.push(`- [${area.impact}] ${area.path} — ${area.reason}`);
      }
      fm.push("");
    }
    if (doc.taskBreakdown.length > 0) {
      fm.push("## Task Breakdown");
      for (const task of doc.taskBreakdown) {
        const deps = task.dependsOn.length > 0 ? ` (dependsOn: ${task.dependsOn.join(", ")})` : "";
        fm.push(`${task.id}. [${task.kind}] ${task.description}${deps}`);
      }
      fm.push("");
    }
    if (doc.keyDecisions.length > 0) {
      fm.push("## Key Decisions");
      for (const d of doc.keyDecisions) {
        const chosen = d.chosen ? ` — Chosen: ${d.chosen}` : "";
        fm.push(`- [${d.severity}] ${d.point}${chosen}`);
      }
      fm.push("");
    }
    fm.push("## Enhanced Prompt");
    fm.push("```");
    fm.push(doc.enhancedPrompt);
    fm.push("```");
    return fm.join("\n");
  }

  private parseFrontmatter(content: string): {
    id: string;
    createdAt: string;
    updatedAt: string;
    topic: string;
    status: SpecStatus;
    trigger: SpecTrigger;
  } | null {
    if (!content.startsWith("---\n")) return null;
    const endIdx = content.indexOf("\n---\n", 4);
    if (endIdx === -1) return null;
    const fm = content.slice(4, endIdx);
    const lines = fm.split("\n");
    const map: Record<string, string> = {};
    for (const line of lines) {
      const match = /^(\w+):\s*(.*)$/.exec(line);
      if (match) {
        map[match[1]!] = match[2]!;
      }
    }
    if (!map.id || !map.createdAt || !map.topic || !map.status || !map.trigger) return null;
    return {
      id: map.id,
      createdAt: map.createdAt,
      // updatedAt is always written by `serialize`, but fall back to
      // createdAt for legacy files that may lack it.
      updatedAt: map.updatedAt ?? map.createdAt,
      topic: map.topic,
      status: map.status as SpecStatus,
      trigger: map.trigger as SpecTrigger,
    };
  }

  private deserialize(fm: {
    id: string;
    createdAt: string;
    updatedAt: string;
    topic: string;
    status: SpecStatus;
    trigger: SpecTrigger;
  }): SpecDocument {
    // Return a minimal doc with frontmatter data. Full body parsing is not
    // needed for load() — the frontmatter has the essential metadata. The
    // body is for human readability.
    return {
      id: fm.id,
      createdAt: fm.createdAt,
      updatedAt: fm.updatedAt,
      topic: fm.topic,
      trigger: fm.trigger,
      originalInput: "",
      understanding: {
        goal: "",
        constraints: [],
        acceptanceCriteria: [],
        affectedAreas: [],
        ambiguities: [],
      },
      taskBreakdown: [],
      keyDecisions: [],
      enhancedPrompt: "",
      initialTodos: [],
      status: fm.status,
      pipelineTrace: { stages: [], totalMs: 0, hadFallback: false },
    };
  }
}
