import { MASCOT_FRAME_LIMITS, type TuiMascot } from "./mascots.js";

export type PixelFrameSet = TuiMascot["frames"];

/** Pixel-game style frames for Foxy, drawn with block characters. */
export const PIXEL_FOXY_FRAMES: PixelFrameSet = {
  idle: [
    [" ▄█▀   ▀█▄ ", " ██▄   ▄██ ", " █ ◆   ◆ █ ", " █▄  ▽  ▄█ ", "  ▀▀▄▄▄▀▀  "],
    [" ▄█▀   ▀█▄ ", " ██▄   ▄██ ", " █ ▬   ▬ █ ", " █▄  ▽  ▄█ ", "  ▀▀▄▄▄▀▀  "],
  ],
  thinking: [
    [" ▄█▀   ▀█▄ ▄▀", " ██▄   ▄██ ▀ ", " █ •   • █  ", " █▄  ~  ▄█  ", "  ▀▀▄▄▄▀▀   "],
    [" ▄█▀   ▀█▄  ▄", " ██▄   ▄██  ▀", " █ •   • █  ", " █▄  ~  ▄█  ", "  ▀▀▄▄▄▀▀   "],
  ],
  working: [
    [" ▄█▀   ▀█▄ ", " ██▄   ▄██ ", " █ ▶   ◀ █ ", " █▄  ▽  ▄█ ", "  ▀▀▄▄▄▀▀  ", " ░▒▓▄▄▄▄▄▓▒░ "],
    [" ▄█▀   ▀█▄ ", " ██▄   ▄██ ", " █ ▶   ◀ █ ", " █▄  ▽  ▄█ ", "  ▀▀▄▄▄▀▀  ", " ░▒▓▀▀▀▀▀▓▒░ "],
  ],
  happy: [
    ["✦ ▄█▀   ▀█▄ ✦", "  ██▄   ▄██  ", "  █ ▲   ▲ █  ", "  █▄  ▽  ▄█ ★", "   ▀▀▄▄▄▀▀   "],
    ["★ ▄█▀   ▀█▄ ★", "  ██▄   ▄██  ", "  █ ▲   ▲ █  ", "  █▄  ▽  ▄█ ✦", "   ▀▀▄▄▄▀▀   "],
  ],
  oops: [
    [" ▄█▀   ▀█▄ !", " ██▄   ▄██  ", " █ ✕   ✕ █  ", " █▄  △  ▄█  ", "  ▀▀▄▄▄▀▀   "],
    [" ▄█▀   ▀█▄ ‼", " ██▄   ▄██  ", " █ ✕   ✕ █  ", " █▄  △  ▄█  ", "  ▀▀▄▄▄▀▀   "],
  ],
  sleeping: [
    [" ▄█▀   ▀█▄ z", " ██▄   ▄██ Z", " █ ▬   ▬ █  ", " █▄  ▽  ▄█  ", "  ▀▀▄▄▄▀▀   "],
    [" ▄█▀   ▀█▄  ", " ██▄   ▄██ z", " █ ▬   ▬ █ Z", " █▄  ▽  ▄█  ", "  ▀▀▄▄▄▀▀   "],
  ],
  celebrating: [
    ["★ ▄█▀   ▀█▄ ★", "♪ ██▄   ▄██ ♪", "  █ ▲   ▲ █  ", "  █▄  ▽  ▄█  ", "   ▀▀▄▄▄▀▀   "],
    ["✦ ▄█▀   ▀█▄ ✦", "♪ ██▄   ▄██ ♪", "  █ ▲   ▲ █  ", "  █▄  ▽  ▄█  ", "   ▀▀▄▄▄▀▀  ★"],
  ],
  levelup: [
    [
      "    ▀▄▀▄▀    ",
      " ▄█▀   ▀█▄ ▲",
      " ██▄   ▄██  ",
      " █ ◆   ◆ █  ",
      " █▄  ▽  ▄█  ",
      "  ▀▀▄▄▄▀▀   ",
    ],
    [
      "  ✦ ▀▄▀▄▀ ✦  ",
      " ▄█▀   ▀█▄ ▲",
      " ██▄   ▄██  ",
      " █ ◆   ◆ █  ",
      " █▄  ▽  ▄█  ",
      "  ▀▀▄▄▄▀▀   ",
    ],
  ],
};

