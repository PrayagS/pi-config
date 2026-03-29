/**
 * Fetch URL Extension
 *
 * Provides a `fetch_url` tool that fetches a URL and returns clean,
 * readable Markdown content.
 *
 * Extraction priority:
 *   1. Markdown via content negotiation (if server supports it)
 *   2. Readability + Turndown (default for HTML)
 *   3. Raw HTML tag-stripping + Turndown (via `rawHtml: true` fallback)
 *
 * Supports:
 *   - CSS selector narrowing
 *   - Truncation with temp file for large pages (agent uses `read` to page)
 *   - Optional link preservation (stripped by default to save tokens)
 *   - Optional Readability bypass for pages where it fails
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Core fetch + extract ──────────────────────────────────────────

interface FetchOpts {
  selector?: string;
  includeLinks?: boolean;
  rawHtml?: boolean;
}

interface FetchResult {
  title: string;
  content: string;
  byline: string;
  length: number;
  url: string;
}

async function fetchAndExtract(url: string, opts: FetchOpts): Promise<FetchResult> {
  const { Readability } = await import("@mozilla/readability");
  const { JSDOM } = await import("jsdom");
  const TurndownService = (await import("turndown")).default;
  const { gfm } = await import("turndown-plugin-gfm");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/xml;q=0.8, */*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // If the server returned markdown directly (content negotiation), use it as-is
  if (contentType.includes("markdown") || (!contentType.includes("html") && !contentType.includes("xml"))) {
    const raw = await response.text();
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    return { title: titleMatch?.[1] || url, content: raw, byline: "", length: raw.length, url };
  }

  // HTML path
  const html = await response.text();
  const dom = new JSDOM(html, { url });

  if (opts.selector) {
    const selected = dom.window.document.querySelector(opts.selector);
    if (selected) {
      dom.window.document.body.innerHTML = selected.outerHTML;
    }
  }

  let articleHtml: string;
  let title: string;
  let byline = "";
  let originalLength = 0;

  if (opts.rawHtml) {
    // Fallback: strip non-content tags, convert body directly
    const doc = dom.window.document;
    for (const tag of ["script", "style", "nav", "footer", "header", "noscript"]) {
      doc.querySelectorAll(tag).forEach((el: any) => el.remove());
    }
    articleHtml = doc.body?.innerHTML || "";
    title = doc.title || "";
  } else {
    // Primary: Readability extraction
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) {
      throw new Error("Readability could not extract content from this page. Retry with rawHtml: true to skip Readability.");
    }
    articleHtml = article.content;
    title = article.title || "";
    byline = article.byline || "";
    originalLength = article.length || 0;
  }

  if (!articleHtml.trim()) {
    throw new Error("Could not extract content from this page");
  }

  // Clean HTML before Turndown conversion.
  // Many doc sites (Mintlify, Docusaurus, etc.) nest <div><a>​</a></div> inside
  // headings for anchor links. This breaks Turndown's heading detection since
  // <div> is a block element inside an inline context.
  articleHtml = articleHtml
    .replace(/<div[^>]*>\s*<a[^>]*href="#[^"]*"[^>]*>[\s\u200B]*<\/a>\s*<\/div>/gi, "");

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.use(gfm);

  td.addRule("removeImages", { filter: "img", replacement: () => "" });

  if (!opts.includeLinks) {
    td.addRule("stripLinks", {
      filter: "a",
      replacement: (_content: string, node: any) => node.textContent || "",
    });
  }

  const markdown = td.turndown(articleHtml)
    .replace(/\u200B/g, "")
    .replace(/\u200C/g, "")
    .replace(/\u200D/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    .replace(/^.*(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim, "")
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim();

  return {
    title,
    content: markdown,
    byline,
    length: originalLength || markdown.length,
    url,
  };
}

// ─── Extension entry point ─────────────────────────────────────────

export default function fetchUrlExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: [
      "Fetch a URL and return clean, readable content as Markdown.",
      "Prefers markdown via content negotiation; falls back to Readability + Turndown for HTML.",
      "Use `selector` to extract a specific section (CSS selector).",
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. If truncated, full output is saved to a temp file — use the read tool to page through it.`,
      "Set `includeLinks: true` to preserve hyperlinks (stripped by default to save tokens).",
      "Set `rawHtml: true` to skip Readability and convert raw HTML (useful when Readability fails or returns bad output).",
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to narrow extraction (e.g. 'main', '.docs-content', '#api-reference')",
        }),
      ),
      includeLinks: Type.Optional(
        Type.Boolean({ description: "Keep hyperlinks in output. Default: false (saves tokens)" }),
      ),
      rawHtml: Type.Optional(
        Type.Boolean({ description: "Skip Readability, strip tags and convert raw HTML. Use when Readability output looks wrong." }),
      ),
    }),

    async execute(_toolCallId, params, _signal) {
      try {
        const result = await fetchAndExtract(params.url, {
          selector: params.selector,
          includeLinks: params.includeLinks,
          rawHtml: params.rawHtml,
        });
        const header = [
          result.title && `# ${result.title}`,
          result.byline && `*${result.byline}*`,
          `Source: ${result.url}`,
        ]
          .filter(Boolean)
          .join("\n");
        const fullText = `${header}\n\n---\n\n${result.content}`;

        const truncation = truncateHead(fullText, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let output = truncation.content;

        if (truncation.truncated) {
          // Save full output to temp file so agent can page through with `read`
          const tempDir = await mkdtemp(join(tmpdir(), "pi-fetch-url-"));
          const tempFile = join(tempDir, "output.md");
          await withFileMutationQueue(tempFile, async () => {
            await writeFile(tempFile, fullText, "utf8");
          });

          output += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
          output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
          output += ` Full output saved to: ${tempFile}]`;

          return {
            content: [{ type: "text" as const, text: output }],
            details: {
              url: result.url,
              title: result.title,
              truncated: true,
              totalLines: truncation.totalLines,
              fullOutputPath: tempFile,
              selector: params.selector,
              rawHtml: params.rawHtml,
            },
          };
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            url: result.url,
            title: result.title,
            totalLines: truncation.totalLines,
            selector: params.selector,
            rawHtml: params.rawHtml,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to fetch ${params.url}: ${err.message}` }],
          details: { url: params.url, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fetch_url "));
      text += theme.fg("accent", args.url || "...");
      if (args.selector) text += theme.fg("muted", ` → ${args.selector}`);
      if (args.rawHtml) text += theme.fg("muted", ` [raw]`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }
      let text = theme.fg("success", "✓ ");
      if (details?.title) text += theme.fg("toolTitle", details.title) + " ";
      text += theme.fg("muted", `(${details?.totalLines ?? "?"} lines`);
      if (details?.truncated) text += theme.fg("warning", ", truncated");
      if (details?.selector) text += theme.fg("muted", `, selector: ${details.selector}`);
      if (details?.rawHtml) text += theme.fg("muted", `, raw`);
      text += theme.fg("muted", ")");
      if (details?.fullOutputPath) {
        text += "\n" + theme.fg("muted", `Full output: ${details.fullOutputPath}`);
      }
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          text += "\n\n" + theme.fg("toolOutput", content.text.slice(0, 2000));
          if (content.text.length > 2000) text += theme.fg("muted", "\n... (truncated in preview)");
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
