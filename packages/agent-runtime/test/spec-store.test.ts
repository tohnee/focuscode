import { describe, expect, it } from "vitest";
import { SpecStoreImpl } from "../src/spec-store.js";
import type { SpecDocument, SpecEngineDeps } from "../src/spec-types.js";

function makeDoc(overrides: Partial<SpecDocument> = {}): SpecDocument {
  return {
    id: "spec_1784767951_a3f2c1",
    createdAt: "2026-07-23T10:25:51Z",
    updatedAt: "2026-07-23T10:26:03Z",
    topic: "add-feature",
    trigger: "explicit",
    originalInput: "add a feature",
    understanding: {
      goal: "Add feature",
      constraints: [],
      acceptanceCriteria: [],
      affectedAreas: [],
      ambiguities: [],
    },
    taskBreakdown: [],
    keyDecisions: [],
    enhancedPrompt: "enhanced",
    initialTodos: [],
    status: "confirmed",
    pipelineTrace: { stages: [], totalMs: 0, hadFallback: false },
    ...overrides,
  };
}

function makeDeps(): {
  deps: SpecEngineDeps;
  files: Map<string, string>;
  dirs: Map<string, string[]>;
} {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const deps: SpecEngineDeps = {
    detectProjectType: () => "typescript-monorepo",
    instructions: [],
    async writeFile(path, content) {
      files.set(path, content);
      const dir = path.split("/").slice(0, -1).join("/");
      if (!dirs.has(dir)) dirs.set(dir, []);
      const existing = dirs.get(dir)!;
      const filename = path.split("/").pop()!;
      if (!existing.includes(filename)) existing.push(filename);
    },
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async listDir(dir) {
      return dirs.get(dir) ?? [];
    },
  };
  return { deps, files, dirs };
}

describe("SpecStoreImpl", () => {
  it("saves spec and returns path", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const path = await store.save(makeDoc());
    expect(path).toContain("docs/specs");
    expect(path).toContain("add-feature");
    expect(path).toContain("2026-07-23");
  });

  it("loads saved spec by ID", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const doc = makeDoc();
    await store.save(doc);
    const loaded = await store.load(doc.id);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(doc.id);
    expect(loaded!.topic).toBe(doc.topic);
  });

  it("returns undefined for non-existent ID", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const loaded = await store.load("spec_nonexistent");
    expect(loaded).toBeUndefined();
  });

  it("lists specs sorted by createdAt desc", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    await store.save(makeDoc({ id: "spec_1", createdAt: "2026-07-23T10:00:00Z", topic: "first" }));
    await store.save(makeDoc({ id: "spec_2", createdAt: "2026-07-23T11:00:00Z", topic: "second" }));
    await store.save(makeDoc({ id: "spec_3", createdAt: "2026-07-23T09:00:00Z", topic: "third" }));
    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list[0]!.id).toBe("spec_2");
    expect(list[1]!.id).toBe("spec_1");
    expect(list[2]!.id).toBe("spec_3");
  });

  it("respects limit parameter", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    await store.save(makeDoc({ id: "spec_1", createdAt: "2026-07-23T10:00:00Z" }));
    await store.save(makeDoc({ id: "spec_2", createdAt: "2026-07-23T11:00:00Z" }));
    const list = await store.list(1);
    expect(list).toHaveLength(1);
  });

  it("updates status", async () => {
    const { deps, files } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const doc = makeDoc({ status: "confirmed" });
    const path = await store.save(doc);
    await store.updateStatus(doc.id, "executing");
    const content = files.get(path)!;
    expect(content).toContain("status: executing");
    const loaded = await store.load(doc.id);
    expect(loaded!.status).toBe("executing");
  });

  it("appends suffix on filename conflict", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const doc = makeDoc({ id: "spec_1", topic: "add-feature", createdAt: "2026-07-23T10:00:00Z" });
    const path1 = await store.save(doc);
    const path2 = await store.save(
      makeDoc({ id: "spec_2", topic: "add-feature", createdAt: "2026-07-23T10:00:00Z" }),
    );
    expect(path1).not.toBe(path2);
    expect(path2).toMatch(/-2\.md$/);
  });

  it("writes frontmatter with metadata", async () => {
    const { deps, files } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const path = await store.save(makeDoc());
    const content = files.get(path)!;
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("id: spec_1784767951_a3f2c1");
    expect(content).toContain("topic: add-feature");
    expect(content).toContain("status: confirmed");
  });

  it("updateStatus preserves spec body content", async () => {
    const { deps, files } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const doc = makeDoc({
      enhancedPrompt: "MY_ENHANCED_PROMPT_BODY",
      taskBreakdown: [
        {
          id: "T1",
          description: "MY_TASK_DESCRIPTION",
          kind: "implement",
          dependsOn: [],
          files: [],
        },
      ],
    });
    const path = await store.save(doc);
    await store.updateStatus(doc.id, "executing");
    const content = files.get(path)!;
    // Body content must survive the status update (not be wiped by deserialize/serialize).
    expect(content).toContain("MY_ENHANCED_PROMPT_BODY");
    expect(content).toContain("MY_TASK_DESCRIPTION");
    expect(content).toContain("## Enhanced Prompt");
    expect(content).toContain("## Task Breakdown");
    // Status must be updated in frontmatter.
    expect(content).toContain("status: executing");
  });

  it("load returns correct updatedAt", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const doc = makeDoc({
      createdAt: "2026-07-23T10:25:51Z",
      updatedAt: "2026-07-23T11:30:00Z",
    });
    await store.save(doc);
    const loaded = await store.load(doc.id);
    expect(loaded).toBeDefined();
    expect(loaded!.updatedAt).toBe("2026-07-23T11:30:00Z");
    expect(loaded!.updatedAt).not.toBe(loaded!.createdAt);
  });

  it("slugifies topic in filename (M12)", async () => {
    const { deps } = makeDeps();
    const store = new SpecStoreImpl("/workspace", "docs/specs", deps);
    const doc = makeDoc({ topic: "My Complex Topic With Spaces!" });
    const path = await store.save(doc);
    expect(path).toMatch(/my-complex-topic-with-spaces/);
    expect(path).not.toContain("My Complex Topic With Spaces!");
    expect(path).not.toContain(" ");
  });
});
