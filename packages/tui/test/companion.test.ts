import { describe, expect, it } from "vitest";
import {
  applyTurnReward,
  COMPANION_MAX_LEVEL,
  COMPANION_VERSION,
  initialCompanion,
  LEVEL_NAMES,
  levelForXp,
  levelName,
  parseCompanion,
  progressToNext,
  serializeCompanion,
  suggestMood,
  XP_LEVELS,
  type CompanionState,
} from "../src/index.js";

describe("companion growth system", () => {
  it("starts at level 1 with zero xp", () => {
    expect(initialCompanion()).toEqual({ xp: 0, level: 1, totalTurns: 0, totalToolSuccesses: 0 });
    expect(XP_LEVELS).toHaveLength(COMPANION_MAX_LEVEL);
    expect(LEVEL_NAMES).toHaveLength(COMPANION_MAX_LEVEL);
    expect(levelName(1)).toBe("幼尾小福");
    expect(levelName(9)).toBe("九尾天福");
  });

  it("accumulates xp per turn and per successful tool call", () => {
    let state = initialCompanion();
    state = applyTurnReward(state, { toolSuccesses: 0 }).state;
    expect(state.xp).toBe(10);
    expect(state.totalTurns).toBe(1);
    state = applyTurnReward(state, { toolSuccesses: 3 }).state;
    expect(state.xp).toBe(10 + 10 + 3 * 2);
    expect(state.totalTurns).toBe(2);
    expect(state.totalToolSuccesses).toBe(3);
  });

  it("reports leveledUp only when crossing a threshold", () => {
    let state: CompanionState = { xp: 40, level: 1, totalTurns: 4, totalToolSuccesses: 0 };
    const crossing = applyTurnReward(state, { toolSuccesses: 0 });
    expect(crossing.state.xp).toBe(50);
    expect(crossing.leveledUp).toBe(true);
    expect(crossing.newLevel).toBe(2);
    expect(crossing.state.level).toBe(2);

    state = crossing.state;
    const steady = applyTurnReward(state, { toolSuccesses: 1 });
    expect(steady.state.xp).toBe(62);
    expect(steady.leveledUp).toBe(false);
    expect(steady.newLevel).toBeUndefined();
    expect(steady.state.level).toBe(2);
  });

  it("can jump multiple levels in a single reward", () => {
    const state: CompanionState = { xp: 0, level: 1, totalTurns: 0, totalToolSuccesses: 0 };
    const result = applyTurnReward(state, { toolSuccesses: 70 });
    expect(result.state.xp).toBe(150);
    expect(result.leveledUp).toBe(true);
    expect(result.newLevel).toBe(3);
  });

  it("maps xp to levels at exact threshold boundaries", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(49)).toBe(1);
    expect(levelForXp(50)).toBe(2);
    expect(levelForXp(149)).toBe(2);
    expect(levelForXp(150)).toBe(3);
    expect(levelForXp(2499)).toBe(8);
    expect(levelForXp(2500)).toBe(9);
    expect(levelForXp(999999)).toBe(9);
  });

  it("tracks progress toward the next level", () => {
    const state: CompanionState = { xp: 75, level: 2, totalTurns: 6, totalToolSuccesses: 0 };
    const progress = progressToNext(state);
    expect(progress.current).toBe(25);
    expect(progress.needed).toBe(100);
    expect(progress.ratio).toBeCloseTo(0.25);
  });

  it("reports complete progress at max level", () => {
    const state: CompanionState = { xp: 3000, level: 9, totalTurns: 100, totalToolSuccesses: 50 };
    expect(progressToNext(state)).toEqual({ current: 0, needed: 0, ratio: 1 });
  });

  it("round-trips through serialization", () => {
    const state: CompanionState = { xp: 320, level: 4, totalTurns: 20, totalToolSuccesses: 12 };
    const parsed = parseCompanion(serializeCompanion(state));
    expect(parsed).toEqual(state);
  });

  it("falls back to the initial state for bad serialized data", () => {
    const initial = initialCompanion();
    expect(parseCompanion("not json {{{")).toEqual(initial);
    expect(parseCompanion(JSON.stringify({ version: "other.v1", xp: 10, level: 1 }))).toEqual(
      initial,
    );
    expect(
      parseCompanion(
        JSON.stringify({
          version: COMPANION_VERSION,
          xp: -5,
          level: 1,
          totalTurns: 0,
          totalToolSuccesses: 0,
        }),
      ),
    ).toEqual(initial);
    expect(
      parseCompanion(
        JSON.stringify({
          version: COMPANION_VERSION,
          xp: 100,
          level: 42,
          totalTurns: 0,
          totalToolSuccesses: 0,
        }),
      ),
    ).toEqual(initial);
    expect(parseCompanion(JSON.stringify([1, 2, 3]))).toEqual(initial);
  });

  it("suggests a mood for each integration event", () => {
    const state = initialCompanion();
    expect(suggestMood(state, "turn_start")).toBe("thinking");
    expect(suggestMood(state, "tool_ok")).toBe("working");
    expect(suggestMood(state, "tool_fail")).toBe("oops");
    expect(suggestMood(state, "turn_done")).toBe("happy");
    expect(suggestMood(state, "levelup")).toBe("levelup");
    expect(suggestMood(state, "idle_long")).toBe("sleeping");
    expect(suggestMood(state, "compacting")).toBe("celebrating");
  });
});
