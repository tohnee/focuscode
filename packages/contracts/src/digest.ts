import { createHash, randomUUID } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Digest(value: unknown): `sha256:${string}` {
  const bytes = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
