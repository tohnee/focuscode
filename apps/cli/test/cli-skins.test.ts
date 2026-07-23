import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SKINS, serializeSkinPack, type SkinPack } from "@focuscode/tui";
import { runSkinsCommand } from "../src/platform-command.js";

// Capture process.stdout.write into a buffer while `fn` runs. Used so we can
// assert on the human-readable messages each subcommand emits.
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") chunks.push(chunk);
    else chunks.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

// Minimal valid skin pack fixture for import/apply-path tests. Carries a
// partial theme so apply() writes both tui.skin and tui.theme.
function fixtureSkin(id: string, name: string): SkinPack {
  return {
    schemaVersion: "focuscode-skin.v1",
    id,
    name,
    author: "Tester",
    theme: {
      id,
      name,
      background: 0,
      foreground: 15,
      accent: 33,
      secondary: 39,
      success: 46,
      warning: 226,
      danger: 196,
      muted: 8,
      border: "-",
    },
  };
}

describe("runSkinsCommand", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "focuscode-skins-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("list", () => {
    it("prints every built-in skin under a `Built-in skins:` header", async () => {
      const output = await captureStdout(() => runSkinsCommand(["list"]));
      expect(output).toContain("Built-in skins:");
      for (const skin of BUILTIN_SKINS) {
        expect(output).toContain(`${skin.id}\t${skin.name}`);
      }
    });

    it("reports `(none)` for imported skins when the directory is empty", async () => {
      const output = await captureStdout(() => runSkinsCommand(["list"]));
      expect(output).toContain("Imported skins: (none)");
    });

    it("lists an imported skin after one has been imported", async () => {
      const srcPath = join(tempHome, "imported.json");
      await writeFile(srcPath, serializeSkinPack(fixtureSkin("imported", "Imported")), "utf8");
      await runSkinsCommand(["import", srcPath]);
      const output = await captureStdout(() => runSkinsCommand(["list"]));
      expect(output).toContain("Imported skins:");
      expect(output).toContain("imported\tImported\tTester");
    });
  });

  describe("apply", () => {
    it("writes tui.skin, tui.theme and tui.mascot for a built-in skin with all three", async () => {
      const output = await captureStdout(() => runSkinsCommand(["apply", "sakura"]));
      expect(output).toContain("Applied skin sakura");
      const config = JSON.parse(
        await readFile(join(tempHome, ".focuscode", "config.json"), "utf8"),
      ) as Record<string, { skin: string; theme: string; mascot: string }>;
      expect(config.tui?.skin).toBe("sakura");
      expect(config.tui?.theme).toBe("sakura");
      expect(config.tui?.mascot).toBe("sakura-foxy");
    });

    it("throws Skin not found for an unknown id", async () => {
      await expect(runSkinsCommand(["apply", "does-not-exist"])).rejects.toThrow(/Skin not found/);
    });

    it("resolves a skin from a file path (not just an id)", async () => {
      const skin = fixtureSkin("from-path", "From Path");
      const srcPath = join(tempHome, "from-path.json");
      await writeFile(srcPath, serializeSkinPack(skin), "utf8");
      const output = await captureStdout(() => runSkinsCommand(["apply", srcPath]));
      expect(output).toContain("Applied skin from-path");
      const config = JSON.parse(
        await readFile(join(tempHome, ".focuscode", "config.json"), "utf8"),
      ) as Record<string, { skin: string }>;
      expect(config.tui?.skin).toBe("from-path");
    });

    it("preserves existing tui keys when writing skin", async () => {
      // Pre-write a config with an unrelated tui key to confirm apply merges
      // instead of replacing the whole tui object.
      const configPath = join(tempHome, ".focuscode", "config.json");
      await mkdir(join(tempHome, ".focuscode"), { recursive: true });
      await writeFile(configPath, JSON.stringify({ tui: { title: "My Title" } }), "utf8");
      await runSkinsCommand(["apply", "ocean"]);
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(config.tui?.skin).toBe("ocean");
      expect(config.tui?.title).toBe("My Title");
    });
  });

  describe("import", () => {
    it("writes a validated skin pack to ~/.focuscode/skins/<id>.json", async () => {
      const skin = fixtureSkin("imported-skin", "Imported Skin");
      const srcPath = join(tempHome, "source.json");
      await writeFile(srcPath, serializeSkinPack(skin), "utf8");
      const output = await captureStdout(() => runSkinsCommand(["import", srcPath]));
      expect(output).toContain("Imported skin imported-skin ->");
      const installed = JSON.parse(
        await readFile(join(tempHome, ".focuscode", "skins", "imported-skin.json"), "utf8"),
      ) as SkinPack;
      expect(installed.id).toBe("imported-skin");
      expect(installed.schemaVersion).toBe("focuscode-skin.v1");
    });

    it("rejects malformed skin pack JSON", async () => {
      const srcPath = join(tempHome, "bad.json");
      await writeFile(srcPath, "{ not valid json", "utf8");
      await expect(runSkinsCommand(["import", srcPath])).rejects.toThrow(/Invalid skin pack/);
    });

    it("rejects a skin pack missing required fields", async () => {
      const srcPath = join(tempHome, "missing-id.json");
      await writeFile(
        srcPath,
        JSON.stringify({ schemaVersion: "focuscode-skin.v1", name: "No ID" }),
        "utf8",
      );
      await expect(runSkinsCommand(["import", srcPath])).rejects.toThrow(/Invalid skin pack id/);
    });
  });

  describe("export", () => {
    it("writes a built-in skin to the requested path", async () => {
      const outPath = join(tempHome, "exported.json");
      const output = await captureStdout(() => runSkinsCommand(["export", "sakura", outPath]));
      expect(output).toContain("Exported skin sakura ->");
      const exported = JSON.parse(await readFile(outPath, "utf8")) as SkinPack;
      expect(exported.id).toBe("sakura");
      expect(exported.schemaVersion).toBe("focuscode-skin.v1");
    });

    it("exports an imported skin by id", async () => {
      const skin = fixtureSkin("exportable", "Exportable");
      const srcPath = join(tempHome, "source.json");
      await writeFile(srcPath, serializeSkinPack(skin), "utf8");
      await runSkinsCommand(["import", srcPath]);
      const outPath = join(tempHome, "exported.json");
      const output = await captureStdout(() => runSkinsCommand(["export", "exportable", outPath]));
      expect(output).toContain("Exported skin exportable ->");
      const exported = JSON.parse(await readFile(outPath, "utf8")) as SkinPack;
      expect(exported.id).toBe("exportable");
    });

    it("throws Skin not found for an unknown export id", async () => {
      await expect(
        runSkinsCommand(["export", "unknown", join(tempHome, "out.json")]),
      ).rejects.toThrow(/Skin not found/);
    });
  });

  describe("remove", () => {
    it("refuses to remove a built-in skin", async () => {
      await expect(runSkinsCommand(["remove", "sakura"])).rejects.toThrow(
        /Cannot remove built-in skin/,
      );
    });

    it("removes an imported skin by id", async () => {
      const skin = fixtureSkin("removable", "Removable");
      const srcPath = join(tempHome, "source.json");
      await writeFile(srcPath, serializeSkinPack(skin), "utf8");
      await runSkinsCommand(["import", srcPath]);
      const output = await captureStdout(() => runSkinsCommand(["remove", "removable"]));
      expect(output).toContain("Removed skin removable");
    });

    it("reports not installed for an unknown imported id", async () => {
      const output = await captureStdout(() => runSkinsCommand(["remove", "never-imported"]));
      expect(output).toContain("not installed");
    });
  });

  describe("usage", () => {
    it("throws Usage for an unknown action", async () => {
      await expect(runSkinsCommand(["frobnicate"])).rejects.toThrow(/Usage:/);
    });
  });
});
