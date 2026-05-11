import { Type } from "@sinclair/typebox"
import { domainHandlers } from "./domain-handlers"
import { fetchAndExtract, fetchRawHtml } from "./pipeline"
import { renderCall, renderResult } from "./render"
import { truncateToTemp } from "./truncate"

export const webFetchTool = {
  name: "web_fetch" as const,
  label: "Web Fetch",
  description:
    "Fetch a URL and return clean, readable content as Markdown. Prefers markdown via content negotiation; falls back to Defuddle for HTML. Output is truncated to agent limits. If truncated, full output is saved to a temp file — use the read tool to page through it.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch" }),
    rawHtml: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Return raw HTML instead of Markdown. Uses jina → firecrawl (rawHtml) → you (html) → Defuddle (HTML). Default: false.",
      })
    ),
  }),

  async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
    // Try domain handlers first
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

    // Normal fetch pipeline
    try {
      const rawHtml = params.rawHtml === true
      const result = rawHtml
        ? await fetchRawHtml(params.url)
        : await fetchAndExtract(params.url)

      let fullText: string
      if (rawHtml) {
        fullText = result.content
      } else {
        const header = [
          result.title && `# ${result.title}`,
          result.byline && `*${result.byline}*`,
          `Source: ${result.url}`,
        ]
          .filter(Boolean)
          .join("\n")
        fullText = `${header}\n\n---\n\n${result.content}`
      }

      const { text, details } = await truncateToTemp(
        fullText,
        result.url,
        {
          title: result.title,
          stage: result.stage,
        },
        rawHtml ? "html" : "md"
      )

      return {
        content: [
          {
            type: "text" as const,
            text,
            source: result.stage,
            metadata: result.metadata,
          },
        ],
        details,
      }
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to fetch ${params.url}: ${err.message}`,
            source: "error",
          },
        ],
        details: { url: params.url, error: err.message },
        isError: true,
      }
    }
  },

  renderCall,
  renderResult,
}