const PIXEL_MOCHI_FRAMES: PixelFrameSet = {
  idle: [
    [" ▄▄▄▄▄▄▄ ", "█ ◕  ‿  ◕ █", " ▀▄▄♥▄▄▀ "],
    [" ▄▄▄▄▄▄▄ ", "█ ▬  ‿  ▬ █", " ▀▄▄♥▄▄▀ "],
  ],
  thinking: [[" ▄▄▄▄▄▄▄ ?", "█ •  ‿  • █", " ▀▄▄▄▄▄▀ "]],
  working: [[" ▄▄▄▄▄▄▄ ", "█ ▶  ‿  ◀ █", " ▀▄▄▄▄▄▀ ", " ░▒▓▄▄▄▓▒░ "]],
  happy: [["✦ ▄▄▄▄▄▄▄ ✦", "█ ▲  ‿  ▲ █", " ▀▄▄♥▄▄▀ "]],
  oops: [[" ▄▄▄▄▄▄▄ !", "█ ✕  ︿  ✕ █", " ▀▄▄▄▄▄▀ "]],
  sleeping: [[" ▄▄▄▄▄▄▄ zZ", "█ ▬  ‿  ▬ █", " ▀▄▄▄▄▄▀ "]],
  celebrating: [["★ ▄▄▄▄▄▄▄ ★", "█ ▲  ‿  ▲ █", "♪ ▀▄▄♥▄▄▀ ♪"]],
  levelup: [["  ▀▄▀▄▀  ", " ▄▄▄▄▄▄▄ ▲", "█ ◆  ‿  ◆ █", " ▀▄▄♥▄▄▀ "]],
};

const PIXEL_BYTE_FRAMES: PixelFrameSet = {
  idle: [
    [" ▓▄▀▄▀▄▓ ", "▓█ ◇   ◇ █▓", " ▓▀▄▄▄▀▓ "],
    [" ▓▄▀▄▀▄▓ ", "▓█ ▬   ▬ █▓", " ▓▀▄▄▄▀▓ "],
  ],
  thinking: [[" ▓▄▀▄▀▄▓ ?", "▓█ •   • █▓", " ▓▀▄▄▄▀▓ "]],
  working: [[" ▓▄▀▄▀▄▓ ", "▓█ ▶   ◀ █▓", " ▓▀▄▄▄▀▓ ", " ░▒▓▄▄▄▓▒░ "]],
  happy: [["✦ ▓▄▀▄▀▄▓ ✦", "▓█ ▲   ▲ █▓", " ▓▀▄▄▄▀▓ "]],
  oops: [[" ▓▄▀▄▀▄▓ !", "▓█ ✕   ✕ █▓", " ▓▀▄▄▄▀▓ "]],
  sleeping: [[" ▓▄▀▄▀▄▓ zZ", "▓█ ▬   ▬ █▓", " ▓▀▄▄▄▀▓ "]],
  celebrating: [["★ ▓▄▀▄▀▄▓ ★", "▓█ ▲   ▲ █▓", "♪ ▓▀▄▄▄▀▓ ♪"]],
  levelup: [["  ▀▄▀▄▀  ", " ▓▄▀▄▀▄▓ ▲", "▓█ ◆   ◆ █▓", " ▓▀▄▄▄▀▓ "]],
};

const PIXEL_NORI_FRAMES: PixelFrameSet = {
  idle: [
    [" ░▄▀▄▀▄░ ", "░█ ◕ ᴗ ◕ █░", " ░▀▄▄▄▀░ "],
    [" ░▄▀▄▀▄░ ", "░█ ▬ ᴗ ▬ █░", " ░▀▄▄▄▀░ "],
  ],
  thinking: [[" ░▄▀▄▀▄░ ?", "░█ • ᴗ • █░", " ░▀▄▄▄▀░ "]],
  working: [[" ░▄▀▄▀▄░ ", "░█ ▶ ᴗ ◀ █░", " ░▀▄▄▄▀░ ", " ░▒▓▄▄▄▓▒░ "]],
  happy: [["✦ ░▄▀▄▀▄░ ✦", "░█ ▲ ᴗ ▲ █░", " ░▀▄▄▄▀░ "]],
  oops: [[" ░▄▀▄▀▄░ !", "░█ ✕ ﹏ ✕ █░", " ░▀▄▄▄▀░ "]],
  sleeping: [[" ░▄▀▄▀▄░ zZ", "░█ ▬ ᴗ ▬ █░", " ░▀▄▄▄▀░ "]],
  celebrating: [["★ ░▄▀▄▀▄░ ★", "░█ ▲ ᴗ ▲ █░", "♪ ░▀▄▄▄▀░ ♪"]],
  levelup: [["  ▀▄▀▄▀  ", " ░▄▀▄▀▄░ ▲", "░█ ◆ ᴗ ◆ █░", " ░▀▄▄▄▀░ "]],
};

