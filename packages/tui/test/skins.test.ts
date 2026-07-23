import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKINS,
  getMascot,
  getTheme,
  listBuiltinSkins,
  MASCOT_MOODS,
  parseSkinPack,
  serializeSkinPack,
  SKIN_SCHEMA_VERSION,
  skinToMascot,
  skinToTheme,
  validateSkinPack,
} from "../src/index.js";

const minimalSkin = {
  schemaVersion: SKIN_SCHEMA_VERSION,
  id: "team-skin",
  name: "Team Skin",
};

describe("skin packs", () => {
  it("accepts a minimal skin pack and clones it", () => {
    const skin = validateSkinPack(minimalSkin);
    expect(skin.id).toBe("team-skin");
    expect(skin.theme).toBeUndefined();
    expect(skin.mascot).toBeUndefined();
    expect(skin).not.toBe(minimalSkin);
  });

  it("accepts a full skin pack with partial theme", () => {
    const skin = validateSkinPack({
      ...minimalSkin,
      author: "Team",
      homepage: "https://example.com/skin",
      pixel: true,
      theme: { accent: 45, border: "·" },
    });
    expect(skin.theme?.accent).toBe(45);
    expect(skin.pixel).toBe(true);
  });

  it("rejects control characters in strings", () => {
    expect(() => validateSkinPack({ ...minimalSkin, name: "bad\u001b[2J" })).toThrow("name");
    expect(() => validateSkinPack({ ...minimalSkin, author: "a\u0007b" })).toThrow("author");
    expect(() => validateSkinPack({ ...minimalSkin, theme: { name: "x\u0001" } })).toThrow(
      "theme.name",
    );
  });

  it("rejects non-https homepages", () => {
    expect(() => validateSkinPack({ ...minimalSkin, homepage: "http://example.com" })).toThrow(
      "https://",
    );
    expect(() => validateSkinPack({ ...minimalSkin, homepage: "javascript:alert(1)" })).toThrow(
      "https://",
    );
  });

  it("rejects wrong schema versions and malformed ids", () => {
    expect(() => validateSkinPack({ ...minimalSkin, schemaVersion: "skin.v2" })).toThrow(
      "schemaVersion",
    );
    expect(() => validateSkinPack({ ...minimalSkin, id: "Bad ID!" })).toThrow("id");
    expect(() => validateSkinPack({ ...minimalSkin, id: "-leading-dash" })).toThrow("id");
  });

  it("rejects unknown fields, bad colors and deep nesting", () => {
    expect(() => validateSkinPack({ ...minimalSkin, sneaky: true })).toThrow("Unknown");
    expect(() => validateSkinPack({ ...minimalSkin, theme: { accent: 999 } })).toThrow(
      "ANSI color",
    );
    expect(() => validateSkinPack({ ...minimalSkin, theme: { wat: 1 } })).toThrow(
      "Unknown skin theme field",
    );
    let deep: unknown = 1;
    for (let index = 0; index < 10; index += 1) deep = [deep];
    expect(() => validateSkinPack({ ...minimalSkin, theme: { border: "─", deep } })).toThrow(
      "nesting depth",
    );
  });

  it("validates every builtin skin", () => {
    expect(BUILTIN_SKINS.length).toBeGreaterThanOrEqual(4);
    for (const skin of BUILTIN_SKINS) {
      expect(validateSkinPack(skin).id).toBe(skin.id);
      expect(skinToTheme(skin).id).toBe(skin.theme?.id);
      const mascot = skinToMascot(skin);
      expect(mascot).toBeDefined();
      for (const mood of MASCOT_MOODS) {
        expect(mascot?.frames[mood]?.length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(listBuiltinSkins().map((skin) => skin.id)).toContain("sakura");
  });

  it("falls back to the default theme fields for missing values", () => {
    const fallback = getTheme("foxglow");
    const theme = skinToTheme(validateSkinPack(minimalSkin));
    expect(theme.id).toBe("team-skin");
    expect(theme.name).toBe("Team Skin");
    expect(theme.accent).toBe(fallback.accent);
    expect(theme.background).toBe(fallback.background);
    expect(theme.border).toBe(fallback.border);
  });

  it("prefers theme fields over skin-level fields when present", () => {
    const skin = validateSkinPack({ ...minimalSkin, theme: { id: "inner", accent: 45 } });
    const theme = skinToTheme(skin);
    expect(theme.id).toBe("inner");
    expect(theme.accent).toBe(45);
    expect(theme.name).toBe("Team Skin");
  });

  it("returns undefined mascot for theme-only skins", () => {
    expect(skinToMascot(validateSkinPack(minimalSkin))).toBeUndefined();
  });

  it("parses skin packs from JSON and reports line info on syntax errors", () => {
    const skin = parseSkinPack(JSON.stringify(minimalSkin));
    expect(skin.id).toBe("team-skin");
    expect(() => parseSkinPack('{\n  "schemaVersion": "focuscode-skin.v1",\n  bad\n}')).toThrow(
      /line \d+, column \d+/,
    );
    expect(() => parseSkinPack("{ totally not json")).toThrow("Invalid skin pack JSON");
  });

  it("round-trips through serialization", () => {
    const original = validateSkinPack({
      ...minimalSkin,
      homepage: "https://example.com/skin",
      theme: { accent: 45 },
      mascot: getMascot("foxy"),
    });
    const restored = parseSkinPack(serializeSkinPack(original));
    expect(restored.id).toBe(original.id);
    expect(restored.theme?.accent).toBe(45);
    expect(restored.mascot?.id).toBe("foxy");
  });
});
