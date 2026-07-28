import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SkillTrigger {
  keywords?: string[];
  toolNames?: string[];
}

export interface Skill {
  name: string;
  description: string;
  trigger: SkillTrigger;
  prompt: string;
  allowedTools: string[];
}

export interface SkillManifest {
  schemaVersion: "focuscode-skills.v1";
  skills: Skill[];
}

export function loadSkills(manifest: SkillManifest): Skill[] {
  if (manifest.schemaVersion !== "focuscode-skills.v1") {
    throw new Error(
      `Unsupported skills schema: ${manifest.schemaVersion}; expected focuscode-skills.v1`,
    );
  }
  return manifest.skills.map((skill) => ({
    ...skill,
    trigger: { ...skill.trigger, keywords: [...(skill.trigger.keywords ?? [])] },
    allowedTools: [...skill.allowedTools],
  }));
}

export function selectSkills(skills: Skill[], userInput: string): Skill[] {
  const lower = userInput.toLowerCase();
  return skills.filter((skill) => {
    const keywords = skill.trigger.keywords ?? [];
    return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
  });
}

/**
 * Select skills whose `trigger.toolNames` includes any of the called tool
 * names. Returns a de-duplicated list preserving input order. Returns `[]`
 * when `toolNames` is empty or no skill matches.
 */
export function selectSkillsForTools(skills: Skill[], toolNames: string[]): Skill[] {
  if (toolNames.length === 0) return [];
  const called = new Set(toolNames);
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    const skillTools = skill.trigger.toolNames ?? [];
    if (skillTools.some((name) => called.has(name))) {
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

export function buildSkillPrompt(selected: Skill[]): string {
  if (selected.length === 0) return "";
  const parts = selected.map((skill) => {
    const tools =
      skill.allowedTools.length > 0 ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "";
    return `## Skill: ${skill.name}\n${skill.prompt}\n${tools}`;
  });
  return parts.join("\n\n");
}

/**
 * Recursively load `SKILL.md` files from `dir`. Each file is parsed as
 * YAML frontmatter (between `---` delimiters) for structured fields, with
 * the remaining body used as `prompt`. Missing `dir` returns `[]` (no
 * throw) so callers can pass a best-effort path. Malformed frontmatter or
 * missing required fields (`name`, `description`) throw. `node_modules`
 * and `.git` directories are skipped.
 */
export async function loadSkillsFromDirectory(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    console.warn(
      `skills load failed for ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      skills.push(...(await loadSkillsFromDirectory(full)));
    } else if (entry === "SKILL.md") {
      skills.push(await parseSkillFile(full));
    }
  }
  return skills;
}

async function parseSkillFile(file: string): Promise<Skill> {
  const raw = await readFile(file, "utf8");
  const { frontmatter, body } = splitFrontmatter(file, raw);
  const parsed = parseFrontmatter(frontmatter);
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error(`Skill file ${file} is missing required field 'name'`);
  }
  if (typeof parsed.description !== "string" || parsed.description.length === 0) {
    throw new Error(`Skill file ${file} is missing required field 'description'`);
  }
  const triggerRaw = parsed.trigger ?? {};
  const trigger: SkillTrigger = {};
  if (Array.isArray(triggerRaw.keywords)) {
    trigger.keywords = triggerRaw.keywords.map(String);
  } else {
    trigger.keywords = [];
  }
  if (Array.isArray(triggerRaw.toolNames)) {
    trigger.toolNames = triggerRaw.toolNames.map(String);
  }
  const allowedTools = Array.isArray(parsed.allowedTools) ? parsed.allowedTools.map(String) : [];
  return {
    name: parsed.name,
    description: parsed.description,
    trigger,
    prompt: body,
    allowedTools,
  };
}

interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(file: string, raw: string): FrontmatterSplit {
  if (!raw.startsWith("---")) {
    throw new Error(`Skill file ${file} must start with YAML frontmatter delimited by '---'`);
  }
  // Skip the opening delimiter line.
  const afterOpen = raw.slice(3);
  const newlineIdx = afterOpen.indexOf("\n");
  // The opening line must be exactly `---` (optionally followed by a newline).
  if (newlineIdx !== 0 && afterOpen.trim().length !== 0) {
    throw new Error(`Skill file ${file} has malformed frontmatter opening delimiter`);
  }
  const rest = newlineIdx === -1 ? "" : afterOpen.slice(newlineIdx + 1);
  const closeIdx = rest.indexOf("\n---");
  if (closeIdx === -1) {
    // The closing delimiter must be on its own line. Also handle the case
    // where the file ends with `---` without a trailing newline.
    if (rest.trimEnd().endsWith("---")) {
      const frontmatter = rest.slice(0, rest.trimEnd().length - 3).trimEnd();
      return { frontmatter, body: "" };
    }
    throw new Error(`Skill file ${file} is missing closing frontmatter delimiter '---'`);
  }
  const frontmatter = rest.slice(0, closeIdx);
  const afterClose = rest.slice(closeIdx + 4); // skip `\n---`
  // Skip the rest of the closing delimiter line.
  const bodyNewline = afterClose.indexOf("\n");
  const body = bodyNewline === -1 ? "" : afterClose.slice(bodyNewline + 1);
  return { frontmatter, body };
}

interface ParsedFrontmatter {
  name?: unknown;
  description?: unknown;
  trigger?: Record<string, unknown>;
  allowedTools?: unknown;
  [key: string]: unknown;
}

/**
 * Parse a minimal YAML subset covering the fields a `SKILL.md` needs:
 * top-level scalars (`name`, `description`), nested maps (`trigger:`),
 * block sequences (`- item`) and flow empties (`[]`, `{}`). This avoids
 * pulling in a full YAML dependency, which would cross the agent-runtime
 * boundary (no external runtime deps allowed).
 */
function parseFrontmatter(src: string): ParsedFrontmatter {
  const lines = src.split("\n");
  const root: ParsedFrontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Malformed frontmatter line: ${line}`);
    }
    const key = match[1] as keyof ParsedFrontmatter;
    const value = match[2]!.trim();
    if (value.length === 0) {
      // Nested block: either a map or a sequence on the following lines.
      const { parsed, next } = parseBlock(lines, i + 1, 0);
      root[key] = parsed;
      i = next;
    } else if (value === "[]") {
      root[key] = [];
      i++;
    } else if (value === "{}") {
      root[key] = {};
      i++;
    } else {
      root[key] = parseScalar(value);
      i++;
    }
  }
  return root;
}

