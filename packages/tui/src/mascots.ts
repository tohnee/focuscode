export type MascotMood =
  "idle" | "thinking" | "working" | "happy" | "oops" | "sleeping" | "celebrating" | "levelup";

export const MASCOT_MOODS: readonly MascotMood[] = [
  "idle",
  "thinking",
  "working",
  "happy",
  "oops",
  "sleeping",
  "celebrating",
  "levelup",
];

export const MASCOT_FRAME_LIMITS = {
  framesPerMood: 8,
  linesPerFrame: 10,
  codePointsPerLine: 40,
} as const;

export interface TuiMascot {
  id: string;
  name: string;
  species: string;
  catchphrase: string;
  /** Frames per mood. Moods may be omitted; playback falls back to "idle". */
  frames: Partial<Record<MascotMood, readonly string[][]>>;
}

const frame = (...lines: string[]): string[][] => [lines];
const animated = (first: string[], second: string[]): string[][] => [first, second];

export const TUI_MASCOTS: readonly TuiMascot[] = [
  {
    id: "foxy",
    name: "Foxy 小福",
    species: "Focus 小狐狸",
    catchphrase: "你的编程配备鼓励师，一直在。",
    frames: {
      idle: animated(
        ["  /\\_/\\   ", " ( o.o ) ♡", "  > ^ <  ~"],
        ["  /\\_/\\   ", " ( -.- ) ♡", "  > ^ < ~"],
      ),
      thinking: frame("  /\\_/\\  ?", " ( •.• )", "  > ? <  ~"),
      working: animated(
        ["  /\\_/\\ ⌨ ", " ( >.< )", "  > ^ <  ~"],
        ["  /\\_/\\  ⌨", " ( >.< )", "  > ^ < ~"],
      ),
      happy: animated(
        ["  /\\_/\\  ★", " ( ^ω^ )", "  > ♡ <  ~"],
        ["  /\\_/\\ ✨", " ( ^ω^ )", "  > ♡ < ~"],
      ),
      oops: frame("  /\\_/\\  !", " ( ;ω; )", "  > _ <  ~"),
      sleeping: animated(
        ["  /\\_/\\   ", " ( -.- )zZ", "  > ^ <  ~"],
        ["  /\\_/\\  z", " ( -.- ) Z", "  > ^ < ~"],
      ),
      celebrating: animated(
        ["  /\\_/\\ 🎉", " ( ^ω^ )ﾉ", "  > ★ <  ~"],
        ["  /\\_/\\ ✨", "ﾉ( ^ω^ ) ", "  > ★ < ~"],
      ),
      levelup: animated(
        ["  /\\_/\\ ⬆", " ( ≧▽≦ )", "  > ♡ <  ~"],
        [" ✦/\\_/\\ ✦", " ( ≧▽≦ )", "  > ♡ < ~"],
      ),
    },
  },
  {
    id: "mochi",
    name: "Mochi",
    species: "云朵猫",
    catchphrase: "把 bug 揉成小团子！",
    frames: {
      idle: animated([" /ᐠ｡ꞈ｡ᐟ╲", "  づ♡⊂"], [" /ᐠ˵- ⩊ -˵ᐟ╲", "  づ♡⊂"]),
      thinking: frame(" /ᐠ • ˕ •マ ?", "  づ  づ"),
      working: animated([" /ᐠ≧ꞈ≦ᐟ╲⌨", "  づ づ"], [" /ᐠ≧ꞈ≦ᐟ╲ ⌨", "  づづ"]),
      happy: frame(" /ᐠ>ꞈ<ᐟ╲ ✨", "  づ♡づ"),
      oops: frame(" /ᐠ｡•́︿•̀｡ᐟ╲", "  づ づ"),
      sleeping: animated([" /ᐠ˵- ⩊ -˵ᐟzZ", "  づ⊂"], [" /ᐠ˵- ⩊ -˵ᐟ zZ", "  づ⊂"]),
      celebrating: animated([" /ᐠ>ꞈ<ᐟ╲🎉", "  づ★づ"], ["✨/ᐠ>ꞈ<ᐟ╲", "  づ★づ"]),
      levelup: animated([" /ᐠ≧ꞈ≦ᐟ╲⬆", "  づ♡づ"], [" /ᐠ≧ꞈ≦ᐟ╲✦", "  づ♡づ"]),
    },
  },
  {
    id: "byte",
    name: "Byte",
    species: "像素小狐",
    catchphrase: "尾巴一扫，测试全绿。",
    frames: {
      idle: animated([" ╱▔▔╲  ✦", "( o.o )", " > ^ <~"], [" ╱▔▔╲", "( -.- )", " > ^ < ~"]),
      thinking: frame(" ╱▔▔╲  …", "( •.• )", " > ? <~"),
      working: animated([" ╱▔▔╲⌨", "( >.< )", " > ^ <~"], [" ╱▔▔╲ ⌨", "( >.< )", " > ^ < ~"]),
      happy: frame(" ╱▔▔╲  ★", "( ^ω^ )", " > ♡ <~"),
      oops: frame(" ╱▔▔╲  !", "( ;ω; )", " > _ <~"),
      sleeping: animated([" ╱▔▔╲ zZ", "( -.- )", " > ^ <~"], [" ╱▔▔╲  zZ", "( -.- )", " > ^ < ~"]),
      celebrating: animated(
        [" ╱▔▔╲ 🎉", "( ^ω^ )ﾉ", " > ★ <~"],
        ["✨╱▔▔╲", "ﾉ( ^ω^ )", " > ★ < ~"],
      ),
      levelup: animated([" ╱▔▔╲ ⬆", "( ≧▽≦ )", " > ♡ <~"], [" ╱▔▔╲ ✦", "( ≧▽≦ )", " > ♡ < ~"]),
    },
  },
  {
    id: "nori",
    name: "Nori",
    species: "薄荷六角恐龙",
    catchphrase: "再难的栈，也能慢慢游过去。",
    frames: {
      idle: animated(["  ʚ(•ᴗ•)ɞ", "  ╱|   |╲"], ["  ʚ(-ᴗ-)ɞ", "  ╱|   |╲"]),
      thinking: frame("  ʚ(•́ ᴗ •̀)ɞ ?", "  ╱|   |╲"),
      working: animated(["⌨ ʚ(•̀ᴗ•́)ɞ", "   ╱| |╲"], [" ⌨ʚ(•̀ᴗ•́)ɞ", "   ╱| |╲"]),
      happy: frame(" ʚ(˶ᵔ ᵕ ᵔ˶)ɞ ✨", "   ╱| |╲"),
      oops: frame("  ʚ(╥﹏╥)ɞ", "   ╱| |╲"),
      sleeping: animated(["  ʚ(-ᴗ-)ɞzZ", "  ╱|   |╲"], ["  ʚ(-ᴗ-)ɞ z", "  ╱|   |╲"]),
      celebrating: animated([" ʚ(˶ᵔ ᵕ ᵔ˶)ɞ🎉", "   ╱|★|╲"], ["✨ʚ(˶ᵔ ᵕ ᵔ˶)ɞ", "   ╱|★|╲"]),
      levelup: animated([" ʚ(≧▽≦)ɞ ⬆", "   ╱|♡|╲"], [" ʚ(≧▽≦)ɞ ✦", "   ╱|♡|╲"]),
    },
  },
  {
    id: "pico",
    name: "Pico",
    species: "布丁企鹅",
    catchphrase: "滑进代码，稳稳落地。",
    frames: {
      idle: animated(["  ＿(•ө•)＿", "    ╱  ╲"], ["  ＿(-ө-)＿", "    ╱  ╲"]),
      thinking: frame("  ＿(•ө•?)＿", "    ╱  ╲"),
      working: animated([" ⌨＿(•̀ө•́)＿", "     ╱ ╲"], ["⌨ ＿(•̀ө•́)＿", "     ╱ ╲"]),
      happy: frame("  ＿(ᵔөᵔ)＿ ♡", "    ╱  ╲"),
      oops: frame("  ＿(•́ө•̀)＿", "    ╱  ╲"),
      sleeping: animated(["  ＿(-ө-)＿zZ", "    ╱  ╲"], ["  ＿(-ө-)＿ z", "    ╱  ╲"]),
      celebrating: animated(["  ＿(ᵔөᵔ)＿🎉", "    ╱★ ╲"], ["✨＿(ᵔөᵔ)＿", "    ╱★ ╲"]),
      levelup: animated(["  ＿(≧ө≦)＿⬆", "    ╱♡ ╲"], ["  ＿(≧ө≦)＿✦", "    ╱♡ ╲"]),
    },
  },
  {
    id: "bubu",
    name: "Bubu",
    species: "奶油小熊",
    catchphrase: "抱住需求，也抱住边界。",
    frames: {
      idle: animated([" ʕ •ᴥ• ʔ", "  ╱づ🍪"], [" ʕ -ᴥ- ʔ", "  ╱づ🍪"]),
      thinking: frame(" ʕ •ᴥ•?ʔ", "  ╱づ づ"),
      working: animated(["⌨ʕ •̀ᴥ•́ʔ", "   ╱づづ"], [" ⌨ʕ •̀ᴥ•́ʔ", "   ╱づづ"]),
      happy: frame(" ʕ ᵔᴥᵔ ʔﾉ♡", "  ╱づ づ"),
      oops: frame(" ʕ •́ᴥ•̀ ʔ", "  ╱づ づ"),
      sleeping: animated([" ʕ -ᴥ- ʔzZ", "  ╱づ🍪"], [" ʕ -ᴥ- ʔ z", "  ╱づ🍪"]),
      celebrating: animated([" ʕ ᵔᴥᵔ ʔﾉ🎉", "  ╱づ★づ"], ["✨ʕ ᵔᴥᵔ ʔ", "  ╱づ★づ"]),
      levelup: animated([" ʕ ≧ᴥ≦ ʔ ⬆", "  ╱づ♡づ"], [" ʕ ≧ᴥ≦ ʔ ✦", "  ╱づ♡づ"]),
    },
  },
  {
    id: "kumo",
    name: "Kumo",
    species: "代码水豚",
    catchphrase: "不慌，先读代码。",
    frames: {
      idle: animated(["  (•ㅅ• )", "  ╱|☕|╲"], ["  (-ㅅ- )", "  ╱|☕|╲"]),
      thinking: frame("  (•ㅅ•?)", "  ╱|  |╲"),
      working: animated(["⌨ (•̀ㅅ•́)", "   ╱| |╲"], [" ⌨(•̀ㅅ•́)", "   ╱| |╲"]),
      happy: frame("  (ᵔㅅᵔ )ﾉ ✨", "  ╱|  |╲"),
      oops: frame("  (•́ㅅ•̀)", "  ╱|  |╲"),
      sleeping: animated(["  (-ㅅ- )zZ", "  ╱|☕|╲"], ["  (-ㅅ- ) z", "  ╱|☕|╲"]),
      celebrating: animated(["  (ᵔㅅᵔ )ﾉ🎉", "  ╱|★|╲"], ["✨(ᵔㅅᵔ )", "  ╱|★|╲"]),
      levelup: animated(["  (≧ㅅ≦ ) ⬆", "  ╱|♡|╲"], ["  (≧ㅅ≦ ) ✦", "  ╱|♡|╲"]),
    },
  },
] as const;

