import { describe, expect, it } from "vitest";
import { isPrivateAddress, parseFetchUrl } from "../src/index.js";

function isFailure(value: unknown): value is { content: string; isError: true } {
  return (
    typeof value === "object" && value !== null && (value as { isError?: boolean }).isError === true
  );
}

describe("isPrivateAddress", () => {
  it("TC-P0-4-01: detects 127.0.0.1 as private (loopback)", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
  });

  it("TC-P0-4-02: detects localhost as private", () => {
    expect(isPrivateAddress("localhost")).toBe(true);
  });

  it("TC-P0-4-03: detects 10.0.0.1 as private (RFC1918)", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
  });

  it("TC-P0-4-04: detects 172.16.0.1 as private (RFC1918)", () => {
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
  });

  it("TC-P0-4-05: detects 192.168.1.1 as private (RFC1918)", () => {
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
  });

  it("TC-P0-4-06: detects 169.254.169.254 as private (cloud metadata)", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });

  it("TC-P0-4-07: detects ::1 as private (IPv6 loopback)", () => {
    expect(isPrivateAddress("::1")).toBe(true);
  });

  it("TC-P0-4-08: does not flag example.com as private", () => {
    expect(isPrivateAddress("example.com")).toBe(false);
  });

  it("TC-P0-4-09: does not flag 8.8.8.8 as private", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("detects 0.0.0.0 as private", () => {
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
  });

  it("detects fc00::1 as private (IPv6 ULA)", () => {
    expect(isPrivateAddress("fc00::1")).toBe(true);
  });

  it("detects fe80::1 as private (IPv6 link-local)", () => {
    expect(isPrivateAddress("fe80::1")).toBe(true);
  });

  it("detects sub.localhost as private", () => {
    expect(isPrivateAddress("api.localhost")).toBe(true);
  });

  it("detects 172.31.255.255 as private (end of 172.16/12 range)", () => {
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
  });

  it("does not flag 172.32.0.1 as private (outside 172.16/12 range)", () => {
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });

  it("does not flag 11.0.0.1 as private (outside 10/8 range)", () => {
    expect(isPrivateAddress("11.0.0.1")).toBe(false);
  });

  it("TC-P0-4-20: detects ::ffff:169.254.169.254 as private (IPv4-mapped metadata)", () => {
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("TC-P0-4-21: detects ::ffff:127.0.0.1 as private (IPv4-mapped loopback)", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("TC-P0-4-22: detects ::ffff:10.0.0.1 as private (IPv4-mapped RFC1918)", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("TC-P0-4-23: detects ::ffff:a9fe:a9fe as private (full-hex IPv4-mapped metadata)", () => {
    expect(isPrivateAddress("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("TC-P0-4-24: does not flag ::ffff:8.8.8.8 as private (IPv4-mapped public)", () => {
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("TC-P0-4-25: detects ::169.254.169.254 as private (IPv4-compatible metadata)", () => {
    expect(isPrivateAddress("::169.254.169.254")).toBe(true);
  });
});

describe("parseFetchUrl SSRF protection", () => {
  it("TC-P0-4-10: rejects http://127.0.0.1/x", () => {
    const result = parseFetchUrl("http://127.0.0.1/x");
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.content.toLowerCase()).toMatch(/private|ssrf|loopback|internal/);
    }
  });

  it("TC-P0-4-11: rejects http://localhost/x", () => {
    const result = parseFetchUrl("http://localhost/x");
    expect(isFailure(result)).toBe(true);
  });

  it("TC-P0-4-12: rejects http://169.254.169.254/latest/meta-data/", () => {
    const result = parseFetchUrl("http://169.254.169.254/latest/meta-data/");
    expect(isFailure(result)).toBe(true);
  });

  it("TC-P0-4-13: accepts http://example.com/x and returns the URL", () => {
    const result = parseFetchUrl("http://example.com/x");
    expect(typeof result).toBe("string");
    expect(result).toBe("http://example.com/x");
  });

  it("TC-P0-4-14: rejects http://0.0.0.0/x", () => {
    const result = parseFetchUrl("http://0.0.0.0/x");
    expect(isFailure(result)).toBe(true);
  });

  it("rejects http://[::1]/x (IPv6 loopback in URL form)", () => {
    const result = parseFetchUrl("http://[::1]/x");
    expect(isFailure(result)).toBe(true);
  });

  it("rejects http://10.0.0.1/x", () => {
    const result = parseFetchUrl("http://10.0.0.1/x");
    expect(isFailure(result)).toBe(true);
  });

  it("rejects http://192.168.1.1/x", () => {
    const result = parseFetchUrl("http://192.168.1.1/x");
    expect(isFailure(result)).toBe(true);
  });

  it("still rejects non-http protocols", () => {
    const result = parseFetchUrl("file:///etc/passwd");
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.content).toContain("Unsupported protocol");
    }
  });

  it("still rejects URLs with embedded credentials", () => {
    const result = parseFetchUrl("http://user:pass@example.com/");
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.content).toContain("credentials");
    }
  });

  it("accepts https://example.com/path", () => {
    const result = parseFetchUrl("https://example.com/path");
    expect(typeof result).toBe("string");
    expect(result).toBe("https://example.com/path");
  });
});
