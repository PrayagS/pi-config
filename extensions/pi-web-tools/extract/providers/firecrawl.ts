import { scrapeFirecrawl } from "../../providers/firecrawl"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { hasAny } from "./utils"

export async function extractFirecrawlSummary({
  urls,
  mode,
  pending,
  signal,
}: WebExtractProviderParams): Promise<Array<WebExtractItem | null> | null> {
  if (mode !== "summary") return null

  const results = await Promise.all(
    urls.map(async (url, index): Promise<WebExtractItem | null> => {
      if (pending && !pending[index]) return null
      let json: any
      try {
        json = await scrapeFirecrawl({ url, formats: [{ type: "summary" }] }, signal)
      } catch (error) {
        return { url, error: error instanceof Error ? error.message : String(error) }
      }
      if (!json) return null
      const summary = json?.data?.summary
      if (typeof summary !== "string" || !summary.trim()) {
        return { url, error: "no summary in response" }
      }
      const metadata = json?.data?.metadata
      const title = metadata?.title
      return {
        url,
        title: typeof title === "string" ? title : undefined,
        content: summary.trim(),
        source: "firecrawl" as const,
        metadata,
      }
    })
  )

  return hasAny(results) ? results : null
}
