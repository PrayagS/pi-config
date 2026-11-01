import { firecrawlPageError, scrapeFirecrawl } from "../../providers/firecrawl"
import type { Extractor } from "./types"

export const firecrawl: Extractor = {
  name: "firecrawl",
  async extract(url, signal, options) {
    const formats = options?.rawHtml ? ["rawHtml"] : ["markdown"]
    const json = await scrapeFirecrawl({ url, formats }, signal)
    if (!json) return null

    const data = json?.data
    const meta = data?.metadata
    const pageError = firecrawlPageError(meta)
    if (pageError) throw new Error(pageError)
    const metadata: Record<string, unknown> = {}
    if (meta?.title) metadata.title = meta.title
    if (meta?.cacheState) metadata.cacheState = meta.cacheState
    if (meta?.cachedAt) metadata.cachedAt = meta.cachedAt

    if (options?.rawHtml) {
      const html = data?.rawHtml
      if (typeof html !== "string" || !html.trim()) throw new Error("no rawHtml in response")
      return { markdown: "", html: html.trim(), metadata }
    }

    const markdown = data?.markdown
    if (typeof markdown !== "string" || !markdown.trim()) throw new Error("no markdown in response")
    return { markdown: markdown.trim(), metadata }
  },
}
