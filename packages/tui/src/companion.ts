import type { MascotMood } from "./mascots.js";

export const COMPANION_VERSION = "focuscode-companion.v1";
export const COMPANION_MAX_LEVEL = 9;
export const XP_PER_TURN = 10;
export const XP_PER_TOOL_SUCCESS = 2;

/** XP thresholds for levels 1..9 (index 0 is level 1). */
export const XP_LEVELS: readonly number[] = [0, 50, 150, 300, 500, 800, 1200, 1800, 2500];

/** Cute fox-themed names for levels 1..9. */
export const LEVEL_NAMES: readonly string[] = [
  "幼尾小福",
  "学徒狐",
  "机灵狐",
  "猎码狐",
  "灵尾狐",
  "幻尾狐",
  "玄尾狐",
  "天尾狐",
  "九尾天福",
];

export interface CompanionState {
  xp: number;
  level: number;
  totalTurns: number;
  totalToolSuccesses: number;
}

export interface TurnReward {
  toolSuccesses: number;
}

export interface TurnRewardResult {
  state: CompanionState;
  leveledUp: boolean;
  newLevel?: number;
}

export type CompanionEvent =
  "turn_start" | "tool_ok" | "tool_fail" | "turn_done" | "levelup" | "idle_long" | "compacting";

export function initialCompanion(): CompanionState {
  return { xp: 0, level: 1, totalTurns: 0, totalToolSuccesses: 0 };
}

/** Highest level whose XP threshold has been reached. */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let index = 0; index < XP_LEVELS.length; index += 1) {
    if (xp >= (XP_LEVELS[index] ?? 0)) level = index + 1;
  }
  return Math.min(level, COMPANION_MAX_LEVEL);
}

export function levelName(level: number): string {
  const clamped = Math.min(COMPANION_MAX_LEVEL, Math.max(1, Math.floor(level)));
  return LEVEL_NAMES[clamped - 1] ?? LEVEL_NAMES[0] ?? "";
}

/** Apply a completed agent turn: +10 XP plus +2 per successful tool call. */
export function applyTurnReward(state: CompanionState, reward: TurnReward): TurnRewardResult {
  const toolSuccesses = Math.max(0, Math.floor(reward.toolSuccesses));
  const xp = state.xp + XP_PER_TURN + toolSuccesses * XP_PER_TOOL_SUCCESS;
  const newLevel = levelForXp(xp);
  const next: CompanionState = {
    xp,
    level: newLevel,
    totalTurns: state.totalTurns + 1,
    totalToolSuccesses: state.totalToolSuccesses + toolSuccesses,
  };
  const leveledUp = newLevel > state.level;
  const result: TurnRewardResult = { state: next, leveledUp };
  if (leveledUp) result.newLevel = newLevel;
  return result;
}

/** Progress within the current level toward the next one. */
export function progressToNext(state: CompanionState): {
  current: number;
  needed: number;
  ratio: number;
} {
  if (state.level >= COMPANION_MAX_LEVEL) return { current: 0, needed: 0, ratio: 1 };
  const floor = XP_LEVELS[state.level - 1] ?? 0;
  const ceiling = XP_LEVELS[state.level] ?? floor;
  const current = Math.max(0, state.xp - floor);
  const needed = Math.max(1, ceiling - floor);
  return { current, needed, ratio: Math.min(1, current / needed) };
}

export function serializeCompanion(state: CompanionState): string {
  return JSON.stringify({ version: COMPANION_VERSION, ...state });
}

/** Parse serialized companion state; any bad data falls back to the initial state. */
export function parseCompanion(text: string): CompanionState {
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return initialCompanion();
    const record = data as Record<string, unknown>;
    if (record.version !== COMPANION_VERSION) return initialCompanion();
    const { xp, level, totalTurns, totalToolSuccesses } = record;
    if (
      !Number.isInteger(xp) ||
      (xp as number) < 0 ||
      !Number.isInteger(level) ||
      (level as number) < 1 ||
      (level as number) > COMPANION_MAX_LEVEL ||
      !Number.isInteger(totalTurns) ||
      (totalTurns as number) < 0 ||
      !Number.isInteger(totalToolSuccesses) ||
      (totalToolSuccesses as number) < 0
    ) {
      return initialCompanion();
    }
    return {
      xp: xp as number,
      level: level as number,
      totalTurns: totalTurns as number,
      totalToolSuccesses: totalToolSuccesses as number,
    };
  } catch {
    return initialCompanion();
  }
}

/** Map an integration-layer event to a suggested mascot mood. */
export function suggestMood(_state: CompanionState, event: CompanionEvent): MascotMood {
  switch (event) {
    case "turn_start":
      return "thinking";
    case "tool_ok":
      return "working";
    case "tool_fail":
      return "oops";
    case "turn_done":
      return "happy";
    case "levelup":
      return "levelup";
    case "idle_long":
      return "sleeping";
    case "compacting":
      return "celebrating";
  }
}
