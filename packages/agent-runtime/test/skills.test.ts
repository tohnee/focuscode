import { describe, expect, it } from "vitest";
import {
  loadSkills,
  selectSkills,
  buildSkillPrompt,
  type SkillManifest,
  type Skill,
} from "../src/skills.js";

describe("skills loader", () => {
  it("loads skills from manifest", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "Test-driven development",
          trigger: { keywords: ["test", "tdd", "spec"] },
          prompt: "Always write failing test first, then implement.",
          allowedTools: ["read", "write", "edit", "bash"],
        },
      ],
    };
    const skills = loadSkills(manifest);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("tdd");
  });

  it("selects skills by keyword match", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["test"] },
          prompt: "TDD prompt",
          allowedTools: [],
        },
        {
          name: "refactor",
          description: "Refactor",
          trigger: { keywords: ["refactor", "clean"] },
          prompt: "Refactor prompt",
          allowedTools: [],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "please test this function");
    expect(selected.map((s) => s.name)).toEqual(["tdd"]);
  });

  it("selects multiple skills when multiple keywords match", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["test"] },
          prompt: "TDD prompt",
          allowedTools: [],
        },
        {
          name: "refactor",
          description: "Refactor",
          trigger: { keywords: ["refactor"] },
          prompt: "Refactor prompt",
          allowedTools: [],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "test and refactor please");
    expect(selected.map((s) => s.name).sort()).toEqual(["refactor", "tdd"]);
  });

  it("builds prompt from selected skills", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["test"] },
          prompt: "Write test first.",
          allowedTools: ["read", "write"],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "test please");
    const prompt = buildSkillPrompt(selected);
    expect(prompt).toContain("Write test first.");
    expect(prompt).toContain("Allowed tools: read, write");
  });

  it("returns empty string when no skills selected", () => {
    const prompt = buildSkillPrompt([]);
    expect(prompt).toBe("");
  });

  it("rejects manifest with invalid schema version", () => {
    expect(() => loadSkills({ schemaVersion: "invalid", skills: [] })).toThrow(
      /Unsupported skills schema/,
    );
  });

  it("handles case-insensitive keyword matching", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["TEST"] },
          prompt: "TDD prompt",
          allowedTools: [],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "please test this");
    expect(selected).toHaveLength(1);
  });

  it("omits Allowed tools line when skill has no allowedTools", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "minimal",
          description: "Minimal",
          trigger: { keywords: ["min"] },
          prompt: "Minimal prompt.",
          allowedTools: [],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "min");
    const prompt = buildSkillPrompt(selected);
    expect(prompt).not.toContain("Allowed tools");
  });

  it("returns defensive copies to prevent caller mutation", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["test"] },
          prompt: "prompt",
          allowedTools: ["read"],
        },
      ],
    };
    const skills = loadSkills(manifest);
    skills[0]!.name = "mutated";
    skills[0]!.trigger.keywords!.push("mutated-keyword");
    expect(manifest.skills[0]!.name).toBe("tdd");
    expect(manifest.skills[0]!.trigger.keywords).not.toContain("mutated-keyword");
  });

  it("Skill type is compatible with manifest entries", () => {
    const skill: Skill = {
      name: "test",
      description: "desc",
      trigger: { keywords: ["k"] },
      prompt: "p",
      allowedTools: [],
    };
    expect(skill.name).toBe("test");
  });
});
