/**
 * Color value accepted by TUI themes. Three representations are supported:
 *
 * - `number` (0–255): 8-bit ANSI color, backward compatible with all
 *   256-color terminals. Existing themes use this form.
 * - `#rrggbb` hex string: 24-bit truecolor. Requires a terminal advertising
 *   the `RGB` capability (or `COLORTERM=truecolor` / `COLORTERM=24bit`).
 * - `[r, g, b]` tuple: 24-bit truecolor, alternative to hex. Each component
 *   is an integer 0–255.
 *
 * Mixing representations within a single theme is allowed — callers always
 * go through `fg()` / `bg()` which emit the correct escape per value.
 */
export type ColorValue = number | `#${string}` | readonly [number, number, number];

export interface TuiTheme {
  id: string;
  name: string;
  background: ColorValue;
  foreground: ColorValue;
  accent: ColorValue;
  secondary: ColorValue;
  success: ColorValue;
  warning: ColorValue;
  danger: ColorValue;
  muted: ColorValue;
  border: string;
}

export const DEFAULT_THEME_ID = "fox";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Built-in themes. The original seven use 8-bit ANSI colors so they render
 * identically on 256-color terminals. The truecolor themes (Aurora Glow,
 * Crimson Tide) use hex strings for finer gradient control; terminals
 * without truecolor support still receive a valid SGR sequence, though the
 * exact shade may be approximated by the terminal's own downscaler.
 */
export const TUI_THEMES: readonly TuiTheme[] = [
  {
    id: "fox",
    name: "Fox Fire",
    background: 233,
    foreground: 230,
    accent: 208,
    secondary: 221,
    success: 149,
    warning: 214,
    danger: 203,
    muted: 237,
    border: "─",
  },
  {
    id: "foxglow",
    name: "Fox Glow",
    background: 233,
    foreground: 230,
    accent: 208,
    secondary: 215,
    success: 114,
    warning: 221,
    danger: 203,
    muted: 241,
    border: "─",
  },
  {
    id: "aurora",
    name: "Aurora",
    background: 234,
    foreground: 255,
    accent: 81,
    secondary: 141,
    success: 84,
    warning: 221,
    danger: 203,
    muted: 245,
    border: "─",
  },
  {
    id: "candy",
    name: "Candy Pop",
    background: 235,
    foreground: 231,
    accent: 213,
    secondary: 117,
    success: 120,
    warning: 228,
    danger: 210,
    muted: 248,
    border: "·",
  },
  {
    id: "forest",
    name: "Tiny Forest",
    background: 233,
    foreground: 230,
    accent: 114,
    secondary: 180,
    success: 82,
    warning: 220,
    danger: 167,
    muted: 243,
    border: "━",
  },
  {
    id: "midnight",
    name: "Midnight Byte",
    background: 232,
    foreground: 252,
    accent: 75,
    secondary: 99,
    success: 48,
    warning: 214,
    danger: 197,
    muted: 240,
    border: "─",
  },
  {
    id: "mono",
    name: "Paper Terminal",
    background: 0,
    foreground: 15,
    accent: 15,
    secondary: 7,
    success: 15,
    warning: 15,
    danger: 15,
    muted: 8,
    border: "-",
  },
  // === Truecolor themes (24-bit RGB) ===
  {
    id: "aurora-glow",
    name: "Aurora Glow TC",
    background: "#0b1020",
    foreground: "#e5e9f0",
    accent: "#7aa2f7",
    secondary: "#bb9af7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    muted: "#414868",
    border: "─",
  },
  {
    id: "crimson-tide",
    name: "Crimson Tide TC",
    background: "#1a0a0f",
    foreground: "#f5e0e6",
    accent: "#ff5c8a",
    secondary: "#ffb86c",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff5555",
    muted: "#5a2a3a",
    border: "━",
  },
  // === Refined truecolor palettes ===
  // Authentic community palettes tuned for extended coding sessions: softer
  // accents, lower-contrast backgrounds, and careful semantic coloring.
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    background: "#1a1b26",
    foreground: "#c0caf5",
    accent: "#7aa2f7",
    secondary: "#bb9af7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    muted: "#414868",
    border: "─",
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    accent: "#cba6f7",
    secondary: "#89b4fa",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    muted: "#45475a",
    border: "─",
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    background: "#191724",
    foreground: "#e0def4",
    accent: "#ebbcba",
    secondary: "#31748f",
    success: "#31748f",
    warning: "#f6c177",
    danger: "#eb6f92",
    muted: "#403d52",
    border: "─",
  },
  {
    id: "gruvbox-material",
    name: "Gruvbox Material",
    background: "#282828",
    foreground: "#ebdbb2",
    accent: "#fabd2f",
    secondary: "#83a598",
    success: "#b8bb26",
    warning: "#fe8019",
    danger: "#fb4934",
    muted: "#504945",
    border: "─",
  },
] as const;

