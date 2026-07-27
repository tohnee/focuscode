import { normalizeRelativePath } from "@focuscode/contracts";

/**
 * Shell and patch policy rules for the conversational agent. These are the
 * single source of the rule semantics: PolicyEngine consumes them for both
 * the kernel envelope and the session approval matrix, and the agent-runtime
 * PermissionController re-exports them for its local adapter role. They are
 * pure functions over the command/patch text; path protection itself lives in
 * PolicyEngine.
 *
 * The classifier now combines the original regular-expression rules with a
 * structural analysis layer (`analyzeShellCommand`): a quote-aware AST-lite
 * tokenizer that splits command chains on shell control operators and detects
 * command substitution, variable/tilde expansion, redirection, and
 * interpreter wrappers (`bash -c`, `python -c`, `eval`, `sudo`, ...). Regex
 * rules are evaluated per sub-command and the highest risk wins, so
 * `ls; rm -rf ~` can no longer hide behind an innocent prefix; wrapper and
 * substitution constructs floor the risk at "high" because they can smuggle
 * arbitrary code past literal patterns.
 */

const CRITICAL_SHELL_PATTERNS: Array<[RegExp, string]> = [
  [
    /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/,
    "recursive deletion of a broad system path",
  ],
  [/\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b/i, "disk formatting or partitioning"],
  [/\bdd\s+[^\n]*\bof=\/dev\//i, "raw device write"],
  [/\b(?:shutdown|reboot|poweroff|halt)\b/i, "host shutdown"],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, "fork bomb"],
  [
    /\b(?:curl|wget)\b[^\n|;]*(?:\||\$\()[^\n]*(?:sh|bash|zsh|powershell)\b/i,
    "download-and-execute pipeline",
  ],
];

const HIGH_RISK_SHELL_PATTERNS: Array<[RegExp, string]> = [
  [/\bgit\s+reset\s+--hard\b/i, "destructive git reset"],
  [/\bgit\s+clean\s+-[^\s]*f/i, "destructive git clean"],
  [/\bgit\s+(?:push\s+[^\n]*--force|push\s+-f)\b/i, "force push"],
  [/\b(?:sudo|su)\b/i, "privilege escalation"],
  [/\b(?:rm|rmdir|del|erase)\b/i, "file deletion"],
  [/\b(?:chmod|chown)\b/i, "permission or ownership change"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish)\b/i, "package publication"],
  [
    /\b(?:terraform\s+apply|kubectl\s+(?:apply|delete)|docker\s+(?:push|rm))\b/i,
    "external infrastructure mutation",
  ],
];

const READ_ONLY_SHELL = [
  /^\s*(?:pwd|ls|find|fd|rg|grep|cat|head|tail|wc|sed\s+-n|awk|stat|file|which|type)\b/,
  /^\s*git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|grep)\b/,
  /^\s*(?:node|python|python3|ruby|go|rustc|java)\s+--?version\b/,
];

export const TRUSTED_PROJECT_COMMAND =
  /^\s*(?:npm|pnpm|yarn|bun|npx|uv|python|python3|pytest|go|cargo|mvn|gradle|make)\s+(?:test|run\s+(?:test|lint|check|build|typecheck)|lint|check|build|typecheck|pytest|vet)(?:\s|$)/;

export type ShellRisk = "low" | "medium" | "high" | "critical";

export interface ShellClassification {
  risk: ShellRisk;
  reason: string;
}

export interface ShellCommandAnalysis {
  /** Sub-commands split on shell control operators (`&&`, `||`, `;`, `|`, `&`, newline). */
  segments: string[];
  /** `$(...)` or backtick substitution, including inside double quotes. */
  hasCommandSubstitution: boolean;
  /** `$VAR`, `${VAR}` (outside single quotes) or word-leading `~`. */
  hasExpansion: boolean;
  /** Any unquoted `<`/`>` redirection (`>`, `>>`, `<`, `2>`, `&>`, `>&`, ...). */
  hasRedirection: boolean;
  /** Interpreter/wrapper invocations found in command position. */
  wrappedInterpreters: string[];
}

