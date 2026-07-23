import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDirectory, type Skill } from "../src/skills.js";

describe("loadSkillsFromDirectory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "focuscode-skills-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("parses a SKILL.md with frontmatter and body as prompt", async () => {
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: my-skill",
        "description: A skill for testing",
        "trigger:",
        "  keywords:",
        "    - test",
        "  toolNames:",
        "    - bash",
        "allowedTools:",
        "  - bash",
        "---",
        "This is the skill prompt body.",
      ].join("\n"),
    );
    const skills = await loadSkillsFromDirectory(dir);
    expect(skills).toHaveLength(1);
    const skill = skills[0];
    expect(skill?.name).toBe("my-skill");
    expect(skill?.description).toBe("A skill for testing");
    expect(skill?.trigger.keywords).toEqual(["test"]);
    expect(skill?.trigger.toolNames).toEqual(["bash"]);
    expect(skill?.allowedTools).toEqual(["bash"]);
    expect(skill?.prompt).toBe("This is the skill prompt body.");
  });

  it("returns [] when the directory does not exist", async () => {
    const skills = await loadSkillsFromDirectory(join(dir, "nonexistent"));
    expect(skills).toEqual([]);
  });

  it("returns [] when the directory has no SKILL.md files", async () => {
    await writeFile(join(dir, "other.txt"), "hello");
    const skills = await loadSkillsFromDirectory(dir);
    expect(skills).toEqual([]);
  });

  it("loads multiple SKILL.md files from nested directories", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: top-skill",
        "description: Top skill",
        "trigger:",
        "  keywords: []",
        "allowedTools: []",
        "---",
        "Top prompt.",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "sub", "SKILL.md"),
      [
        "---",
        "name: sub-skill",
        "description: Sub skill",
        "trigger:",
        "  keywords: []",
        "allowedTools: []",
        "---",
        "Sub prompt.",
      ].join("\n"),
    );
    const skills = await loadSkillsFromDirectory(dir);
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["sub-skill", "top-skill"]);
  });

  it("throws on malformed frontmatter (missing closing ---)", async () => {
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: broken",
        "description: Missing closing delimiter",
        "trigger: {}",
        "allowedTools: []",
        "No closing frontmatter delimiter.",
      ].join("\n"),
    );
    await expect(loadSkillsFromDirectory(dir)).rejects.toThrow();
  });

  it("throws when required field 'name' is missing", async () => {
    await writeFile(
      join(dir, "SKILL.md"),
      ["---", "description: Missing name", "trigger: {}", "allowedTools: []", "---", "Body."].join(
        "\n",
      ),
    );
    await expect(loadSkillsFromDirectory(dir)).rejects.toThrow("name");
  });

  it("throws when required field 'description' is missing", async () => {
    await writeFile(
      join(dir, "SKILL.md"),
      ["---", "name: has-name", "trigger: {}", "allowedTools: []", "---", "Body."].join("\n"),
    );
    await expect(loadSkillsFromDirectory(dir)).rejects.toThrow("description");
  });

  it("handles empty keywords and toolNames arrays", async () => {
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: minimal",
        "description: Minimal skill",
        "trigger: {}",
        "allowedTools: []",
        "---",
        "Body.",
      ].join("\n"),
    );
    const skills = await loadSkillsFromDirectory(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.trigger.keywords).toEqual([]);
    expect(skills[0]?.trigger.toolNames).toBeUndefined();
    expect(skills[0]?.allowedTools).toEqual([]);
  });

  it("skips node_modules and .git directories", async () => {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "SKILL.md"),
      [
        "---",
        "name: should-not-load",
        "description: x",
        "trigger: {}",
        "allowedTools: []",
        "---",
        "Body.",
      ].join("\n"),
    );
    await writeFile(
      join(dir, ".git", "SKILL.md"),
      [
        "---",
        "name: should-not-load-either",
        "description: x",
        "trigger: {}",
        "allowedTools: []",
        "---",
        "Body.",
      ].join("\n"),
    );
    const skills = await loadSkillsFromDirectory(dir);
    expect(skills).toEqual([]);
  });
});