interface BlockResult {
  parsed: unknown;
  next: number;
}

function parseBlock(lines: string[], start: number, parentIndent: number): BlockResult {
  // Determine the child indent by inspecting the first non-empty line.
  let i = start;
  while (i < lines.length && lines[i]!.trim().length === 0) i++;
  if (i >= lines.length) return { parsed: {}, next: i };
  const firstLine = lines[i]!;
  const indent = leadingSpaces(firstLine);
  if (indent <= parentIndent) return { parsed: {}, next: i };
  if (firstLine.trimStart().startsWith("- ")) {
    return parseSequence(lines, i, indent);
  }
  return parseMap(lines, i, indent);
}

function parseSequence(lines: string[], start: number, indent: number): BlockResult {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const lineIndent = leadingSpaces(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new Error(`Unexpected indentation in sequence at line ${i + 1}`);
    }
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) {
      break;
    }
    items.push(parseScalar(trimmed.slice(2).trim()));
    i++;
  }
  return { parsed: items, next: i };
}

function parseMap(lines: string[], start: number, indent: number): BlockResult {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    const lineIndent = leadingSpaces(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new Error(`Unexpected indentation in map at line ${i + 1}`);
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line.trimStart());
    if (!match) {
      break;
    }
    const key = match[1]!;
    const value = match[2]!.trim();
    if (value.length === 0) {
      const { parsed, next } = parseBlock(lines, i + 1, indent);
      obj[key] = parsed;
      i = next;
    } else if (value === "[]") {
      obj[key] = [];
      i++;
    } else if (value === "{}") {
      obj[key] = {};
      i++;
    } else {
      obj[key] = parseScalar(value);
      i++;
    }
  }
  return { parsed: obj, next: i };
}

function parseScalar(raw: string): string {
  // Strip surrounding quotes if present.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}
