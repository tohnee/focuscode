import { validateTuiMascot, type TuiMascot } from "./mascots.js";
import { PIXEL_MASCOT_FRAMES } from "./pixel-frames.js";
import { getTheme, isValidColorValue, validateTuiTheme, type TuiTheme } from "./themes.js";

export const SKIN_SCHEMA_VERSION = "focuscode-skin.v1";
export const SKIN_PACK_LIMITS = { maxDepth: 8, maxSerializedLength: 200 * 1024 } as const;

const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u001b]/;
const THEME_COLOR_FIELDS = [
  "background",
  "foreground",
  "accent",
  "secondary",
  "success",
  "warning",
  "danger",
  "muted",
] as const;
const THEME_STRING_FIELDS = ["id", "name", "border"] as const;
const SKIN_TOP_LEVEL_KEYS = [
  "schemaVersion",
  "id",
  "name",
  "author",
  "homepage",
  "theme",
  "mascot",
  "pixel",
] as const;

/** Shareable skin pack: a partial theme plus an optional custom mascot. */
export interface SkinPack {
  schemaVersion: typeof SKIN_SCHEMA_VERSION;
  id: string;
  name: string;
  author?: string;
  homepage?: string;
  theme?: Partial<TuiTheme>;
  mascot?: TuiMascot;
  pixel?: boolean;
}

function assertCleanString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || CONTROL_CHARS.test(value)) {
    throw new Error(`Invalid skin pack ${field}`);
  }
}

function assertDepthAndSize(value: unknown): void {
  if (JSON.stringify(value).length > SKIN_PACK_LIMITS.maxSerializedLength) {
    throw new Error("Skin pack exceeds the 200KB size limit");
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > SKIN_PACK_LIMITS.maxDepth) {
      throw new Error("Skin pack exceeds the maximum nesting depth of 8");
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (node && typeof node === "object") {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };
  walk(value, 1);
}

function validateSkinTheme(value: unknown): Partial<TuiTheme> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Skin pack theme must be an object");
  }
  const theme = value as Record<string, unknown>;
  for (const key of Object.keys(theme)) {
    if (
      ![...THEME_COLOR_FIELDS, ...THEME_STRING_FIELDS].includes(
        key as (typeof THEME_COLOR_FIELDS)[number],
      )
    ) {
      throw new Error(`Unknown skin theme field: ${key}`);
    }
  }
  for (const field of THEME_STRING_FIELDS) {
    if (theme[field] !== undefined) assertCleanString(theme[field], `theme.${field}`);
  }
  if (theme.id !== undefined && !SKIN_ID_PATTERN.test(String(theme.id))) {
    throw new Error("Invalid skin theme id");
  }
  if (theme.border !== undefined && [...String(theme.border)].length !== 1) {
    throw new Error("Skin theme border must be one character");
  }
  for (const field of THEME_COLOR_FIELDS) {
    if (theme[field] !== undefined && !isValidColorValue(theme[field])) {
      throw new Error(
        `Skin theme ${field} must be an ANSI color (0-255), #rrggbb hex, or [r,g,b] tuple`,
      );
    }
  }
  return structuredClone(theme) as Partial<TuiTheme>;
}

/** Strictly validate a skin pack and return a structured clone of it. */
export function validateSkinPack(input: unknown): SkinPack {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Skin pack must be an object");
  }
  assertDepthAndSize(input);
  const skin = input as Record<string, unknown>;
  for (const key of Object.keys(skin)) {
    if (!SKIN_TOP_LEVEL_KEYS.includes(key as (typeof SKIN_TOP_LEVEL_KEYS)[number])) {
      throw new Error(`Unknown skin pack field: ${key}`);
    }
  }
  if (skin.schemaVersion !== SKIN_SCHEMA_VERSION) {
    throw new Error(`Skin pack schemaVersion must be "${SKIN_SCHEMA_VERSION}"`);
  }
  assertCleanString(skin.id, "id");
  if (!SKIN_ID_PATTERN.test(skin.id)) throw new Error("Invalid skin pack id");
  assertCleanString(skin.name, "name");
  if (skin.author !== undefined) assertCleanString(skin.author, "author");
  if (skin.homepage !== undefined) {
    assertCleanString(skin.homepage, "homepage");
    if (!String(skin.homepage).startsWith("https://")) {
      throw new Error("Skin pack homepage must use https://");
    }
  }
  if (skin.pixel !== undefined && typeof skin.pixel !== "boolean") {
    throw new Error("Skin pack pixel must be a boolean");
  }
  const normalized: SkinPack = { schemaVersion: SKIN_SCHEMA_VERSION, id: skin.id, name: skin.name };
  if (skin.author !== undefined) normalized.author = skin.author as string;
  if (skin.homepage !== undefined) normalized.homepage = skin.homepage as string;
  if (skin.pixel !== undefined) normalized.pixel = skin.pixel as boolean;
  if (skin.theme !== undefined) normalized.theme = validateSkinTheme(skin.theme);
  if (skin.mascot !== undefined) normalized.mascot = validateTuiMascot(skin.mascot);
  return normalized;
}

