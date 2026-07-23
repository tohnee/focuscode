import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WorkspaceGuard } from "@focuscode/action-backends";

export interface AgentSkill {
  name: string;
  description: string;
  path: string;
  content: string;
  scope: "global" | "project";
}

export interface PromptTemplate {
  name: string;
  description: string;
  path: string;
  content: string;
  scope: "global" | "project";
}

export interface AgentResources {
  instructions: Array<{ path: string; content: string; scope: "global" | "project" }>;
  skills: AgentSkill[];
  prompts: PromptTemplate[];
  extensionPaths: string[];
}

export async function loadAgentResources(options: {
  cwd: string;
  projectTrusted: boolean;
  configuredInstructions?: string[];
  homeDirectory?: string;
}): Promise<AgentResources> {
  const cwd = resolve(options.cwd);
  const home = resolve(options.homeDirectory ?? join(homedir(), ".focuscode"));
  const instructions: AgentResources["instructions"] = [];
  await addInstruction(instructions, join(home, "AGENTS.md"), "global");
  for (const configured of options.configuredInstructions ?? []) {
    const path = resolve(configured.startsWith("/") ? configured : join(cwd, configured));
    if (path.startsWith(cwd) && !options.projectTrusted) continue;
    await addInstruction(instructions, path, path.startsWith(cwd) ? "project" : "global");
  }
  if (options.projectTrusted) {
    for (const path of await instructionChain(cwd)) {
      await addInstruction(instructions, path, "project");
    }
    await addInstruction(instructions, join(cwd, ".focuscode", "instructions.md"), "project");
  }
  const skills = [
    ...(await discoverSkills(join(home, "skills"), "global")),
    ...(options.projectTrusted
      ? await discoverSkills(join(cwd, ".focuscode", "skills"), "project")
      : []),
  ];
  const prompts = [
    ...(await discoverPrompts(join(home, "prompts"), "global")),
    ...(options.projectTrusted
      ? await discoverPrompts(join(cwd, ".focuscode", "prompts"), "project")
      : []),
  ];
  const extensionPaths = [
    ...(await discoverExtensions(join(home, "extensions"))),
    ...(options.projectTrusted
      ? await discoverExtensions(join(cwd, ".focuscode", "extensions"))
      : []),
  ];
  return {
    instructions: dedupeBy(instructions, (item) => item.path),
    skills: dedupeBy(skills, (item) => item.name),
    prompts: dedupeBy(prompts, (item) => item.name),
    extensionPaths: [...new Set(extensionPaths)],
  };
}

export function renderResourcePrompt(resources: AgentResources): string {
  const sections: string[] = [];
  if (resources.instructions.length > 0) {
    sections.push(
      [
        "Repository and owner instructions:",
        ...resources.instructions.map(
          (instruction) =>
            `\n--- ${instruction.path} [${instruction.scope}] ---\n${instruction.content}`,
        ),
      ].join("\n"),
    );
  }
  if (resources.skills.length > 0) {
    sections.push(
      [
        "Available skills (load one only when relevant; their full text is supplied by the user interface):",
        ...resources.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

export function expandPromptTemplate(template: PromptTemplate, argumentsText: string): string {
  const args = argumentsText.trim();
  return template.content.replaceAll("$ARGUMENTS", args).replaceAll("{{args}}", args);
}

export async function expandFileMentions(
  cwd: string,
  prompt: string,
  maxTotalChars = 100_000,
): Promise<string> {
  const workspace = await WorkspaceGuard.create(cwd);
  const tokens = [...prompt.matchAll(/(?:^|\s)@([^\s]+)/g)]
    .map((match) => match[1]!)
    .filter(Boolean);
  if (tokens.length === 0) return prompt;
  const attachments: string[] = [];
  let used = 0;
  for (const token of [...new Set(tokens)]) {
    try {
      const absolute = await workspace.resolvePath(token);
      const content = await readFile(absolute, "utf8");
      const remaining = maxTotalChars - used;
      if (remaining <= 0) break;
      const selected = content.slice(0, remaining);
      used += selected.length;
      attachments.push(`--- attached:${token} ---\n${selected}`);
    } catch (error) {
      attachments.push(
        `--- attachment-error:${token} ---\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return attachments.length > 0 ? `${prompt}\n\n${attachments.join("\n\n")}` : prompt;
}

async function instructionChain(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  let cursor = cwd;
  while (true) {
    paths.unshift(join(cursor, "AGENTS.md"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return paths;
}

async function addInstruction(
  output: AgentResources["instructions"],
  path: string,
  scope: "global" | "project",
): Promise<void> {
  if (!(await exists(path))) return;
  const content = (await readFile(path, "utf8")).slice(0, 100_000);
  if (content.trim()) output.push({ path, content, scope });
}

async function discoverSkills(
  directory: string,
  scope: "global" | "project",
): Promise<AgentSkill[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const skills: AgentSkill[] = [];
  for (const entry of entries) {
    const path = entry.isDirectory()
      ? join(directory, entry.name, "SKILL.md")
      : entry.isFile() && entry.name.toLowerCase().endsWith(".md")
        ? join(directory, entry.name)
        : undefined;
    if (!path || !(await exists(path))) continue;
    const content = (await readFile(path, "utf8")).slice(0, 200_000);
    const metadata = frontmatter(content);
    skills.push({
      name: metadata.name ?? (entry.isDirectory() ? entry.name : basename(entry.name, ".md")),
      description:
        metadata.description ?? firstMeaningfulLine(content) ?? "Reusable coding workflow",
      path,
      content,
      scope,
    });
  }
  return skills;
}

async function discoverPrompts(
  directory: string,
  scope: "global" | "project",
): Promise<PromptTemplate[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const prompts: PromptTemplate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const path = join(directory, entry.name);
    const content = (await readFile(path, "utf8")).slice(0, 200_000);
    const metadata = frontmatter(content);
    prompts.push({
      name: metadata.name ?? basename(entry.name, ".md"),
      description: metadata.description ?? firstMeaningfulLine(content) ?? "Prompt template",
      path,
      content: stripFrontmatter(content),
      scope,
    });
  }
  return prompts;
}

async function discoverExtensions(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) paths.push(join(directory, entry.name));
    if (entry.isDirectory()) {
      for (const name of ["index.mjs", "index.js"]) {
        const path = join(directory, entry.name, name);
        if (await exists(path)) {
          paths.push(path);
          break;
        }
      }
    }
  }
  return paths;
}

function frontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key && value) values[key] = value;
  }
  return values;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function firstMeaningfulLine(content: string): string | undefined {
  return stripFrontmatter(content)
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean)
    ?.slice(0, 240);
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const values = new Map<string, T>();
  for (const item of items) values.set(key(item), item);
  return [...values.values()];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
