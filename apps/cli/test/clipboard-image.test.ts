import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClipboardImage } from "../src/tui.js";

// 1x1 PNG, 70 bytes. Small enough to embed; large enough to prove byte fidelity.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const HAS_OSASCRIPT =
  process.platform === "darwin" && spawnSync("which", ["osascript"]).status === 0;

function osascript(...lines: string[]): void {
  const result = spawnSync(
    "osascript",
    lines.flatMap((line) => ["-e", line]),
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`osascript failed: ${result.stderr}`);
}

describe.skipIf(!HAS_OSASCRIPT)("macOS clipboard image capture", () => {
  it("round-trips a PNG through the real system clipboard byte-identically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focuscode-clipboard-test-"));
    const source = join(directory, "source.png");
    const png = Buffer.from(PNG_BASE64, "base64");
    await writeFile(source, png);
    let captured: string | undefined;
    try {
      // Write the PNG onto the real clipboard as «class PNGf», exactly like a
      // user copying an image, then read it back through the TUI code path.
      osascript(`set the clipboard to (read (POSIX file "${source}") as «class PNGf»)`);
      captured = await readClipboardImage();
      expect(captured).toBeDefined();
      const bytes = await readFile(captured!);
      expect(bytes.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        createHash("sha256").update(png).digest("hex"),
      );
    } finally {
      if (captured) await rm(captured, { force: true });
      osascript('set the clipboard to ""');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