const PIXEL_PICO_FRAMES: PixelFrameSet = {
  idle: [
    ["  ▄▄▄▄▄  ", " ◆█ ◕ө◕ █◆ ", "  ▀▄▄▄▄▀  "],
    ["  ▄▄▄▄▄  ", " ◆█ ▬ө▬ █◆ ", "  ▀▄▄▄▄▀  "],
  ],
  thinking: [["  ▄▄▄▄▄  ?", " ◆█ •ө• █◆ ", "  ▀▄▄▄▄▀  "]],
  working: [["  ▄▄▄▄▄  ", " ◆█ ▶ө◀ █◆ ", "  ▀▄▄▄▄▀  ", " ░▒▓▄▄▄▓▒░ "]],
  happy: [["✦  ▄▄▄▄▄  ✦", " ◆█ ▲ө▲ █◆ ", "  ▀▄▄▄▄▀  "]],
  oops: [["  ▄▄▄▄▄  !", " ◆█ ✕ө✕ █◆ ", "  ▀▄▄▄▄▀  "]],
  sleeping: [["  ▄▄▄▄▄  zZ", " ◆█ ▬ө▬ █◆ ", "  ▀▄▄▄▄▀  "]],
  celebrating: [["★  ▄▄▄▄▄  ★", " ◆█ ▲ө▲ █◆ ", "♪  ▀▄▄▄▄▀  ♪"]],
  levelup: [["   ▀▄▀▄▀   ", "  ▄▄▄▄▄  ▲", " ◆█ ◆ө◆ █◆ ", "  ▀▄▄▄▄▀  "]],
};

const PIXEL_BUBU_FRAMES: PixelFrameSet = {
  idle: [
    [" ▄ ▄▄▄▄ ▄ ", " █ ◕ᴥ◕ █ ", " ▀▄♥▄▀ "],
    [" ▄ ▄▄▄▄ ▄ ", " █ ▬ᴥ▬ █ ", " ▀▄♥▄▀ "],
  ],
  thinking: [[" ▄ ▄▄▄▄ ▄ ?", " █ •ᴥ• █ ", " ▀▄▄▄▀ "]],
  working: [[" ▄ ▄▄▄▄ ▄ ", " █ ▶ᴥ◀ █ ", " ▀▄▄▄▀ ", " ░▒▓▄▄▄▓▒░ "]],
  happy: [["✦ ▄ ▄▄▄▄ ▄ ✦", " █ ▲ᴥ▲ █ ", " ▀▄♥▄▀ "]],
  oops: [[" ▄ ▄▄▄▄ ▄ !", " █ ✕ᴥ✕ █ ", " ▀▄▄▄▀ "]],
  sleeping: [[" ▄ ▄▄▄▄ ▄ zZ", " █ ▬ᴥ▬ █ ", " ▀▄▄▄▀ "]],
  celebrating: [["★ ▄ ▄▄▄▄ ▄ ★", " █ ▲ᴥ▲ █ ", "♪ ▀▄♥▄▀ ♪"]],
  levelup: [["  ▀▄▀▄▀  ", " ▄ ▄▄▄▄ ▄ ▲", " █ ◆ᴥ◆ █ ", " ▀▄♥▄▀ "]],
};

const PIXEL_KUMO_FRAMES: PixelFrameSet = {
  idle: [
    [" ▒▄▄▄▄▄▄▒ ", "▒█ ◕ㅅ◕ █▒", " ▒▀▄▄▄▀▒ "],
    [" ▒▄▄▄▄▄▄▒ ", "▒█ ▬ㅅ▬ █▒", " ▒▀▄▄▄▀▒ "],
  ],
  thinking: [[" ▒▄▄▄▄▄▄▒ ?", "▒█ •ㅅ• █▒", " ▒▀▄▄▄▀▒ "]],
  working: [[" ▒▄▄▄▄▄▄▒ ", "▒█ ▶ㅅ◀ █▒", " ▒▀▄▄▄▀▒ ", " ░▒▓▄▄▄▓▒░ "]],
  happy: [["✦ ▒▄▄▄▄▄▄▒ ✦", "▒█ ▲ㅅ▲ █▒", " ▒▀▄▄▄▀▒ "]],
  oops: [[" ▒▄▄▄▄▄▄▒ !", "▒█ ✕ㅅ✕ █▒", " ▒▀▄▄▄▀▒ "]],
  sleeping: [[" ▒▄▄▄▄▄▄▒ zZ", "▒█ ▬ㅅ▬ █▒", " ▒▀▄▄▄▀▒ "]],
  celebrating: [["★ ▒▄▄▄▄▄▄▒ ★", "▒█ ▲ㅅ▲ █▒", "♪ ▒▀▄▄▄▀▒ ♪"]],
  levelup: [["  ▀▄▀▄▀  ", " ▒▄▄▄▄▄▄▒ ▲", "▒█ ◆ㅅ◆ █▒", " ▒▀▄▄▄▀▒ "]],
};

