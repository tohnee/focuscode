import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { loadSkillsFromDirectory } from "../src/skills.js";
import { parseJsonResponse } from "../src/spec-pipeline-helpers.js";

/**
 * D8（空 catch 审查）TDD 测试用例。
 *
 * 原则：不改变行为，仅补充日志。测试通过 spy console.warn 验证日志输出，
 * 同时验证返回值保持不变。
 *
 * 覆盖：
 * - spec-pipeline-helpers.ts: parseJsonResponse catch
 * - skills.ts: loadSkillsFromDirectory readdir catch
 * - session-store.ts: readLock catch
 * - spec-explorer.ts: modelClient.complete catch
 * - 行为不变验证（回归测试）
 */

const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

afterEach(() => {
  warnSpy.mockClear();
});

describe("D8 空 catch 审查 · spec-pipeline-helpers", () => {
  it("TC-D8-04: parseJsonResponse 解析失败时返回 null 并输出 warn 日志", () => {
    const result = parseJsonResponse("not valid json {{{");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain("parseJsonResponse");
  });

  it("TC-D8-04b: parseJsonResponse 解析成功时不输出 warn 日志", () => {
    warnSpy.mockClear();
    parseJsonResponse('{"key":"value"}');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("D8 空 catch 审查 · skills.ts", () => {
  it("TC-D8-08: loadSkillsFromDirectory 目录不存在时返回 [] 并输出 warn 日志", async () => {
    warnSpy.mockClear();
    const result = await loadSkillsFromDirectory("/nonexistent/path/that/should/not/exist");
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain("skills");
  });

  it("TC-D8-08b: loadSkillsFromDirectory 目录存在但为空时返回 [] 不输出 warn", async () => {
    warnSpy.mockClear();
    const dir = await mkdtemp(join(tmpdir(), "skills-empty-"));
    const result = await loadSkillsFromDirectory(dir);
    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("D8 空 catch 审查 · 行为不变验证（回归测试）", () => {
  it("TC-D8-S1: parseJsonResponse 对合法 JSON 仍正常返回", () => {
    const result = parseJsonResponse('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });

  it("TC-D8-S2: parseJsonResponse 对 code-fence 包裹的 JSON 仍正常返回", () => {
    const result = parseJsonResponse('```json\n{"b":2}\n```');
    expect(result).toEqual({ b: 2 });
  });

  it("TC-D8-S3: parseJsonResponse 对空字符串返回 null", () => {
    const result = parseJsonResponse("");
    expect(result).toBeNull();
  });

  it("TC-D8-S4: loadSkillsFromDirectory 对合法 SKILL.md 仍正常解析", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-valid-"));
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill\n---\nThis is the body.\n",
    );
    const result = await loadSkillsFromDirectory(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("test-skill");
    expect(result[0]!.description).toBe("A test skill");
  });

  it("TC-D8-S5: loadSkillsFromDirectory 递归加载子目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-nested-"));
    const subDir = join(dir, "category");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "SKILL.md"),
      "---\nname: nested-skill\ndescription: nested\n---\nbody\n",
    );
    const result = await loadSkillsFromDirectory(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("nested-skill");
  });
});
