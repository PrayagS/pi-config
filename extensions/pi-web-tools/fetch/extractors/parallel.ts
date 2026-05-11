import { fetchWithTimeout } from "./http"
import type { Extractor } from "./types"

export const parallel: Extractor = {
  name: "parallel",
  async extract(url) {
    const apiKey = process.env.PI_WEB_FETCH_PARALLEL_API_KEY
    if (!apiKey) return null
    try {
      const res = await fetchWithTimeout(
        "https://api.parallel.ai/v1/extract",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            urls: [url],
            advanced_settings: { full_content: true },
          }),
        },
        30_000
      )
      if (!res.ok) return null
      const json = await res.json()
      const result = json?.results?.[0]
      const markdown =
        result?.full_content ||
        (Array.isArray(result?.excerpts) ? result.excerpts.join("\n\n") : null)
      if (typeof markdown !== "string") return null
      return { markdown: markdown.trim(), title: result?.title }
    } catch {
      return null
    }
  },
}
