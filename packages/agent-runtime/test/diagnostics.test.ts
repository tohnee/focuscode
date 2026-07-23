import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { runDiagnostics, shouldRunDiagnostics } from "../src/index.js";

describe("diagnostics", () => {
  it("does not run in a directory without tsconfig.json", async () => {
    const root = await createTestDirectory("diagnostics");
    expect(await shouldRunDiagnostics(root)).toBe(false);
    expect(await runDiagnostics(root)).toEqual({ ran: false });
  });
});