export function getTheme(value: string | TuiTheme = "foxglow"): TuiTheme {
  if (typeof value !== "string") return validateTuiTheme(value);
  const theme = TUI_THEMES.find((item) => item.id === value);
  if (!theme) throw new Error("Unknown TUI theme: " + value);
  return theme;
}

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

export function validateTuiTheme(value: unknown): TuiTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TUI theme must be an object");
  }
  const theme = value as Record<string, unknown>;
  for (const field of ["id", "name", "border"] as const) {
    if (
      typeof theme[field] !== "string" ||
      !theme[field] ||
      /[\u0000-\u001f\u007f\u001b]/.test(theme[field])
    ) {
      throw new Error(`Invalid TUI theme ${field}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(theme.id))) {
    throw new Error("Invalid TUI theme id");
  }
  if ([...String(theme.border)].length !== 1) throw new Error("Theme border must be one character");
  for (const field of THEME_COLOR_FIELDS) {
    if (!isValidColorValue(theme[field])) {
      throw new Error(
        `TUI theme ${field} must be an ANSI color (0-255), #rrggbb hex, or [r,g,b] tuple`,
      );
    }
  }
  return structuredClone(value) as TuiTheme;
}

/** Runtime guard for the `ColorValue` union. */
export function isValidColorValue(value: unknown): value is ColorValue {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 255;
  }
  if (typeof value === "string") {
    return HEX_PATTERN.test(value);
  }
  if (Array.isArray(value) && value.length === 3) {
    return value.every((c) => typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 255);
  }
  return false;
}

/** Convert any ColorValue to the [r,g,b] triple it represents in truecolor space. */
export function colorToRgb(color: ColorValue): [number, number, number] {
  if (typeof color === "number") {
    return ansi256ToRgb(color);
  }
  if (typeof color === "string") {
    return [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
    ];
  }
  return [color[0], color[1], color[2]];
}

/**
 * Approximate an 8-bit ANSI code as an [r,g,b] triple. Uses the standard
 * xterm 256-color palette mapping so the result matches what most terminals
 * render for the same code. Used for truecolor fallback rendering only —
 * themes that store `number` values still emit 8-bit escapes through `fg`/`bg`.
 */
function ansi256ToRgb(code: number): [number, number, number] {
  // 16 standard colors — leave as-is; terminals own these slots. We return
  // a neutral gray so any truecolor fallback is visible but unobtrusive.
  if (code < 16) return [128, 128, 128];
  // Grayscale ramp (232-255): 8-238 in steps of 10
  if (code >= 232) {
    const v = 8 + (code - 232) * 10;
    return [v, v, v];
  }
  // 6x6x6 color cube (16-231)
  const index = code - 16;
  const r = Math.floor(index / 36) % 6;
  const g = Math.floor(index / 6) % 6;
  const b = index % 6;
  const scale = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return [scale(r), scale(g), scale(b)];
}

/** Apply foreground color to text, emitting the appropriate ANSI escape. */
export function fg(color: ColorValue, text: string): string {
  if (typeof color === "number") {
    return "\u001b[38;5;" + color + "m" + text + "\u001b[39m";
  }
  const [r, g, b] = colorToRgb(color);
  return "\u001b[38;2;" + r + ";" + g + ";" + b + "m" + text + "\u001b[39m";
}

/** Apply background color to text, emitting the appropriate ANSI escape. */
export function bg(color: ColorValue, text: string): string {
  if (typeof color === "number") {
    return "\u001b[48;5;" + color + "m" + text + "\u001b[49m";
  }
  const [r, g, b] = colorToRgb(color);
  return "\u001b[48;2;" + r + ";" + g + ";" + b + "m" + text + "\u001b[49m";
}

/**
 * Dim a color by blending it toward black, reducing perceived luminance.
 * Always emits a truecolor escape so the dimming effect is consistent across
 * both 8-bit and truecolor source values. The blend factor is 0.55, keeping
 * roughly half the original intensity — enough to read as "secondary" text
 * without dropping below the terminal's contrast floor.
 */
export function dim(color: ColorValue, text: string): string {
  const [r, g, b] = colorToRgb(color);
  const dr = Math.round(r * 0.55);
  const dg = Math.round(g * 0.55);
  const db = Math.round(b * 0.55);
  return "\u001b[38;2;" + dr + ";" + dg + ";" + db + "m" + text + "\u001b[39m";
}

/** Wrap text in ANSI bold (SGR 1). */
export function bold(text: string): string {
  return "\u001b[1m" + text + "\u001b[22m";
}

/** Wrap text in ANSI italic (SGR 3). */
export function italic(text: string): string {
  return "\u001b[3m" + text + "\u001b[23m";
}

/** Wrap text in ANSI underline (SGR 4). */
export function underline(text: string): string {
  return "\u001b[4m" + text + "\u001b[24m";
}

/** Wrap text in ANSI faint/dim attribute (SGR 2) for terminal-native dimming. */
export function faint(text: string): string {
  return "\u001b[2m" + text + "\u001b[22m";
}
