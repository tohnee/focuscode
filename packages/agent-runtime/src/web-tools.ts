import type { AgentTool, ToolExecutionResult } from "./types.js";

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_LIMIT = 50_000;
const MAX_BODY_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "focuscode-agent/0.4 (+https://github.com/focuscode)";
const DUCKDUCKGO_LITE = "https://lite.duckduckgo.com/lite/";

export interface WebFetchToolOptions {
  /** Request timeout; injectable for tests. Defaults to 20s. */
  timeoutMs?: number;
  /**
   * Allow fetching private/loopback/metadata addresses. Defaults to false.
   * When false, SSRF protection blocks 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
   * 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0, ::1, fc00::/7, and fe80::/10.
   */
  allowPrivateAddresses?: boolean;
}

export interface WebSearchToolOptions {
  /**
   * Custom search endpoint: GET <endpoint>?q=<query> returning a JSON array of
   * {title, url, snippet}. Defaults to DuckDuckGo lite HTML.
   */
  endpoint?: string;
  /** Request timeout; injectable for tests. Defaults to 20s. */
  timeoutMs?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export function createWebFetchTool(options: WebFetchToolOptions = {}): AgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPrivate = options.allowPrivateAddresses ?? false;
  return {
    definition: {
      name: "web_fetch",
      label: "Web fetch",
      description:
        "Fetch one http(s) URL and return its content as text. HTML is converted to plain text.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          maxChars: { type: "integer", minimum: 100, maximum: MAX_CHARS_LIMIT },
        },
        additionalProperties: false,
      },
      effect: "network",
    },
    async execute(input, context) {
      try {
        const url = parseFetchUrl(input.url, allowPrivate);
        if (typeof url === "object") return url;
        const maxChars = boundedInteger(input.maxChars, DEFAULT_MAX_CHARS, 100, MAX_CHARS_LIMIT);
        const response = await fetchWithTimeout(url, timeoutMs, context.signal, allowPrivate);
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_BODY_BYTES) {
          return failure(`Response declares ${declared} bytes, over the 2 MB limit`);
        }
        const body = await readBodyBounded(response, MAX_BODY_BYTES);
        const contentType = response.headers.get("content-type") ?? "";
        let text = /html/i.test(contentType) ? htmlToText(body.text) : body.text;
        let truncated = body.truncated;
        if (text.length > maxChars) {
          text = text.slice(0, maxChars);
          truncated = true;
        }
        return {
          content: text.trim() || `Empty response (HTTP ${response.status})`,
          metadata: {
            url: response.url || url,
            status: response.status,
            contentType,
            bytes: body.bytes,
            truncated,
          },
        };
      } catch (error) {
        return failure(`web_fetch failed: ${errorMessage(error)}`);
      }
    },
  };
}

export function createWebSearchTool(options: WebSearchToolOptions = {}): AgentTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    definition: {
      name: "web_search",
      label: "Web search",
      description: "Search the web and return a bounded list of titles, URLs and snippets.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1 },
          maxResults: { type: "integer", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      effect: "network",
    },
    async execute(input, context) {
      try {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) return failure("web_search requires a non-empty query");
        const maxResults = boundedInteger(input.maxResults, 10, 1, 20);
        const results = options.endpoint
          ? await searchViaEndpoint(options.endpoint, query, maxResults, timeoutMs, context.signal)
          : await searchViaDuckDuckGo(query, maxResults, timeoutMs, context.signal);
        if (results.length === 0) {
          return { content: `No results for: ${query}`, metadata: { results: 0 } };
        }
        return {
          content: results
            .map(
              (result, index) =>
                `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`,
            )
            .join("\n"),
          metadata: { results: results.length, endpoint: options.endpoint ?? DUCKDUCKGO_LITE },
        };
      } catch (error) {
        return failure(`web_search failed: ${errorMessage(error)}`);
      }
    },
  };
}

/** Naive DuckDuckGo lite HTML parser; exported for tests. Fragile by design. */
export function parseSearchResults(html: string, maxResults: number): WebSearchResult[] {
  const links: WebSearchResult[] = [];
  const anchorPattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const tag = match[0];
    const classMatch = /class\s*=\s*["']([^"']*)["']/i.exec(tag);
    const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!classMatch || !hrefMatch) continue;
    if (!classMatch[1]!.split(/\s+/).includes("result-link")) continue;
    const url = decodeEntities(hrefMatch[1]!);
    if (!/^https?:\/\//i.test(url)) continue;
    links.push({ title: collapseWhitespace(decodeEntities(stripTags(match[1]!))), url });
    if (links.length >= maxResults) break;
  }
  const snippets = [
    ...html.matchAll(
      /<td\b[^>]*class\s*=\s*["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi,
    ),
  ].map((match) => collapseWhitespace(decodeEntities(stripTags(match[1]!))));
  for (const [index, link] of links.entries()) {
    const snippet = snippets[index];
    if (snippet) link.snippet = snippet;
  }
  if (links.length > 0) return links;
  // Fallback: any absolute http(s) anchor, in document order.
  const fallback: WebSearchResult[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const title = collapseWhitespace(decodeEntities(stripTags(match[2]!)));
    if (!title) continue;
    fallback.push({ title, url: decodeEntities(match[1]!) });
    if (fallback.length >= maxResults) break;
  }
  return fallback;
}