export function getMascot(value: string | TuiMascot = "foxy"): TuiMascot {
  if (typeof value !== "string") return validateTuiMascot(value);
  const mascot = TUI_MASCOTS.find((item) => item.id === value);
  if (!mascot) throw new Error("Unknown TUI mascot: " + value);
  return mascot;
}

export function validateTuiMascot(value: unknown): TuiMascot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TUI mascot must be an object");
  }
  const mascot = value as Record<string, unknown>;
  for (const field of ["id", "name", "species", "catchphrase"] as const) {
    if (
      typeof mascot[field] !== "string" ||
      !mascot[field] ||
      /[\u0000-\u001f\u007f\u001b]/.test(mascot[field])
    ) {
      throw new Error(`Invalid TUI mascot ${field}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(mascot.id))) {
    throw new Error("Invalid TUI mascot id");
  }
  if (!mascot.frames || typeof mascot.frames !== "object" || Array.isArray(mascot.frames)) {
    throw new Error("TUI mascot frames must be an object");
  }
  const frames = mascot.frames as Record<string, unknown>;
  if (!frames.idle) throw new Error("TUI mascot must define idle frames");
  for (const [mood, moodFrames] of Object.entries(frames)) {
    if (!MASCOT_MOODS.includes(mood as MascotMood)) {
      throw new Error(`Unknown TUI mascot mood: ${mood}`);
    }
    if (
      !Array.isArray(moodFrames) ||
      moodFrames.length < 1 ||
      moodFrames.length > MASCOT_FRAME_LIMITS.framesPerMood
    ) {
      throw new Error(`TUI mascot ${mood} must have 1 to 8 frames`);
    }
    for (const drawing of moodFrames) {
      if (
        !Array.isArray(drawing) ||
        drawing.length < 1 ||
        drawing.length > MASCOT_FRAME_LIMITS.linesPerFrame ||
        !drawing.every(
          (line) =>
            typeof line === "string" &&
            [...line].length <= MASCOT_FRAME_LIMITS.codePointsPerLine &&
            !/[\u0000-\u001f\u007f\u001b]/.test(line),
        )
      ) {
        throw new Error(`Invalid TUI mascot ${mood} frame`);
      }
    }
  }
  return structuredClone(value) as TuiMascot;
}

/** Frames for a mood, falling back to idle frames when the mood is missing. */
export function getMascotFrames(mascot: TuiMascot, mood: MascotMood): readonly string[][] {
  return mascot.frames[mood] ?? mascot.frames.idle ?? [];
}

export function mascotFrame(mascot: TuiMascot, mood: MascotMood, tick: number): string[] {
  const frames = getMascotFrames(mascot, mood);
  return frames[tick % frames.length] ?? frames[0] ?? [];
}
