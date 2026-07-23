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
        const url = parseFetchUrl(input.url);
        if (typeof url === "object") return url;
        const maxChars = boundedInteger(input.maxChars, DEFAULT_MAX_CHARS, 100, MAX_CHARS_LIMIT);
        const response = await fetchWithTimeout(url, timeoutMs, context.signal);
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

function parseFetchUrl(value: unknown): string | ToolExecutionResult {
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
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "text/html, text/plain, application/json, */*" },
    });
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
