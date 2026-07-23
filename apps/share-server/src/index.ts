import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifySessionShareBundle } from "@focuscode/ecosystem";

export interface ShareServerOptions {
  directory: string;
  token?: string;
  publicBaseUrl?: string;
  maxBytes?: number;
  requireAuthentication?: boolean;
  trustedSignerFingerprints?: string[];
  maxShareAgeMs?: number;
  rateLimit?: { windowMs: number; maximum: number };
}

export function createShareServer(options: ShareServerOptions): Server {
  const directory = resolve(options.directory);
  const maximum = options.maxBytes ?? 25_000_000;
  const rateBuckets = new Map<string, { startedAt: number; requests: number }>();
  return createServer(async (request, response) => {
    try {
      securityHeaders(response);
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, { status: "ok", component: "focuscode-share-server" });
        return;
      }
      if (!authorized(request, options.token, options.requireAuthentication ?? false)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (!withinRateLimit(request, options.rateLimit, rateBuckets)) {
        response.setHeader("retry-after", "60");
        json(response, 429, { error: "rate limit exceeded" });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/shares") {
        const body = await readBody(request, maximum);
        const bundle = JSON.parse(body) as Record<string, unknown>;
        const id = validateBundle(bundle, options);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, id + ".json");
        if (await exists(path)) {
          json(response, 409, { error: "share already exists" });
          return;
        }
        await writeFile(path, JSON.stringify(bundle) + "\n", {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        json(response, 201, {
          id,
          ...(options.publicBaseUrl
            ? { url: new URL("/v1/shares/" + id, options.publicBaseUrl).toString() }
            : {}),
        });
        return;
      }
      const match = request.url?.match(/^\/v1\/shares\/([A-Za-z0-9_-]{1,160})$/);
      if (request.method === "GET" && match) {
        const path = join(directory, match[1] + ".json");
        if (!(await exists(path))) {
          json(response, 404, { error: "not found" });
          return;
        }
        const source = await readFile(path, "utf8");
        const bundle = JSON.parse(source) as Record<string, unknown>;
        if (isExpired(bundle, options.maxShareAgeMs)) {
          json(response, 410, { error: "share expired" });
          return;
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(source);
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, message.includes("exceeds") ? 413 : 400, { error: message });
    }
  });
}

function validateBundle(bundle: Record<string, unknown>, options: ShareServerOptions): string {
  if (!verifySessionShareBundle(bundle)) throw new Error("Invalid session share signature");
  if (typeof bundle.shareId !== "string" || !/^share_[A-Za-z0-9-]{8,160}$/.test(bundle.shareId)) {
    throw new Error("Invalid share id");
  }
  if (typeof bundle.signature !== "string" || !bundle.signer || !bundle.session) {
    throw new Error("Incomplete signed share");
  }
  if (isExpired(bundle, options.maxShareAgeMs)) throw new Error("Session share is expired");
  const trusted = options.trustedSignerFingerprints ?? [];
  if (trusted.length > 0) {
    const signer = bundle.signer as Record<string, unknown>;
    const fingerprint = signerFingerprint(String(signer.publicKey ?? ""));
    if (!trusted.includes(fingerprint)) throw new Error("Session share signer is not trusted");
  }
  return bundle.shareId;
}

function authorized(
  request: IncomingMessage,
  token: string | undefined,
  required: boolean,
): boolean {
  if (!token) return !required;
  const provided = request.headers.authorization;
  if (!provided?.startsWith("Bearer ")) return false;
  const left = Buffer.from(provided.slice(7));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function withinRateLimit(
  request: IncomingMessage,
  policy: ShareServerOptions["rateLimit"],
  buckets: Map<string, { startedAt: number; requests: number }>,
): boolean {
  if (!policy) return true;
  if (!Number.isInteger(policy.maximum) || policy.maximum < 1 || policy.windowMs < 1_000) {
    throw new Error("Invalid share rate-limit policy");
  }
  const key = request.headers.authorization ?? request.socket.remoteAddress ?? "anonymous";
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= policy.windowMs) {
    buckets.set(key, { startedAt: now, requests: 1 });
    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.startedAt >= policy.windowMs) buckets.delete(bucketKey);
      }
    }
    return true;
  }
  current.requests += 1;
  return current.requests <= policy.maximum;
}

function isExpired(bundle: Record<string, unknown>, maximumAge: number | undefined): boolean {
  if (!maximumAge) return false;
  const created = typeof bundle.createdAt === "string" ? Date.parse(bundle.createdAt) : Number.NaN;
  return (
    !Number.isFinite(created) || created > Date.now() + 300_000 || Date.now() - created > maximumAge
  );
}

function signerFingerprint(publicKey: string): string {
  try {
    const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
    return "sha256:" + createHash("sha256").update(der).digest("hex");
  } catch {
    throw new Error("Session share signer key is invalid");
  }
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maximum) throw new Error("Share exceeds maximum size");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.FOCUSCODE_SHARE_PORT ?? "4319");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FOCUSCODE_SHARE_PORT must be a valid TCP port");
  }
  const trustedSignerFingerprints = (process.env.FOCUSCODE_SHARE_TRUSTED_SIGNERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const rateMaximum = optionalPositiveInteger("FOCUSCODE_SHARE_RATE_MAX");
  const rateWindowMs = optionalPositiveInteger("FOCUSCODE_SHARE_RATE_WINDOW_MS");
  const maxAgeDays = optionalPositiveInteger("FOCUSCODE_SHARE_MAX_AGE_DAYS");
  if ((rateMaximum === undefined) !== (rateWindowMs === undefined)) {
    throw new Error(
      "FOCUSCODE_SHARE_RATE_MAX and FOCUSCODE_SHARE_RATE_WINDOW_MS must be set together",
    );
  }
  const server = createShareServer({
    directory: process.env.FOCUSCODE_SHARE_DIRECTORY ?? resolve(".focuscode-shares"),
    ...(process.env.FOCUSCODE_SHARE_TOKEN ? { token: process.env.FOCUSCODE_SHARE_TOKEN } : {}),
    ...(process.env.FOCUSCODE_SHARE_BASE_URL
      ? { publicBaseUrl: process.env.FOCUSCODE_SHARE_BASE_URL }
      : {}),
    requireAuthentication: process.env.FOCUSCODE_SHARE_ALLOW_ANONYMOUS !== "1",
    ...(maxAgeDays !== undefined ? { maxShareAgeMs: maxAgeDays * 86_400_000 } : {}),
    ...(trustedSignerFingerprints.length > 0 ? { trustedSignerFingerprints } : {}),
    ...(rateMaximum !== undefined && rateWindowMs !== undefined
      ? { rateLimit: { maximum: rateMaximum, windowMs: rateWindowMs } }
      : {}),
  });
  if (!process.env.FOCUSCODE_SHARE_TOKEN && process.env.FOCUSCODE_SHARE_ALLOW_ANONYMOUS !== "1") {
    throw new Error(
      "FOCUSCODE_SHARE_TOKEN is required; set FOCUSCODE_SHARE_ALLOW_ANONYMOUS=1 only for local development",
    );
  }
  const bind = process.env.FOCUSCODE_SHARE_BIND ?? "127.0.0.1";
  server.listen(port, bind, () => {
    process.stdout.write("FocusCode share server listening on http://" + bind + ":" + port + "\n");
  });
}

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
