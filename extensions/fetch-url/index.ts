/**
 * Fetch URL Extension
 *
 * Provides a `fetch_url` tool that fetches a URL and returns clean,
 * readable Markdown content.
 *
 * Extraction priority:
 *   1. Domain-specific handlers (GitHub, HN, Reddit)
 *   2. Markdown via content negotiation (if server supports it)
 *   3. Jina AI Reader API (URL → Markdown, requires PI_WEB_FETCH_JINA_API_KEY)
 *   4. Firecrawl scrape API (URL → Markdown, requires PI_WEB_FETCH_FIRECRAWL_API_KEY)
 *   5. markdown.new proxy (URL → Markdown service)
 *   6. Defuddle (default for HTML)
 *
 * Supports:
 *   - Truncation with temp file for large pages (agent uses `read` to page)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { domainHandlers } from "./domain-handlers"
import { fetchAndExtract } from "./fetch"
import { truncateToTemp } from "./truncate"
import { renderCall, renderResult } from "./render"

export default function fetchUrlExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: [
      "Fetch a URL and return clean, readable content as Markdown.",
      "Prefers markdown via content negotiation; falls back to Defuddle for HTML.",
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. If truncated, full output is saved to a temp file — use the read tool to page through it.`,
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),

    async execute(_toolCallId, params, signal) {
      // 1. Try domain-specific handlers
      for (const handler of domainHandlers) {
        const out = await handler(params.url, signal)
        if (out !== null) {
          const { text, details } = await truncateToTemp(out, params.url, {
            method: "domain-handler",
          })
          return {
            content: [{ type: "text" as const, text, source: "domain-handler" }],
            details,
          }
        }
      }

      // 2. Normal fetch pipeline
      try {
        const result = await fetchAndExtract(params.url)
        const header = [result.title && `# ${result.title}`, result.byline && `*${result.byline}*`, `Source: ${result.url}`]
          .filter(Boolean)
          .join("\n")
        const fullText = `${header}\n\n---\n\n${result.content}`

        const { text, details } = await truncateToTemp(fullText, result.url, {
          title: result.title,
          stage: result.stage,
        })

        return {
          content: [{ type: "text" as const, text, source: result.stage, metadata: result.metadata }],
          details,
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to fetch ${params.url}: ${err.message}`, source: "error" }],
          details: { url: params.url, error: err.message },
          isError: true,
        }
      }
    },

    renderCall,
    renderResult,
  })
}
