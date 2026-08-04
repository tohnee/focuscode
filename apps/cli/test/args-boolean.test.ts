import { describe, expect, it } from "vitest";
import { flag, parseArgs } from "../src/index.js";

/**
 * Regression (code review): `--flag=false` was stored as the inline string
 * "false" while consumers only checked `.has()`, so
 * `--trust-repo-config=false` actually ENABLED repo-config trust (and
 * `--force=false` / `--enterprise=false` behaved the same), inverting the
 * trust boundary the caller explicitly disabled.
 */
describe("boolean flags honor --flag=false", () => {
  it("--trust-repo-config=false does not enable the flag", () => {
    const args = parseArgs(["run", "--task", "x", "--trust-repo-config=false"]);
    expect(flag(args, "trust-repo-config")).toBe(false);
  });

  it("bare --trust-repo-config enables the flag", () => {
    const args = parseArgs(["run", "--task", "x", "--trust-repo-config"]);
    expect(flag(args, "trust-repo-config")).toBe(true);
  });

  it("--trust-repo-config=true enables the flag", () => {
    const args = parseArgs(["run", "--task", "x", "--trust-repo-config=true"]);
    expect(flag(args, "trust-repo-config")).toBe(true);
  });

  it("--enterprise=false does not enable enterprise mode", () => {
    const args = parseArgs(["init", "--enterprise=false"]);
    expect(flag(args, "enterprise")).toBe(false);
  });

  it("--force=false does not force an overwrite", () => {
    const args = parseArgs(["init", "--force=false"]);
    expect(flag(args, "force")).toBe(false);
  });

  it("an absent flag is false", () => {
    const args = parseArgs(["run", "--task", "x"]);
    expect(flag(args, "trust-repo-config")).toBe(false);
  });

  it("value options still parse with = syntax", () => {
    const args = parseArgs(["run", "--task=hello world", "--mode=change"]);
    expect(args.options.get("task")).toBe("hello world");
    expect(args.options.get("mode")).toBe("change");
  });
});