const INTERPRETER_NAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "eval",
  "exec",
  "xargs",
  "env",
  "time",
  "nice",
  "nohup",
  "watch",
  "sudo",
  "doas",
  "busybox",
]);

/** Wrappers whose own arguments contain the real command (`sudo bash`, `env sh`, ...). */
const CHAINABLE_WRAPPERS = new Set([
  "exec",
  "xargs",
  "env",
  "time",
  "nice",
  "nohup",
  "watch",
  "sudo",
  "doas",
  "busybox",
]);

function interpreterName(word: string): string | null {
  const base = word.slice(word.lastIndexOf("/") + 1);
  if (INTERPRETER_NAMES.has(base)) return base;
  if (/^python\d(?:\.\d+)?$/.test(base)) return base;
  return null;
}

/** Quote-aware word splitter; strips quotes and resolves backslash escapes. */
function splitShellWords(segment: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < segment.length) word += segment[++i]!;
      else word += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      word += segment[++i]!;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (/\s/.test(ch)) {
      if (word) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += ch;
  }
  if (word) words.push(word);
  return words;
}

function detectWrappedInterpreters(segments: string[]): string[] {
  const found = new Set<string>();
  for (const segment of segments) {
    const words = splitShellWords(segment);
    let i = 0;
    let commandPosition = true;
    while (i < words.length && commandPosition) {
      const word = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        i++; // VAR=value prefix, command position continues
        continue;
      }
      const name = interpreterName(word);
      if (name === null) {
        commandPosition = false;
        continue;
      }
      found.add(name);
      if (CHAINABLE_WRAPPERS.has(name)) {
        // Skip the wrapper's option flags, then re-examine the next word as
        // the wrapped command (`sudo -n bash`, `xargs -I{} sh`, ...).
        i++;
        while (i < words.length && words[i]!.startsWith("-")) i++;
        continue;
      }
      commandPosition = false;
    }
  }
  return [...found];
}

/**
 * Structural shell analysis: a quote-aware AST-lite tokenizer. Control
 * operators inside single/double quotes or command substitutions do not
 * split segments; `$(...)` and backticks still count as substitution inside
 * double quotes, but not inside single quotes.
 */
export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const segments: string[] = [];
  let current = "";
  let hasCommandSubstitution = false;
  let hasExpansion = false;
  let hasRedirection = false;
  let quote: "'" | '"' | null = null;
  let backtick = false;
  let substitutionDepth = 0;

  const pushSegment = (): void => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = i + 1 < command.length ? command[i + 1]! : "";

    if (backtick) {
      current += ch;
      if (ch === "`") backtick = false;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && next) {
        current += next;
        i++;
        continue;
      }
      if (ch === "$" && next === "(") {
        hasCommandSubstitution = true;
        substitutionDepth++;
        current += next;
        i++;
        continue;
      }
      if (ch === "`") {
        hasCommandSubstitution = true;
        backtick = true;
        continue;
      }
      if (ch === "$" && /[A-Za-z_{]/.test(next)) hasExpansion = true;
      continue;
    }

    // Unquoted context.
    if (ch === "\\" && next) {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      current += ch;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      current += ch;
      continue;
    }
    if (ch === "`") {
      hasCommandSubstitution = true;
      backtick = true;
      current += ch;
      continue;
    }
    if (ch === "$") {
      if (next === "(") {
        hasCommandSubstitution = true;
        substitutionDepth++;
        current += ch + next;
        i++;
        continue;
      }
      if (/[A-Za-z_{]/.test(next)) hasExpansion = true;
      current += ch;
      continue;
    }
    if (ch === ")" && substitutionDepth > 0) {
      substitutionDepth--;
      current += ch;
      continue;
    }
    if (ch === "~" && (i === 0 || /[\s=:(]/.test(command[i - 1]!))) {
      hasExpansion = true;
      current += ch;
      continue;
    }
    if (ch === ">" || ch === "<") {
      hasRedirection = true;
      current += ch;
      if (next === "&" || next === ch) {
        current += next;
        i++;
      }
      continue;
    }
    if (substitutionDepth > 0) {
      // Inside $(...): content is a nested command; it is already flagged as
      // substitution, so do not split segments on its operators.
      current += ch;
      continue;
    }
    if (ch === "&") {
      if (next === ">") {
        hasRedirection = true;
        current += ch + next;
        i++;
        continue;
      }
      pushSegment();
      if (next === "&") i++;
      continue;
    }
    if (ch === "|") {
      pushSegment();
      if (next === "|") i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pushSegment();
      continue;
    }
    current += ch;
  }
  pushSegment();

  return {
    segments,
    hasCommandSubstitution,
    hasExpansion,
    hasRedirection,
    wrappedInterpreters: detectWrappedInterpreters(segments),
  };
}