const PIXEL_NYX_FRAMES: PixelFrameSet = {
  idle: [
    [" ▄█▲   ▲█▄ ", " ██▓   ▓██◞", " █ ◕   ◕ █ ", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  "],
    [" ▄█▲   ▲█▄ ", " ██▓   ▓██◞", " █ ▬   ▬ █ ", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  "],
  ],
  thinking: [[" ▄█▲   ▲█▄ ▄▀", " ██▓   ▓██◞ ", " █ •   • █  ", " █▓  ~  ▓█◞ ", "  ▀▀▀▀▀▀▀   "]],
  working: [
    [" ▄█▲   ▲█▄ ", " ██▓   ▓██◞", " █ ▶   ◀ █ ", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  ", " ░▒▓▄▄▄▄▄▓▒░ "],
    [" ▄█▲   ▲█▄ ", " ██▓   ▓██◞", " █ ▶   ◀ █ ", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  ", " ░▒▓▀▀▀▀▀▓▒░ "],
  ],
  happy: [["✦ ▄█▲   ▲█▄ ✦", "  ██▓   ▓██◞ ", "  █ ◕ω◕ █  ★", "  █▓  ⏣  ▓█◞", "   ▀▀▀▀▀▀▀   "]],
  oops: [[" ▄█▲   ▲█▄ !", " ██▓   ▓██◞", " █ ✕   ✕ █ ", " █▓  △  ▓█◞", "  ▀▀▀▀▀▀▀  "]],
  sleeping: [
    [" ▄█▲   ▲█▄ z", " ██▓   ▓██◞", " █ ▬   ▬ █Z", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  "],
    [" ▄█▲   ▲█▄  ", " ██▓   ▓██◞", " █ ▬   ▬ █ z", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  Z"],
  ],
  celebrating: [
    ["★ ▄█▲   ▲█▄ ★", "♪ ██▓   ▓██◞ ", "  █ ◕ω◕ █  ♪", "  █▓  ⏣  ▓█◞", "   ▀▀▀▀▀▀▀  ★"],
    ["✦ ▄█▲   ▲█▄ ✦", "♪ ██▓   ▓██◞ ", "  █ ◕ω◕ █  ♪", "  █▓  ⏣  ▓█◞", "   ▀▀▀▀▀▀▀  ✦"],
  ],
  levelup: [
    ["    ▀▄▀▄▀    ", " ▄█▲   ▲█▄ ▲", " ██▓   ▓██◞ ", " █ ◆   ◆ █ ", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  "],
    ["  ✦ ▀▄▀▄▀ ✦  ", " ▄█▲   ▲█▄ ▲", " ██▓   ▓██◞ ", " █ ◆   ◆ █ ", " █▓  ⏣  ▓█◞", "  ▀▀▀▀▀▀▀  "],
  ],
};

/** Pixel-game style frames for every built-in mascot, keyed by mascot id. */
export const PIXEL_MASCOT_FRAMES: Record<string, PixelFrameSet> = {
  foxy: PIXEL_FOXY_FRAMES,
  mochi: PIXEL_MOCHI_FRAMES,
  byte: PIXEL_BYTE_FRAMES,
  nori: PIXEL_NORI_FRAMES,
  pico: PIXEL_PICO_FRAMES,
  bubu: PIXEL_BUBU_FRAMES,
  kumo: PIXEL_KUMO_FRAMES,
  nyx: PIXEL_NYX_FRAMES,
};

const clampLevel = (level: number): number =>
  Math.min(9, Math.max(1, Number.isFinite(level) ? Math.floor(level) : 1));

/**
 * Level decoration lines for a mascot: Foxy grows one tail per level (≋),
 * every other mascot earns one star badge per level (★).
 */
export function tailsForLevel(level: number, mascotId: string = "foxy"): string[] {
  const clamped = clampLevel(level);
  if (mascotId === "foxy") return [" " + "≋".repeat(clamped)];
  return [" " + Array.from({ length: clamped }, () => "★").join(" ")];
}

/**
 * Append level decoration lines to a base frame, staying within the relaxed
 * mascot frame limits (10 lines, 40 code points per line).
 */
export function composeFrame(
  base: readonly string[],
  level: number,
  mascotId: string = "foxy",
): string[] {
  const frame = [...base];
  for (const line of tailsForLevel(level, mascotId)) {
    if (frame.length >= MASCOT_FRAME_LIMITS.linesPerFrame) break;
    frame.push(line);
  }
  return frame;
}
