import { describe, expect, it } from "vitest";
import { runAuthCommand } from "../src/auth-command.js";

/**
 * Regression (code review): `auth login --client-secret` accepted the OAuth
 * client secret as a CLI argument, leaking it into shell history and `ps`
 * output — directly contradicting SECURITY.md (use
 * FOCUSCODE_<PROVIDER>_CLIENT_SECRET).
 */
describe("auth login rejects --client-secret", () => {
  it("throws with a pointer to the environment variable", async () => {
    await expect(
      runAuthCommand([
        "login",
        "google",
        "--client-id",
        "test-client",
        "--client-secret",
        "hunter2",
      ]),
    ).rejects.toThrow(/--client-secret is not accepted/);
  });

  it("names the exact provider-specific environment variable in the error", async () => {
    await expect(
      runAuthCommand(["login", "google", "--client-id", "test-client", "--client-secret", "x"]),
    ).rejects.toThrow(/FOCUSCODE_GOOGLE_CLIENT_SECRET/);
  });

  it("applies to custom (non-built-in) providers too", async () => {
    // The rejection happens before customProfile is reached, but the option
    // must be refused for custom providers as well.
    await expect(
      runAuthCommand(["login", "my-idp", "--client-id", "test-client", "--client-secret", "x"]),
    ).rejects.toThrow(/--client-secret is not accepted/);
  });
});
