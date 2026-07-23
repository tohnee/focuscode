import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  createCodingToolRegistry,
  globToRegExp,
  grepRecursive,
  listFiles,
  setRgAvailabilityOverride,
} from "../src/index.js";

async function fixtureTree(): Promise<string> {
  const root = await createTestDirectory("rg-fallback");
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "alpha\nbeta alpha\n");
  await writeFile(join(root, "src", "deep", "b.ts"), "gamma\nalpha deep\n");
  await writeFile(join(root, "src", "c.txt"), "alpha text\n");
  await writeFile(join(root, "src", "debug.log"), "alpha in ignored log\n");
  await writeFile(join(root, "keep.log"), "alpha in kept log\n");
  await writeFile(join(root, "build", "out.ts"), "alpha in ignored dir\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
  await writeFile(join(root, ".gitignore"), "*.log\nbuild/\n!keep.log\n");
  return root;
}

describe("rg-fallback grepRecursive", () => {
  it("finds matches with path:line:column and skips ignored/binary files", async () => {
    const root = await fixtureTree();
    const matches = await grepRecursive(root, { pattern: "alpha", maxResults: 50 });
    expect(matches.map((match) => match.path).sort()).toEqual([
      "keep.log",
      "src/a.ts",
      "src/a.ts",
      "src/c.txt",
      "src/deep/b.ts",
    ]);
    expect(matches.find((match) => match.path === "src/a.ts")).toMatchObject({
      line: 1,
      column: 1,
      content: "alpha",
    });
    expect(matches.filter((match) => match.path === "src/a.ts")[1]).toMatchObject({
      line: 2,
      column: 6,
    });
    expect(matches.find((match) => match.path === "src/deep/b.ts")).toMatchObject({
      line: 2,
      column: 1,
    });
  });

  it("honors ignoreCase, glob and maxResults", async () => {
    const root = await fixtureTree();
    const insensitive = await grepRecursive(root, {
      pattern: "ALPHA",
      ignoreCase: true,
      maxResults: 50,
    });
    expect(insensitive.length).toBeGreaterThan(0);
    const onlyTs = await grepRecursive(root, {
      pattern: "alpha",
      glob: "**/*.ts",
      maxResults: 50,
    });
    expect(onlyTs.map((match) => match.path).sort()).toEqual([
      "src/a.ts",
      "src/a.ts",
      "src/deep/b.ts",
    ]);
    const bounded = await grepRecursive(root, { pattern: "alpha", maxResults: 2 });
    expect(bounded).toHaveLength(2);
  });

  it("searches a single file root and reports paths relative to cwd", async () => {
    const root = await fixtureTree();
    const matches = await grepRecursive(join(root, "src", "a.ts"), {
      pattern: "beta",
      maxResults: 10,
      cwd: root,
    });
    expect(matches).toEqual([{ path: "src/a.ts", line: 2, column: 1, content: "beta alpha" }]);
  });
});

describe("rg-fallback listFiles", () => {
  it("lists non-ignored files and filters with a glob", async () => {
    const root = await fixtureTree();
    const files = await listFiles(root, { maxResults: 100 });
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/deep/b.ts");
    expect(files).toContain("keep.log");
    expect(files).not.toContain("src/debug.log");
    expect(files).not.toContain("build/out.ts");
    const tsFiles = await listFiles(root, { glob: "**/*.ts", maxResults: 100 });
    expect(tsFiles).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  it("supports basename globs and caps results", async () => {
    const root = await fixtureTree();
    const logs = await listFiles(root, { glob: "*.log", maxResults: 100 });
    expect(logs).toEqual(["keep.log"]);
    const one = await listFiles(root, { maxResults: 1 });
    expect(one).toHaveLength(1);
  });
});

describe("globToRegExp", () => {
  it("matches *, ? and ** semantics", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("deep/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("deep/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("src/?est.ts").test("src/test.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/deep/b.ts")).toBe(true);
  });
});

describe("grep/find backend fallback in the tool registry", () => {
  afterEach(() => setRgAvailabilityOverride(undefined));

  it("uses the fallback backend with matching output format when rg is unavailable", async () => {
    const root = await fixtureTree();
    const registry = await createCodingToolRegistry(root);
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = registry.get(name);
      if (!tool) throw new Error(`missing ${name}`);
      return tool.execute(args, { cwd: root });
    };
    setRgAvailabilityOverride(false);
    const grep = await run("grep", { pattern: "alpha", path: "src" });
    expect(grep.metadata).toMatchObject({ backend: "fallback" });
    expect(grep.content).toContain("src/a.ts:1:1:alpha");
    expect(grep.content).toContain("src/deep/b.ts:2:1:alpha deep");
    expect(grep.content).not.toContain("debug.log");
    const find = await run("find", { glob: "**/*.ts" });
    expect(find.metadata).toMatchObject({ backend: "fallback" });
    expect(find.content).toContain("src/a.ts");
    expect(find.content).not.toContain("build/out.ts");
  });

  it("uses the rg backend when rg is available", async () => {
    const root = await fixtureTree();
    const registry = await createCodingToolRegistry(root);
    setRgAvailabilityOverride(true);
    const tool = registry.get("grep");
    const result = await tool!.execute({ pattern: "alpha", path: "src" }, { cwd: root });
    expect(result.metadata).toMatchObject({ backend: "rg" });
    expect(result.content).toContain("src/a.ts:1:1:alpha");
  });
});