/** Minimal HTML to text: drop script/style, strip tags, decode common entities. */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  return collapseWhitespace(decodeEntities(stripTags(withoutBlocks)));
}

/**
 * Detects private, loopback, link-local, and cloud-metadata addresses.
 * Exported for tests. Does NOT perform DNS resolution — only inspects the
 * hostname string literal, so it does not catch DNS rebinding to private IPs.
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipv4 = parseIPv4Octets(host);
  if (ipv4) return isPrivateIPv4(ipv4);
  const ipv6 = parseIPv6Groups(host);
  if (ipv6) return isPrivateIPv6(ipv6);
  return false;
}

function parseIPv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  return false;
}

function parseIPv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const headParts = halves[0] ? halves[0].split(":").filter((p) => p !== "") : [];
  const tailParts = halves[1] ? halves[1].split(":").filter((p) => p !== "") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const groups: number[] = [];
  for (const part of [...headParts, ...Array(missing).fill("0"), ...tailParts]) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  if (groups.length !== 8) return null;
  return groups;
}

function isPrivateIPv6(groups: number[]): boolean {
  // ::1 (loopback) — 0000:0000:0000:0000:0000:0000:0000:0001
  if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true;
  // fc00::/7 — Unique Local Address (ULA)
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  return false;
}

export function parseFetchUrl(value: unknown, allowPrivate = false): string | ToolExecutionResult {
  if (typeof value !== "string" || !value.trim()) return failure("web_fetch requires a url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failure(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failure(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    return failure("URLs with embedded credentials are not allowed");
  }
  if (!allowPrivate && isPrivateAddress(url.hostname)) {
    return failure(`URL hostname is a private or internal address: ${url.hostname}`);
  }
  return url.toString();
}

async function searchViaEndpoint(
  endpoint: string,
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const separator = endpoint.includes("?") ? "&" : "?";
  const response = await fetchWithTimeout(
    `${endpoint}${separator}q=${encodeURIComponent(query)}`,
    timeoutMs,
    signal,
  );
  const body = await readBodyBounded(response, MAX_BODY_BYTES);
  const parsed: unknown = JSON.parse(body.text);
  if (!Array.isArray(parsed)) throw new Error("Search endpoint did not return a JSON array");
  const results: WebSearchResult[] = [];
  for (const item of parsed) {
    if (results.length >= maxResults) break;
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.title !== "string" || typeof candidate.url !== "string") continue;
    results.push({
      title: candidate.title,
      url: candidate.url,
      ...(typeof candidate.snippet === "string" ? { snippet: candidate.snippet } : {}),
    });
  }
  return results;
}

async function searchViaDuckDuckGo(
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WebSearchResult[]> {
  const response = await fetchWithTimeout(
    `${DUCKDUCKGO_LITE}?q=${encodeURIComponent(query)}`,
    timeoutMs,
    signal,
  );
  const body = await readBodyBounded(response, MAX_BODY_BYTES);
  return parseSearchResults(body.text, maxResults);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  allowPrivate = false,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Use redirect:"manual" so each redirect target can be re-validated for
    // scheme, credentials, and SSRF (private/loopback/metadata addresses).
    // This prevents redirect-based SSRF where a public URL 302s to an
    // internal service (e.g., 169.254.169.254 cloud metadata endpoint).
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html, text/plain, application/json, */*",
        },
      });
      if (response.status < 300 || response.status >= 400) {
        return response;
      }
      const location = response.headers.get("location");
      if (!location) return response;
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`Invalid redirect Location: ${location}`);
      }
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        throw new Error(`Redirect to unsupported protocol: ${nextUrl.protocol}`);
      }
      if (nextUrl.username || nextUrl.password) {
        throw new Error("Redirect to URL with embedded credentials is not allowed");
      }
      if (!allowPrivate && isPrivateAddress(nextUrl.hostname)) {
        throw new Error(`Redirect to private address is not allowed: ${nextUrl.hostname}`);
      }
      currentUrl = nextUrl.toString();
    }
    throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

async function readBodyBounded(
  response: Response,
  limit: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: "", bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      truncated = true;
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (bytes - limit))));
      bytes = limit;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

function failure(content: string): ToolExecutionResult {
  return { content, isError: true };
}
