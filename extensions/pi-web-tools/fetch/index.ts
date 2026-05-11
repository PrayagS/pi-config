import { Type } from "@sinclair/typebox"
import { domainHandlers } from "./domain-handlers"
import { fetchAndExtract } from "./pipeline"
import { renderCall, renderResult } from "./render"
import { truncateToTemp } from "./truncate"

export const webFetchTool = {
  name: "web_fetch" as const,
  label: "Web Fetch",
  description:
    "Fetch a URL and return clean, readable content as Markdown. Prefers markdown via content negotiation; falls back to Defuddle for HTML. Output is truncated to agent limits. If truncated, full output is saved to a temp file — use the read tool to page through it.",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch" }),
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
      const result = await fetchAndExtract(params.url)
      const header = [
        result.title && `# ${result.title}`,
        result.byline && `*${result.byline}*`,
        `Source: ${result.url}`,
      ]
        .filter(Boolean)
        .join("\n")
      const fullText = `${header}\n\n---\n\n${result.content}`

      const { text, details } = await truncateToTemp(fullText, result.url, {
        title: result.title,
        stage: result.stage,
      })

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