const SHELL_RISK_RANK: Record<ShellRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function matchShellPatterns(text: string): ShellClassification | null {
  for (const [pattern, reason] of CRITICAL_SHELL_PATTERNS) {
    if (pattern.test(text)) return { risk: "critical", reason };
  }
  for (const [pattern, reason] of HIGH_RISK_SHELL_PATTERNS) {
    if (pattern.test(text)) return { risk: "high", reason };
  }
  return null;
}

export function classifyShell(commandValue: unknown): ShellClassification {
  if (typeof commandValue !== "string" || !commandValue.trim()) {
    return { risk: "high", reason: "Invalid shell command" };
  }
  const command = commandValue.trim();
  const analysis = analyzeShellCommand(command);

  // Regex rules run over the full command (some patterns intentionally span
  // operators, e.g. download-and-execute pipelines) and over every segment of
  // a command chain; the highest risk wins, so a dangerous sub-command cannot
  // hide behind an innocent prefix like `ls; rm -rf ~`.
  let result: ShellClassification | null = null;
  for (const text of [command, ...analysis.segments]) {
    const matched = matchShellPatterns(text);
    if (
      matched &&
      (result === null || SHELL_RISK_RANK[matched.risk] > SHELL_RISK_RANK[result.risk])
    ) {
      result = matched;
    }
  }

  // Structural elevations: never lower an existing classification.
  if (result === null || SHELL_RISK_RANK[result.risk] < SHELL_RISK_RANK.high) {
    if (analysis.wrappedInterpreters.length > 0) {
      result = {
        risk: "high",
        reason: `interpreter wrapper can execute arbitrary code: ${analysis.wrappedInterpreters.join(", ")}`,
      };
    } else if (analysis.hasCommandSubstitution) {
      result = { risk: "high", reason: "command substitution hides nested commands" };
    }
  }
  if (result !== null) return result;

  if (
    READ_ONLY_SHELL.some((pattern) => pattern.test(command)) &&
    analysis.segments.length <= 1 &&
    !analysis.hasRedirection &&
    !analysis.hasCommandSubstitution &&
    analysis.wrappedInterpreters.length === 0 &&
    !/(?:^|\s)(?:\/|~\/|\$HOME\/)/.test(command)
  ) {
    return { risk: "low", reason: "Recognized read-only command" };
  }
  if (TRUSTED_PROJECT_COMMAND.test(command)) {
    return { risk: "medium", reason: "Project command can execute repository-controlled code" };
  }
  return { risk: "medium", reason: "General shell command requires approval" };
}

/**
 * Whether a command is "arbitrary shell" for enterprise-mode purposes: a
 * multi-command chain, an interpreter wrapper, command substitution, any
 * redirection, or anything that matches neither the known read-only patterns
 * nor the trusted project-command pattern.
 */
export function isArbitraryShell(command: string): boolean {
  if (typeof command !== "string" || !command.trim()) return true;
  const trimmed = command.trim();
  const analysis = analyzeShellCommand(trimmed);
  if (analysis.segments.length > 1) return true;
  if (analysis.wrappedInterpreters.length > 0) return true;
  if (analysis.hasCommandSubstitution) return true;
  if (analysis.hasRedirection) return true;
  if (READ_ONLY_SHELL.some((pattern) => pattern.test(trimmed))) return false;
  if (TRUSTED_PROJECT_COMMAND.test(trimmed)) return false;
  return true;
}

export function commandReferencesPath(command: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s'"/])${escaped}(?:[\\s'"/]|$)`).test(command.replaceAll("\\", "/"));
}

/**
 * Extract the target paths of an apply_patch document (the `---`/`+++` header
 * lines), normalized so dot-segment disguises resolve before comparison.
 */
