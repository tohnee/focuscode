import { describe, expect, it } from "vitest";
import {
  PrefixRuleEngine,
  DEFAULT_PREFIX_RULES,
  type CommandPrefixRule,
} from "../src/shell-policy.js";

describe("PrefixRuleEngine", () => {
  describe("construction and self-test", () => {
    it("constructs with no rules", () => {
      const engine = new PrefixRuleEngine([]);
      expect(engine.check("git push")).toBeUndefined();
    });

    it("constructs with valid rules and passing self-test examples", () => {
      const engine = new PrefixRuleEngine([
        {
          prefix: "git push --force",
          effect: "deny",
          reason: "destructive",
          match: ["git push --force origin main"],
          notMatch: ["git push", "git status"],
        },
      ]);
      expect(engine).toBeDefined();
    });

    it("throws on self-test failure: match example does not match", () => {
      const badRule: CommandPrefixRule = {
        prefix: "git push",
        effect: "deny",
        reason: "test",
        match: ["npm install"], // wrong - should not match "git push"
      };
      expect(() => new PrefixRuleEngine([badRule])).toThrow(
        /should match "npm install" but does not/,
      );
    });

    it("throws on self-test failure: notMatch example matches", () => {
      const badRule: CommandPrefixRule = {
        prefix: "git push",
        effect: "deny",
        reason: "test",
        notMatch: ["git push --force"], // wrong - should NOT match but does
      };
      expect(() => new PrefixRuleEngine([badRule])).toThrow(
        /should NOT match "git push --force" but does/,
      );
    });

    it("loads default rules without self-test failure", () => {
      const engine = new PrefixRuleEngine(DEFAULT_PREFIX_RULES);
      expect(engine).toBeDefined();
    });
  });

  describe("check()", () => {
    const engine = new PrefixRuleEngine([
      {
        prefix: "git push --force",
        effect: "deny",
        reason: "destructive",
        match: ["git push --force origin main"],
        notMatch: ["git push", "git status"],
      },
      {
        prefix: "npm test",
        effect: "allow",
        reason: "safe",
        match: ["npm test", "npm test -- --grep foo"],
        notMatch: ["npm install", "npm publish"],
      },
    ]);

    it("returns deny for matching deny rule", () => {
      const result = engine.check("git push --force origin main");
      expect(result?.effect).toBe("deny");
      expect(result?.reason).toBe("destructive");
    });

    it("returns allow for matching allow rule", () => {
      const result = engine.check("npm test -- --grep foo");
      expect(result?.effect).toBe("allow");
    });

    it("returns undefined when no rule matches", () => {
      expect(engine.check("ls -la")).toBeUndefined();
      expect(engine.check("git status")).toBeUndefined();
    });

    it("first matching rule wins (deny before allow)", () => {
      const engine2 = new PrefixRuleEngine([
        { prefix: "git", effect: "deny", reason: "all git denied" },
        { prefix: "git status", effect: "allow", reason: "status is safe" },
      ]);
      // "git status" matches "git" first, so deny wins
      const result = engine2.check("git status");
      expect(result?.effect).toBe("deny");
    });
  });

  describe("prefix matching semantics", () => {
    const engine = new PrefixRuleEngine([{ prefix: "git push", effect: "deny", reason: "test" }]);

    it("matches exact prefix", () => {
      expect(engine.check("git push")?.effect).toBe("deny");
    });

    it("matches prefix with additional arguments", () => {
      expect(engine.check("git push origin main")?.effect).toBe("deny");
    });

    it("does not match shorter command", () => {
      expect(engine.check("git")).toBeUndefined();
    });

    it("does not match different command with same prefix text", () => {
      expect(engine.check("gitter push")).toBeUndefined();
    });

    it("is case-sensitive", () => {
      expect(engine.check("GIT PUSH")).toBeUndefined();
    });

    it("handles multi-word prefix", () => {
      const engine2 = new PrefixRuleEngine([
        { prefix: "docker rm", effect: "deny", reason: "no rm" },
      ]);
      expect(engine2.check("docker rm container")?.effect).toBe("deny");
      expect(engine2.check("docker run")).toBeUndefined();
    });
  });

  describe("D6: argv edge cases", () => {
    const engine = new PrefixRuleEngine([{ prefix: "git push", effect: "deny", reason: "test" }]);

    describe("empty and whitespace", () => {
      it("returns undefined for empty command", () => {
        expect(engine.check("")).toBeUndefined();
      });

      it("returns undefined for whitespace-only command", () => {
        expect(engine.check("   ")).toBeUndefined();
      });

      it("returns undefined for tab-only command", () => {
        expect(engine.check("\t\t")).toBeUndefined();
      });
    });

    describe("whitespace separators", () => {
      it("matches tab-separated words", () => {
        expect(engine.check("git\tpush origin main")?.effect).toBe("deny");
      });

      it("matches with multiple spaces between words", () => {
        expect(engine.check("git  push origin")?.effect).toBe("deny");
      });

      it("matches command with leading whitespace", () => {
        expect(engine.check("  git push")?.effect).toBe("deny");
      });

      it("matches command with trailing whitespace", () => {
        expect(engine.check("git push   ")?.effect).toBe("deny");
      });

      it("matches command with newline separator", () => {
        expect(engine.check("git\npush origin")?.effect).toBe("deny");
      });
    });

    describe("shell quoting", () => {
      it("matches double-quoted argument matching prefix word", () => {
        expect(engine.check('git "push" origin')?.effect).toBe("deny");
      });

      it("matches single-quoted argument matching prefix word", () => {
        expect(engine.check("git 'push' origin")?.effect).toBe("deny");
      });

      it("does not match when quoted argument differs from prefix word", () => {
        expect(engine.check('git "status"')).toBeUndefined();
      });
    });

    describe("escape characters", () => {
      it("treats backslash-escaped space as part of a single word", () => {
        // "git\ push" is a single token "git push" in shell semantics;
        // it should NOT match prefix ["git", "push"].
        expect(engine.check("git\\ push")).toBeUndefined();
      });

      it("handles backslash-escaped space in argument", () => {
        // "git push origin\ main" → splitShellWords: ["git", "push", "origin main"]
        // prefix ["git", "push"] still matches because we only check the first N words
        expect(engine.check("git push origin\\ main")?.effect).toBe("deny");
      });
    });

    describe("wildcards are literal", () => {
      it("treats * as literal text, not glob", () => {
        const eng = new PrefixRuleEngine([{ prefix: "git *", effect: "deny", reason: "wildcard" }]);
        // * is literal: "git push" does NOT match "git *"
        expect(eng.check("git push")).toBeUndefined();
        // "git *" with literal * does match
        expect(eng.check("git * origin")?.effect).toBe("deny");
      });

      it("treats ? as literal text, not glob", () => {
        const eng = new PrefixRuleEngine([{ prefix: "git ?", effect: "deny", reason: "wildcard" }]);
        expect(eng.check("git push")).toBeUndefined();
        expect(eng.check("git ? origin")?.effect).toBe("deny");
      });
    });

    describe("option flags are not skipped", () => {
      it("does not match when flags are between command and prefix words", () => {
        // "git -c foo push" → words: ["git", "-c", "foo", "push"]
        // prefix ["git", "push"] does NOT match because word[1] is "-c" not "push"
        expect(engine.check("git -c foo push")?.effect).toBeUndefined();
      });

      it("matches when flags appear after the full prefix", () => {
        expect(engine.check("git push --force origin")?.effect).toBe("deny");
      });
    });

    describe("env var prefixes", () => {
      it("does not match when command starts with env var assignment", () => {
        // FOO=bar git push → words: ["FOO=bar", "git", "push"]
        // prefix ["git", "push"] does NOT match because word[0] is "FOO=bar"
        expect(engine.check("FOO=bar git push")?.effect).toBeUndefined();
      });
    });

    describe("empty prefix validation", () => {
      it("throws when constructing a rule with empty prefix", () => {
        expect(
          () => new PrefixRuleEngine([{ prefix: "", effect: "deny", reason: "empty" }]),
        ).toThrow(/empty.*prefix/i);
      });

      it("throws when constructing a rule with whitespace-only prefix", () => {
        expect(
          () => new PrefixRuleEngine([{ prefix: "   ", effect: "deny", reason: "ws" }]),
        ).toThrow(/empty.*prefix/i);
      });
    });
  });
});
