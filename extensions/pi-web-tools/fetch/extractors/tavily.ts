import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const tavily: Extractor = {
  name: "tavily",
  async extract(url) {
    const apiKey = process.env.PI_WEB_FETCH_TAVILY_API_KEY
    if (!apiKey) return null
    try {
      const res = await fetchWithTimeout(
        "https://api.tavily.com/extract",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ urls: [url], extract_depth: "advanced" }),
        },
        30_000
      )
      if (!res.ok) return null
      const json = await res.json()

      // Treat non-empty failed_results as failure
      if (json?.failed_results != null) return null

      const content = json?.results?.[0]?.raw_content
      if (typeof content !== "string") return null
      return { markdown: content.trim() }
    } catch {
      return null
    }
  },
}
