import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const ALWAYS_IGNORED = new Set([".git", "node_modules"]);
const MAX_SEARCHABLE_FILE_BYTES = 5_000_000;
const BINARY_SNIFF_BYTES = 8_192;

export interface GrepRecursiveOptions {
  pattern: string;
  ignoreCase?: boolean;
  glob?: string;
  maxResults: number;
  cwd?: string;
  signal?: AbortSignal;
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  content: string;
}

export interface ListFilesOptions {
  glob?: string;
  maxResults: number;
  cwd?: string;
  signal?: AbortSignal;
}

interface IgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

/**
 * Pure-Node replacement for the ripgrep content-search path. Walks the tree
 * under root, honoring a small .gitignore subset (comments, `*`, `**`, `?`,
 * `dir/` directory rules and `!` negation; only the root .gitignore is read)
 * and skipping binary or oversized files. Returned paths are relative to
 * options.cwd (default root) with POSIX separators, matching rg output.
 */
export async function grepRecursive(
  rootDirectory: string,
  options: GrepRecursiveOptions,
): Promise<GrepMatch[]> {
  const root = resolve(rootDirectory);
  const regex = new RegExp(options.pattern, options.ignoreCase ? "i" : "");
  const glob = globFilter(options.glob);
  const matches: GrepMatch[] = [];
  const state = { stopped: false };
  const signal = options.signal;
  await walk(root, resolve(options.cwd ?? root), state, async (file) => {
    if (signal?.aborted) {
      state.stopped = true;
      return;
    }
    if (matches.length >= options.maxResults) {
      state.stopped = true;
      return;
    }
    if (glob && !glob(displayPath(options.cwd ?? root, file))) return;
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SEARCHABLE_FILE_BYTES) return;
    const buffer = await readFile(file);
    if (isBinary(buffer)) return;
    const lines = buffer.toString("utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (signal?.aborted || matches.length >= options.maxResults) {
        state.stopped = true;
        break;
      }
      const found = regex.exec(line);
      if (found) {
        matches.push({
          path: displayPath(options.cwd ?? root, file),
          line: index + 1,
          column: found.index + 1,
          content: line,
        });
      }
    }
  });
  if (signal?.aborted) {
    const error = new Error(signal.reason instanceof Error ? signal.reason.message : "Aborted");
    error.name = "AbortError";
    throw error;
  }
  return matches;
}

/** Pure-Node replacement for `rg --files`: list non-ignored files under root. */
export async function listFiles(
  rootDirectory: string,
  options: ListFilesOptions,
): Promise<string[]> {
  const root = resolve(rootDirectory);
  const glob = globFilter(options.glob);
  const files: string[] = [];
  const state = { stopped: false };
  const signal = options.signal;
  await walk(root, resolve(options.cwd ?? root), state, async (file) => {
    if (signal?.aborted) {
      state.stopped = true;
      return;
    }
    if (files.length >= options.maxResults) {
      state.stopped = true;
      return;
    }
    const shown = displayPath(options.cwd ?? root, file);
    if (glob && !glob(shown)) return;
    if (!(await stat(file)).isFile()) return;
    files.push(shown);
  });
  if (signal?.aborted) {
    const error = new Error(signal.reason instanceof Error ? signal.reason.message : "Aborted");
    error.name = "AbortError";
    throw error;
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/** Convert a `*`/`?`/`*`**` glob to an anchored RegExp. `**` crosses separators. */
export function globToRegExp(glob: string): RegExp {
  let regex = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          regex += "(?:[^/]+/)*";
          index += 3;
          continue;
        }
        regex += ".*";
        index += 2;
        continue;
      }
      regex += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      index += 1;
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${regex}$`);
}

/**
 * Glob filter with gitignore-style semantics: a leading `!` negates, patterns
 * containing `/` match the whole relative path, others match the basename.
 */
function globFilter(glob: string | undefined): ((path: string) => boolean) | undefined {
  if (!glob) return undefined;
  const negated = glob.startsWith("!");
  const body = negated ? glob.slice(1) : glob;
  const anchored = body.includes("/");
  const regex = globToRegExp(body);
  return (path) => {
    const matched = regex.test(anchored ? path : basename(path));
    return negated ? !matched : matched;
  };
}

async function walk(
  root: string,
  ignoreRoot: string,
  state: { stopped: boolean },
  visit: (file: string) => Promise<void>,
): Promise<void> {
  if (state.stopped) return;
  const rootInfo = await stat(root).catch(() => undefined);
  if (!rootInfo) return;
  if (rootInfo.isFile()) {
    await visit(root);
    return;
  }
  const rules = await loadIgnoreRules(ignoreRoot);
  const recurse = async (current: string): Promise<void> => {
    if (state.stopped) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (state.stopped) return;
      if (ALWAYS_IGNORED.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      const relativePath = displayPath(ignoreRoot, absolute);
      if (isIgnored(relativePath, entry.isDirectory(), rules)) continue;
      if (entry.isDirectory()) await recurse(absolute);
      else await visit(absolute);
    }
  };
  await recurse(root);
}

async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  let text: string;
  try {
    text = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let body = negated ? line.slice(1) : line;
    if (!body) continue;
    const directoryOnly = body.endsWith("/");
    if (directoryOnly) body = body.slice(0, -1);
    body = body.replace(/^\/+/, "");
    if (!body) continue;
    rules.push({
      negated,
      directoryOnly,
      anchored: body.includes("/"),
      regex: globToRegExp(body),
    });
  }
  return rules;
}

function isIgnored(path: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const matched = rule.regex.test(rule.anchored ? path : basename(path));
    if (matched) ignored = !rule.negated;
  }
  return ignored;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function displayPath(base: string, file: string): string {
  return relative(resolve(base), file).split(sep).join("/");
}
