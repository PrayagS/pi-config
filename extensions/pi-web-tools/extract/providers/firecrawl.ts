import { firecrawlPageError, scrapeFirecrawl } from "../../providers/firecrawl"
import type { WebExtractItem, WebExtractProviderParams } from "./types"
import { hasAny } from "./utils"

/** Firecrawl's `highlights` format accepts a query of at most 10,000 characters. */
const HIGHLIGHTS_QUERY_MAX_CHARS = 10_000

/**
 * summary mode: `summary` format. targeted mode: `highlights` format, which
 * returns page text selected for the prompt (+4 credits per page).
 */
export async function extractFirecrawl({
  urls,
  mode,
  prompt,
  pending,
  signal,
}: WebExtractProviderParams): Promise<Array<WebExtractItem | null> | null> {
  if (mode === "targeted" && !prompt) return null
  const format =
    mode === "summary"
      ? { type: "summary" }
      : { type: "highlights", query: (prompt ?? "").slice(0, HIGHLIGHTS_QUERY_MAX_CHARS) }
  const field = mode === "summary" ? "summary" : "highlights"

  const results = await Promise.all(
    urls.map(async (url, index): Promise<WebExtractItem | null> => {
      if (pending && !pending[index]) return null
      let json: any
      try {
        json = await scrapeFirecrawl({ url, formats: [format] }, signal)
      } catch (error) {
        return { url, error: error instanceof Error ? error.message : String(error) }
      }
      if (!json) return null
      const pageError = firecrawlPageError(json?.data?.metadata)
      if (pageError) return { url, error: pageError }
      const content = json?.data?.[field]
      if (typeof content !== "string" || !content.trim()) {
        return { url, error: `no ${field} in response` }
      }
      const metadata = json?.data?.metadata
      const title = metadata?.title
      return {
        url,
        title: typeof title === "string" ? title : undefined,
        content: content.trim(),
        source: "firecrawl" as const,
        metadata,
      }
    })
  )

  return hasAny(results) ? results : null
}
