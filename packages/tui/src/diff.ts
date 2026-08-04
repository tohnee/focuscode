import { fg } from "./themes.js";
import { sanitizeTerminalText, stringWidth, takeWidth } from "./width.js";

interface DiffOp {
  type: "same" | "del" | "add";
  text: string;
}

const CONTEXT_LIMIT = 3;
const DP_CELL_LIMIT = 4_000_000;

/**
 * Render a line-level diff (LCS-based) with `-` lines in red, `+` lines in green and
 * context in gray. Unchanged runs longer than ~3 lines collapse into a single
 * `... N unchanged lines ...` marker. Every emitted line fits `width` columns.
 */
export function renderDiff(oldText: string, newText: string, width: number): string[] {
  const columns = Math.max(20, width);
  const ops = diffLines(oldText.split("\n"), newText.split("\n"));
  const rendered: string[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.type === "same") {
      let end = index;
      while (end < ops.length && ops[end]!.type === "same") end += 1;
      const run = ops.slice(index, end);
      if (run.length > CONTEXT_LIMIT) {
        rendered.push(gray("... " + run.length + " unchanged lines ..."));
      } else {
        for (const context of run)
          rendered.push(gray("  " + clip(sanitizeTerminalText(context.text), columns - 2)));
      }
      index = end;
      continue;
    }
    // File content may contain terminal control sequences (hostile repo, log
    // file): strip them before the line reaches the frame.
    if (op.type === "del")
      rendered.push(fg(1, "- " + clip(sanitizeTerminalText(op.text), columns - 2)));
    else rendered.push(fg(2, "+ " + clip(sanitizeTerminalText(op.text), columns - 2)));
    index += 1;
  }
  return rendered;
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0) return newLines.map((text) => ({ type: "add", text }));
  if (n === 0) return oldLines.map((text) => ({ type: "del", text }));
  if (m * n > DP_CELL_LIMIT) {
    // Extremely large edits: skip the O(m*n) table and show a wholesale replacement.
    return [
      ...oldLines.map((text): DiffOp => ({ type: "del", text })),
      ...newLines.map((text): DiffOp => ({ type: "add", text })),
    ];
  }
  const stride = n + 1;
  const dp = new Uint32Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * stride + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * stride + j + 1]! + 1
          : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "same", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      ops.push({ type: "del", text: oldLines[i]! });
      i += 1;
    } else {
      ops.push({ type: "add", text: newLines[j]! });
      j += 1;
    }
  }
  while (i < m) ops.push({ type: "del", text: oldLines[i++]! });
  while (j < n) ops.push({ type: "add", text: newLines[j++]! });
  return ops;
}

function clip(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  return takeWidth(text, Math.max(1, width - 1)) + "…";
}

function gray(text: string): string {
  return fg(8, text);
}
