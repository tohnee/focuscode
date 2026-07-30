import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createWebFetchTool,
  createWebSearchTool,
  htmlToText,
  parseSearchResults,
} from "../src/index.js";

async function withServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

describe("web_fetch", () => {
  it("fetches HTML and converts it to plain text", async () => {
    await withServer(
      (request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<html><head><style>body { color: red; }</style></head>` +
            `<body><h1>Hello &amp; welcome</h1><script>alert(1)</script><p>some text</p></body></html>`,
        );
      },
      async (baseUrl) => {
        const tool = createWebFetchTool({ allowPrivateAddresses: true });
        const result = await tool.execute({ url: `${baseUrl}/page` }, { cwd: "." });
        expect(result.isError).toBeUndefined();
        expect(result.content).toContain("Hello & welcome");
        expect(result.content).toContain("some text");
        expect(result.content).not.toContain("alert");
        expect(result.content).not.toContain("color: red");
        expect(result.metadata).toMatchObject({ status: 200 });
      },
    );
  });

  it("truncates oversized text responses to maxChars", async () => {
    await withServer(
      (request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("x".repeat(5_000));
      },
      async (baseUrl) => {
        const tool = createWebFetchTool({ allowPrivateAddresses: true });
        const result = await tool.execute({ url: baseUrl, maxChars: 500 }, { cwd: "." });
        expect(result.content).toHaveLength(500);
        expect(result.metadata).toMatchObject({ truncated: true });
      },
    );
  });

  it("rejects non-http URLs and URLs with embedded credentials", async () => {
    const tool = createWebFetchTool();
    const file = await tool.execute({ url: "file:///etc/passwd" }, { cwd: "." });
    expect(file.isError).toBe(true);
    expect(file.content).toContain("Unsupported protocol");
    const creds = await tool.execute({ url: "http://user:pass@example.com/" }, { cwd: "." });
    expect(creds.isError).toBe(true);
    expect(creds.content).toContain("credentials");
    const invalid = await tool.execute({ url: "not a url" }, { cwd: "." });
    expect(invalid.isError).toBe(true);
  });

  it("returns isError on timeout instead of throwing", async () => {
    await withServer(
      () => {
        // Never respond.
      },
      async (baseUrl) => {
        const tool = createWebFetchTool({ timeoutMs: 300, allowPrivateAddresses: true });
        const result = await tool.execute({ url: baseUrl }, { cwd: "." });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("timed out");
      },
    );
  });
});

describe("htmlToText", () => {
  it("strips tags and decodes the supported entities", () => {
    expect(htmlToText(`<p>a &lt;b&gt; &quot;c&quot; &#39;d&#39; &nbsp; e&amp;f</p>`)).toBe(
      `a <b> "c" 'd' e&f`,
    );
  });
});

describe("web_search", () => {
  it("uses a custom JSON search endpoint", async () => {
    let queried = "";
    await withServer(
      (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        queried = url.searchParams.get("q") ?? "";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            { title: "Result one", url: "https://example.com/1", snippet: "first" },
            { title: "Result two", url: "https://example.com/2" },
          ]),
        );
      },
      async (baseUrl) => {
        const tool = createWebSearchTool({ endpoint: `${baseUrl}/search` });
        const result = await tool.execute({ query: "focuscode" }, { cwd: "." });
        expect(result.isError).toBeUndefined();
        expect(queried).toBe("focuscode");
        expect(result.content).toContain("1. Result one");
        expect(result.content).toContain("https://example.com/1");
        expect(result.content).toContain("first");
        expect(result.content).toContain("2. Result two");
      },
    );
  });

  it("parses DuckDuckGo lite HTML with the result-link parser and falls back to anchors", () => {
    const html =
      `<html><body><table>` +
      `<tr><td><a rel="nofollow" href="https://example.com/a" class='result-link'>Title A</a></td></tr>` +
      `<tr><td class='result-snippet'>Snippet A</td></tr>` +
      `<tr><td><a href="https://example.com/b" class='result-link'>Title B</a></td></tr>` +
      `</table></body></html>`;
    const results = parseSearchResults(html, 10);
    expect(results).toEqual([
      { title: "Title A", url: "https://example.com/a", snippet: "Snippet A" },
      { title: "Title B", url: "https://example.com/b" },
    ]);
    const fallback = parseSearchResults(`<a href="https://example.com/x">Just a link</a>`, 10);
    expect(fallback).toEqual([{ title: "Just a link", url: "https://example.com/x" }]);
  });

  it("returns isError when the endpoint fails", async () => {
    const tool = createWebSearchTool({
      endpoint: "http://127.0.0.1:1/unreachable",
      timeoutMs: 500,
    });
    const result = await tool.execute({ query: "anything" }, { cwd: "." });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("web_search failed");
  });
});
