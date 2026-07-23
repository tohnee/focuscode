import { describe, expect, it } from "vitest";
import { selectSkillsForTools, type Skill } from "../src/skills.js";

function makeSkill(name: string, toolNames?: string[]): Skill {
  return {
    name,
    description: "d",
    trigger: toolNames ? { toolNames } : {},
    prompt: "p",
    allowedTools: [],
  };
}

describe("selectSkillsForTools", () => {
  it("returns skills whose trigger.toolNames includes the called tool", () => {
    const skills = [
      makeSkill("bash-skill", ["bash"]),
      makeSkill("read-skill", ["read_file"]),
      makeSkill("no-tools"),
    ];
    const selected = selectSkillsForTools(skills, ["bash"]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.name).toBe("bash-skill");
  });

  it("returns multiple skills when several match", () => {
    const skills = [
      makeSkill("a", ["bash", "read_file"]),
      makeSkill("b", ["bash"]),
      makeSkill("c", ["write_file"]),
    ];
    const selected = selectSkillsForTools(skills, ["bash"]);
    expect(selected).toHaveLength(2);
    expect(selected.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("returns [] when no skills match", () => {
    const skills = [makeSkill("a", ["read_file"])];
    const selected = selectSkillsForTools(skills, ["bash"]);
    expect(selected).toEqual([]);
  });

  it("returns [] when skills have no toolNames", () => {
    const skills = [makeSkill("a")];
    const selected = selectSkillsForTools(skills, ["bash"]);
    expect(selected).toEqual([]);
  });

  it("matches against any toolName in the called list", () => {
    const skills = [makeSkill("a", ["read_file"])];
    const selected = selectSkillsForTools(skills, ["bash", "read_file"]);
    expect(selected).toHaveLength(1);
  });

  it("returns [] for an empty toolNames input", () => {
    const skills = [makeSkill("a", ["bash"])];
    const selected = selectSkillsForTools(skills, []);
    expect(selected).toEqual([]);
  });

  it("does not duplicate skills when multiple tools match", () => {
    const skills = [makeSkill("a", ["bash", "read_file"])];
    const selected = selectSkillsForTools(skills, ["bash", "read_file"]);
    expect(selected).toHaveLength(1);
  });
});
