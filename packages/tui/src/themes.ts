export interface TuiTheme {
  id: string;
  name: string;
  background: number;
  foreground: number;
  accent: number;
  secondary: number;
  success: number;
  warning: number;
  danger: number;
  muted: number;
  border: string;
}

export const DEFAULT_THEME_ID = "fox";

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
] as const;

export function getTheme(value: string | TuiTheme = "foxglow"): TuiTheme {
  if (typeof value !== "string") return validateTuiTheme(value);
  const theme = TUI_THEMES.find((item) => item.id === value);
  if (!theme) throw new Error("Unknown TUI theme: " + value);
  return theme;
}

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
  for (const field of [
    "background",
    "foreground",
    "accent",
    "secondary",
    "success",
    "warning",
    "danger",
    "muted",
  ] as const) {
    if (!Number.isInteger(theme[field]) || Number(theme[field]) < 0 || Number(theme[field]) > 255) {
      throw new Error(`TUI theme ${field} must be an ANSI color from 0 to 255`);
    }
  }
  return structuredClone(value) as TuiTheme;
}

export function fg(color: number, text: string): string {
  return "\u001b[38;5;" + color + "m" + text + "\u001b[39m";
}

export function bg(color: number, text: string): string {
  return "\u001b[48;5;" + color + "m" + text + "\u001b[49m";
}
