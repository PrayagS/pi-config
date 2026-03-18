/**
 * Fetch URL Extension
 *
 * Provides a `fetch_url` tool that fetches a URL and returns clean,
 * readable Markdown content via Mozilla Readability + Turndown.
 *
 * Extracted from pi-surf (https://github.com/iaptsiauri/pi-surf).
 *
 * Supports:
 *   - CSS selector narrowing
 *   - Max length limiting
 *   - Optional link preservation (stripped by default to save tokens)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Core fetch + extract ──────────────────────────────────────────

async function fetchAndExtract(
  url: string,
  opts: { selector?: string; maxLength?: number; includeLinks?: boolean },
): Promise<{ title: string; content: string; byline: string; length: number; url: string }> {
  const { Readability } = await import("@mozilla/readability");
  const { JSDOM } = await import("jsdom");
  const TurndownService = (await import("turndown")).default;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

  if (!contentType.includes("html")) {
    const raw = await response.text();
    const maxLen = opts.maxLength ?? 15_000;
    return { title: url, content: raw.slice(0, maxLen), byline: "", length: raw.length, url };
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });

  if (opts.selector) {
    const selected = dom.window.document.querySelector(opts.selector);
    if (selected) {
      dom.window.document.body.innerHTML = selected.outerHTML;
    }
  }

  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) {
    throw new Error("Readability could not extract content from this page");
  }

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  td.addRule("removeImages", { filter: "img", replacement: () => "" });

  if (!opts.includeLinks) {
    td.addRule("stripLinks", {
      filter: "a",
      replacement: (_content: string, node: any) => node.textContent || "",
    });
  }

  let markdown = td.turndown(article.content);

  markdown = markdown
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    .replace(/^.*(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim, "")
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim();

  const maxLen = opts.maxLength ?? 15_000;
  if (markdown.length > maxLen) {
    markdown = markdown.slice(0, maxLen) + "\n\n[... truncated]";
  }

  return {
    title: article.title || "",
    content: markdown,
    byline: article.byline || "",
    length: article.length || markdown.length,
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
      "Uses Mozilla Readability to strip navigation, ads, and boilerplate.",
      "Use `selector` to extract a specific section (CSS selector).",
      "Use `maxLength` to limit output size (default: 15000 chars).",
      "Set `includeLinks: true` to preserve hyperlinks (stripped by default to save tokens).",
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to narrow extraction (e.g. 'main', '.docs-content', '#api-reference')",
        }),
      ),
      maxLength: Type.Optional(
        Type.Number({ description: "Max characters to return. Default: 15000" }),
      ),
      includeLinks: Type.Optional(
        Type.Boolean({ description: "Keep hyperlinks in output. Default: false (saves tokens)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal) {
      try {
        const result = await fetchAndExtract(params.url, {
          selector: params.selector,
          maxLength: params.maxLength,
          includeLinks: params.includeLinks,
        });

        const header = [
          result.title && `# ${result.title}`,
          result.byline && `*${result.byline}*`,
          `Source: ${result.url}`,
          `Extracted: ${result.content.length} chars from ${result.length} original`,
        ]
          .filter(Boolean)
          .join("\n");

        const text = `${header}\n\n---\n\n${result.content}`;

        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let output = truncation.content;
        if (truncation.truncated) {
          output += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}]`;
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            url: result.url,
            title: result.title,
            extractedLength: result.content.length,
            originalLength: result.length,
            selector: params.selector,
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
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      let text = theme.fg("success", "✓ ");
      if (details?.title) text += theme.fg("toolTitle", details.title) + " ";
      text += theme.fg("muted", `(${details?.extractedLength ?? "?"} chars`);
      if (details?.selector) text += theme.fg("muted", `, selector: ${details.selector}`);
      text += theme.fg("muted", ")");

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
