import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const firecrawl: Extractor = {
  name: "firecrawl",
  async extract(url, signal, options) {
    const apiKey = process.env.PI_WEB_FETCH_FIRECRAWL_API_KEY
    if (!apiKey) return null
    try {
      const formats = options?.rawHtml ? ["rawHtml"] : ["markdown"]
      const res = await fetchWithTimeout(
        "https://api.firecrawl.dev/v2/scrape",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url, formats }),
          signal,
        }
      )
      if (!res.ok) return null
      const json = await res.json()
      const data = json?.data

      const meta = data?.metadata
      const metadata: Record<string, unknown> = {}
      if (meta?.title) metadata.title = meta.title
      if (meta?.cacheState) metadata.cacheState = meta.cacheState
      if (meta?.cachedAt) metadata.cachedAt = meta.cachedAt

      if (options?.rawHtml) {
        const html = data?.rawHtml
        if (typeof html !== "string") return null
        return { markdown: "", html: html.trim(), metadata }
      }

      const markdown = data?.markdown
      if (typeof markdown !== "string") return null
      return { markdown: markdown.trim(), metadata }
    } catch {
      return null
    }
  },
}
