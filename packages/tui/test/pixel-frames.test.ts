import { describe, expect, it } from "vitest";
import {
  composeFrame,
  MASCOT_FRAME_LIMITS,
  MASCOT_MOODS,
  PIXEL_FOXY_FRAMES,
  PIXEL_MASCOT_FRAMES,
  tailsForLevel,
  TUI_MASCOTS,
  validateTuiMascot,
} from "../src/index.js";

const wrapAsMascot = (id: string, frames: (typeof PIXEL_MASCOT_FRAMES)[string]) =>
  validateTuiMascot({ id, name: id, species: "pixel", catchphrase: "pixel!", frames });

describe("pixel frames", () => {
  it("covers every built-in mascot with a valid pixel frame set", () => {
    for (const mascot of TUI_MASCOTS) {
      expect(PIXEL_MASCOT_FRAMES[mascot.id], mascot.id).toBeDefined();
      expect(() => wrapAsMascot(mascot.id, PIXEL_MASCOT_FRAMES[mascot.id]!)).not.toThrow();
    }
  });

  it("gives pixel foxy all eight moods with animated frames", () => {
    for (const mood of MASCOT_MOODS) {
      const frames = PIXEL_FOXY_FRAMES[mood];
      expect(frames?.length, mood).toBeGreaterThanOrEqual(1);
    }
    expect(PIXEL_FOXY_FRAMES.idle?.length).toBeGreaterThanOrEqual(2);
    expect(() => wrapAsMascot("pixel-foxy", PIXEL_FOXY_FRAMES)).not.toThrow();
  });

  it("keeps composed frames within the relaxed mascot limits", () => {
    const base = PIXEL_FOXY_FRAMES.idle?.[0] ?? [];
    for (const level of [1, 5, 9]) {
      const frame = composeFrame(base, level, "foxy");
      expect(frame.length).toBeLessThanOrEqual(MASCOT_FRAME_LIMITS.linesPerFrame);
      expect(frame.length).toBe(base.length + 1);
      for (const line of frame) {
        expect([...line].length).toBeLessThanOrEqual(MASCOT_FRAME_LIMITS.codePointsPerLine);
      }
    }
  });

  it("never overflows the line limit even for tall base frames", () => {
    const tall = Array.from({ length: MASCOT_FRAME_LIMITS.linesPerFrame }, () => "x");
    expect(composeFrame(tall, 9, "foxy")).toHaveLength(MASCOT_FRAME_LIMITS.linesPerFrame);
  });

  it("grows foxy tails with level", () => {
    const count = (level: number) => (tailsForLevel(level, "foxy")[0]?.match(/≋/g) ?? []).length;
    expect(count(1)).toBe(1);
    expect(count(5)).toBe(5);
    expect(count(9)).toBe(9);
    expect(count(1)).toBeLessThan(count(5));
    expect(count(5)).toBeLessThan(count(9));
  });

  it("grows star badges for the other mascots with level", () => {
    for (const id of ["mochi", "byte", "nori", "pico", "bubu", "kumo", "nyx"]) {
      const stars = (level: number) => (tailsForLevel(level, id)[0]?.match(/★/g) ?? []).length;
      expect(stars(1), id).toBe(1);
      expect(stars(5), id).toBe(5);
      expect(stars(9), id).toBe(9);
    }
  });

  it("clamps levels outside 1..9", () => {
    expect(tailsForLevel(0, "foxy")[0]).toBe(tailsForLevel(1, "foxy")[0]);
    expect(tailsForLevel(99, "mochi")[0]).toBe(tailsForLevel(9, "mochi")[0]);
  });
});