/** Resolve a skin pack to a complete theme, falling back to Fox Glow for gaps. */
export function skinToTheme(skin: SkinPack): TuiTheme {
  const base = getTheme("foxglow");
  const theme = skin.theme ?? {};
  const resolved: Record<string, unknown> = {
    id: theme.id ?? skin.id,
    name: theme.name ?? skin.name,
    border: theme.border ?? base.border,
  };
  for (const field of THEME_COLOR_FIELDS) resolved[field] = theme[field] ?? base[field];
  return validateTuiTheme(resolved);
}

/** Resolve a skin pack to a validated mascot, if it carries one. */
export function skinToMascot(skin: SkinPack): TuiMascot | undefined {
  return skin.mascot ? validateTuiMascot(skin.mascot) : undefined;
}

const pixelMascot = (
  id: string,
  name: string,
  species: string,
  catchphrase: string,
  frames: TuiMascot["frames"],
): TuiMascot => ({ id, name, species, catchphrase, frames });

export const BUILTIN_SKINS: readonly SkinPack[] = [
  {
    schemaVersion: SKIN_SCHEMA_VERSION,
    id: "sakura",
    name: "Sakura 樱花",
    author: "FocusCode",
    homepage: "https://github.com/focuscode/focuscode",
    pixel: true,
    theme: {
      id: "sakura",
      name: "Sakura",
      background: 235,
      foreground: 231,
      accent: 213,
      secondary: 218,
      success: 151,
      warning: 225,
      danger: 204,
      muted: 249,
      border: "─",
    },
    mascot: pixelMascot(
      "sakura-foxy",
      "Sakura Foxy",
      "樱花小福狐",
      "花瓣落下时，代码也开了。",
      PIXEL_MASCOT_FRAMES.foxy!,
    ),
  },
  {
    schemaVersion: SKIN_SCHEMA_VERSION,
    id: "ocean",
    name: "Ocean 海蓝",
    author: "FocusCode",
    homepage: "https://github.com/focuscode/focuscode",
    pixel: true,
    theme: {
      id: "ocean",
      name: "Ocean",
      background: 234,
      foreground: 252,
      accent: 39,
      secondary: 45,
      success: 84,
      warning: 220,
      danger: 203,
      muted: 244,
      border: "─",
    },
    mascot: pixelMascot(
      "ocean-kumo",
      "Ocean Kumo",
      "深海代码水豚",
      "沉住气，海一样深的栈也能读完。",
      PIXEL_MASCOT_FRAMES.kumo!,
    ),
  },
  {
    schemaVersion: SKIN_SCHEMA_VERSION,
    id: "arcade",
    name: "Arcade 街机",
    author: "FocusCode",
    homepage: "https://github.com/focuscode/focuscode",
    pixel: true,
    theme: {
      id: "arcade",
      name: "Arcade",
      background: 232,
      foreground: 255,
      accent: 201,
      secondary: 51,
      success: 46,
      warning: 226,
      danger: 196,
      muted: 240,
      border: "─",
    },
    mascot: pixelMascot(
      "arcade-byte",
      "Arcade Byte",
      "街机像素小狐",
      "投币开始，这一局全绿通关。",
      PIXEL_MASCOT_FRAMES.byte!,
    ),
  },
  {
    schemaVersion: SKIN_SCHEMA_VERSION,
    id: "matcha",
    name: "Matcha 抹茶",
    author: "FocusCode",
    homepage: "https://github.com/focuscode/focuscode",
    pixel: true,
    theme: {
      id: "matcha",
      name: "Matcha",
      background: 233,
      foreground: 230,
      accent: 108,
      secondary: 143,
      success: 78,
      warning: 179,
      danger: 167,
      muted: 242,
      border: "─",
    },
    mascot: pixelMascot(
      "matcha-mochi",
      "Matcha Mochi",
      "抹茶云朵猫",
      "一口抹茶，把 bug 揉成回甘。",
      PIXEL_MASCOT_FRAMES.mochi!,
    ),
  },
  {
    schemaVersion: SKIN_SCHEMA_VERSION,
    id: "nyx",
    name: "Nyx 夜影",
    author: "FocusCode",
    homepage: "https://github.com/focuscode/focuscode",
    pixel: true,
    theme: {
      id: "nyx",
      name: "Midnight Shadow",
      background: "#080818",
      foreground: "#c8d4e8",
      accent: "#5b8cff",
      secondary: "#d98030",
      success: "#88a820",
      warning: "#e8a030",
      danger: "#d04050",
      muted: "#2a3450",
      border: "─",
    },
    mascot: pixelMascot(
      "nyx",
      "Nyx 夜纱",
      "午夜影猫",
      "深夜的代码，有我陪着你。",
      PIXEL_MASCOT_FRAMES.nyx!,
    ),
  },
].map((skin) => validateSkinPack(skin));

export function listBuiltinSkins(): readonly SkinPack[] {
  return BUILTIN_SKINS;
}

/** Parse a skin pack from JSON text; syntax errors report line and column. */
export function parseSkinPack(jsonText: string): SkinPack {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(message);
    if (position) {
      const offset = Number(position[1]);
      const before = jsonText.slice(0, offset);
      const line = before.split("\n").length;
      const column = offset - before.lastIndexOf("\n");
      throw new Error(`Invalid skin pack JSON at line ${line}, column ${column}: ${message}`);
    }
    throw new Error(`Invalid skin pack JSON: ${message}`);
  }
  return validateSkinPack(data);
}

export function serializeSkinPack(skin: SkinPack): string {
  return JSON.stringify(validateSkinPack(skin), null, 2);
}