export function extractApplyPatchPaths(patch: string): string[] {
  return [...patch.matchAll(/^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\t\n]+)$/gm)].map((match) =>
    normalizeRelativePath(match[1]!),
  );
}

// ─── Execpolicy-style prefix rules with load-time self-test ───────────

export interface CommandPrefixRule {
  /** Command prefix to match (e.g., "git push", "npm publish"). Split on whitespace. */
  prefix: string;
  /** Allow or deny matching commands. */
  effect: "allow" | "deny";
  /** Human-readable reason. */
  reason: string;
  /** Examples that MUST match this rule (verified at load time). */
  match?: string[];
  /** Examples that MUST NOT match this rule (verified at load time). */
  notMatch?: string[];
}

export interface PrefixRuleCheckResult {
  effect: "allow" | "deny";
  reason: string;
  rule: CommandPrefixRule;
}

/**
 * Default prefix rules mirroring the high-risk shell patterns already encoded
 * in PolicyEngine, exposed as user-editable starting point. The engine's
 * constructor runs the self-test on these just like on user-supplied rules.
 */
export const DEFAULT_PREFIX_RULES: CommandPrefixRule[] = [
  {
    prefix: "git push --force",
    effect: "deny",
    reason: "Force push is destructive and can overwrite remote history",
    match: ["git push --force origin main", "git push --force"],
    notMatch: ["git push", "git status"],
  },
  {
    prefix: "git push --force-with-lease",
    effect: "allow",
    reason: "Force push with lease is safer (checks remote ref)",
    match: ["git push --force-with-lease origin main"],
    notMatch: ["git push --force"],
  },
  {
    prefix: "npm publish",
    effect: "deny",
    reason: "Package publication is irreversible",
    match: ["npm publish", "npm publish --access public"],
    notMatch: ["npm install", "npm test"],
  },
];

/**
 * User-configurable command prefix rule engine with load-time self-test.
 * Rules are evaluated in declaration order; the first match wins. If a rule's
 * `match` / `notMatch` examples contradict its prefix, the constructor throws
 * immediately — rules that are wrong should explode at load time, not silently
 * misfire at execution time.
 */
export class PrefixRuleEngine {
  private readonly rules: CommandPrefixRule[];

  constructor(rules: CommandPrefixRule[]) {
    this.rules = rules;
    for (const rule of rules) {
      const prefixWords = rule.prefix.trim().split(/\s+/);
      for (const example of rule.match ?? []) {
        if (!this.matchesPrefix(example, prefixWords)) {
          throw new Error(
            `Prefix rule self-test failed: rule "${rule.prefix}" should match "${example}" but does not.`,
          );
        }
      }
      for (const example of rule.notMatch ?? []) {
        if (this.matchesPrefix(example, prefixWords)) {
          throw new Error(
            `Prefix rule self-test failed: rule "${rule.prefix}" should NOT match "${example}" but does.`,
          );
        }
      }
    }
  }

  /**
   * Check a command against all rules. Returns the first matching rule's
   * result, or undefined if no rule matches. Rules are evaluated in order;
   * the first match wins (deny-first ordering is the caller's responsibility).
   */
  check(command: string): PrefixRuleCheckResult | undefined {
    for (const rule of this.rules) {
      const prefixWords = rule.prefix.trim().split(/\s+/);
      if (this.matchesPrefix(command, prefixWords)) {
        return { effect: rule.effect, reason: rule.reason, rule };
      }
    }
    return undefined;
  }

  /**
   * Prefix matching: the command's first N words must equal the prefix words.
   * This is argv-prefix matching, NOT substring matching — "git" matches
   * "git status" but not "gitter". Option flags between the command and the
   * prefix are NOT skipped (unlike Codex's execpolicy which uses argv arrays);
   * this is a simpler text-word approach.
   */
  private matchesPrefix(command: string, prefixWords: string[]): boolean {
    const commandWords = command.trim().split(/\s+/);
    if (commandWords.length < prefixWords.length) return false;
    for (let i = 0; i < prefixWords.length; i++) {
      if (commandWords[i] !== prefixWords[i]) return false;
    }
    return true;
  }
}
